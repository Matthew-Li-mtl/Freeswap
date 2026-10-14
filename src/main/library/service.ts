// The library service: imports files, tracks where they live, and reports which tracks
// are currently playable (their drive is plugged in and the file still exists).

import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import { parseFile } from 'music-metadata'
import type { ImportProgress, ImportResult, LibrarySnapshot, Track, TrackSource } from '@shared/types'
import { parseKey } from '@shared/musicKey'
import type { LibraryRepository } from './repository'
import { locate, type VolumeWatcher } from './volumes'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.mp4',
  '.aac',
  '.webm',
  '.aif',
  '.aiff',
  '.wma',
  '.alac'
])

/** Formats Chromium can't decode by itself; these get transcoded by ffmpeg on the fly. */
export const NEEDS_TRANSCODE = new Set(['.aif', '.aiff', '.wma', '.alac'])

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules'])

export interface ImportOverrides {
  title?: string
  artist?: string
  source?: TrackSource
  sourceUrl?: string | null
  sourceId?: string | null
  artwork?: Buffer | null
}

export class LibraryService extends EventEmitter {
  constructor(
    private repo: LibraryRepository,
    private volumes: VolumeWatcher,
    private artworkDir: string
  ) {
    super()
    volumes.on('change', () => void this.refreshAvailability())
  }

  async init(): Promise<void> {
    await fs.mkdir(this.artworkDir, { recursive: true })
    await this.refreshAvailability()
  }

  snapshot(): LibrarySnapshot {
    return {
      tracks: this.repo.allTracks(),
      folders: this.repo.allFolders(),
      membership: this.repo.membership()
    }
  }

  /** Current absolute path of a track, or null if its drive isn't mounted. */
  pathFor(id: number): string | null {
    const t = this.repo.getTrack(id)
    return t && t.available ? t.path : null
  }

  artworkPath(id: number): string {
    return path.join(this.artworkDir, `${id}.jpg`)
  }

  /**
   * Re-resolve every track's absolute path from its volume serial + relative path,
   * then check the file exists. Emits the tracks whose path or availability changed.
   */
  async refreshAvailability(): Promise<void> {
    const changed: number[] = []
    const locs = this.repo.allLocations()
    await runPool(locs, 16, async (loc) => {
      const resolved = this.volumes.resolve(loc)
      let ok = false
      if (resolved) {
        try {
          await fs.access(resolved)
          ok = true
        } catch {
          ok = false
        }
        if (ok && resolved !== loc.path) {
          this.repo.setPath(loc.id, resolved)
          changed.push(loc.id)
        }
      }
      if (this.repo.setAvailable(loc.id, ok) && !changed.includes(loc.id)) changed.push(loc.id)
    })
    if (changed.length) {
      this.emit('tracksChanged', changed.map((id) => this.repo.getTrack(id)!).filter(Boolean))
    }
  }

  /**
   * Import files and folders.
   * - Files go into `folderId` (if given).
   * - Each folder becomes an in-app folder with the same name (inside `folderId`), and its
   *   sub-folders become nested in-app folders, mirroring the hierarchy on disk. Folders
   *   that already exist with the same name are reused, so re-importing doesn't duplicate.
   */
  async importPaths(
    inputs: string[],
    folderId: number | null,
    onProgress?: (p: ImportProgress) => void
  ): Promise<ImportResult> {
    // 1. Work out every audio file and which in-app folder it belongs in.
    const plan: { file: string; folder: number | null }[] = []
    const topFolders = new Set<number>()
    for (const p of inputs) {
      let st
      try {
        st = await fs.stat(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        const tree = await scanTree(p)
        if (tree) topFolders.add(this.planTree(tree, folderId, plan))
      } else if (AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase())) {
        plan.push({ file: path.resolve(p), folder: folderId })
        if (folderId != null) topFolders.add(folderId)
      }
    }
    // 2. Import (4 files at a time: reading tags is mostly waiting on the disk).
    const results = new Map<string, Track>()
    let done = 0
    await runPool(plan, 4, async (item) => {
      try {
        results.set(item.file, await this.importFile(item.file))
      } catch (err) {
        console.warn('Import failed for', item.file, err)
      }
      done++
      onProgress?.({ done, total: plan.length, current: path.basename(item.file) })
    })
    // 3. Put tracks into their folders, in the order they appear on disk.
    const byFolder = new Map<number, number[]>()
    for (const item of plan) {
      const t = results.get(item.file)
      if (t && item.folder != null) {
        const list = byFolder.get(item.folder) ?? []
        list.push(t.id)
        byFolder.set(item.folder, list)
      }
    }
    for (const [fid, ids] of byFolder) this.repo.addToFolder(fid, ids)
    return {
      tracks: plan.map((item) => results.get(item.file)).filter((t): t is Track => t != null),
      folders: [...topFolders]
    }
  }

  /** Create (or reuse) the in-app folder tree for a scanned directory; returns its root folder id. */
  private planTree(node: DirNode, parentId: number | null, plan: { file: string; folder: number | null }[]): number {
    const folder = this.repo.ensureFolder(parentId, node.name)
    for (const f of node.files) plan.push({ file: f, folder: folder.id })
    for (const child of node.children) this.planTree(child, folder.id, plan)
    return folder.id
  }

  /** Import one audio file. Returns the existing track if it's already in the library. */
  async importFile(file: string, overrides: ImportOverrides = {}): Promise<Track> {
    const abs = path.resolve(file)
    const st = await fs.stat(abs)
    const loc = await locate(abs)
    this.volumes.remember(loc.serial, abs)
    const existing = this.repo.findByLocation(loc.serial, loc.relPath)
    if (existing) return existing

    const meta = await readTags(abs)
    const tagKey = meta.key ? parseKey(meta.key) : null
    const track = this.repo.insertTrack({
      path: abs,
      serial: loc.serial,
      relPath: loc.relPath,
      fileSize: st.size,
      fileMtime: st.mtimeMs,
      title: overrides.title || meta.title,
      artist: overrides.artist || meta.artist,
      album: meta.album,
      genre: meta.genre,
      year: meta.year,
      comment: meta.comment,
      duration: meta.duration,
      source: overrides.source ?? 'local',
      sourceUrl: overrides.sourceUrl ?? null,
      sourceId: overrides.sourceId ?? null,
      tagBpm: meta.bpm && meta.bpm > 30 && meta.bpm < 300 ? meta.bpm : null,
      tagKey
    })
    const art = overrides.artwork ?? meta.picture
    if (art && (await this.writeArtwork(track.id, art))) {
      this.repo.setArtwork(track.id, true)
      return this.repo.getTrack(track.id)!
    }
    return track
  }

  /** The user points us at the new location of a missing file. */
  async relocate(id: number, newPath: string): Promise<Track> {
    const loc = await locate(newPath)
    this.volumes.remember(loc.serial, newPath)
    this.repo.setPath(id, newPath, loc.serial, loc.relPath)
    this.repo.setAvailable(id, true)
    return this.repo.getTrack(id)!
  }

  private async writeArtwork(id: number, data: Buffer): Promise<boolean> {
    try {
      let img = nativeImage.createFromBuffer(data)
      if (img.isEmpty()) return false
      const { width, height } = img.getSize()
      if (width > 256 || height > 256) {
        img =
          width >= height ? img.resize({ width: 256, quality: 'good' }) : img.resize({ height: 256, quality: 'good' })
      }
      await fs.writeFile(this.artworkPath(id), img.toJPEG(85))
      return true
    } catch {
      return false
    }
  }
}

interface Tags {
  title: string
  artist: string
  album: string
  genre: string
  year: number | null
  comment: string
  duration: number
  picture: Buffer | null
  bpm: number | null
  key: string | null
}

async function readTags(file: string): Promise<Tags> {
  const base = path.basename(file, path.extname(file))
  // Filenames like "Artist - Title" are common for files without tags.
  const dash = base.indexOf(' - ')
  const fallback =
    dash > 0 ? { artist: base.slice(0, dash).trim(), title: base.slice(dash + 3).trim() } : { artist: '', title: base }
  try {
    const m = await parseFile(file, { duration: false, skipCovers: false })
    const c = m.common
    const pic = c.picture?.[0]
    const comment = c.comment?.[0]
    return {
      title: c.title?.trim() || fallback.title,
      artist: c.artist?.trim() || (c.title ? '' : fallback.artist),
      album: c.album ?? '',
      genre: c.genre?.[0] ?? '',
      year: c.year ?? null,
      comment: typeof comment === 'string' ? comment : (comment?.text ?? ''),
      duration: m.format.duration ?? 0,
      picture: pic ? Buffer.from(pic.data) : null,
      bpm: typeof c.bpm === 'number' && isFinite(c.bpm) ? c.bpm : null,
      key: typeof c.key === 'string' ? c.key : null
    }
  } catch {
    return {
      ...fallback,
      album: '',
      genre: '',
      year: null,
      comment: '',
      duration: 0,
      picture: null,
      bpm: null,
      key: null
    }
  }
}

interface DirNode {
  name: string
  files: string[]
  children: DirNode[]
}

/** Walk a folder; returns its audio files and sub-folders, or null if it has no audio at all. */
async function scanTree(dir: string): Promise<DirNode | null> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const node: DirNode = { name: path.basename(dir) || dir, files: [], children: [] }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue
      const child = await scanTree(full)
      if (child) node.children.push(child)
    } else if (AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      node.files.push(path.resolve(full))
    }
  }
  return node.files.length || node.children.length ? node : null
}

/** Run `fn` over `items` with at most `limit` running at once. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}
