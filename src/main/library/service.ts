// The library service: imports files, tracks where they live, and reports which tracks
// are currently playable (their drive is plugged in and the file still exists).

import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import { parseFile } from 'music-metadata'
import type { ImportProgress, LibrarySnapshot, Track, TrackSource } from '@shared/types'
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

  /** Expand files/folders into audio files and import each one. */
  async importPaths(inputs: string[], onProgress?: (p: ImportProgress) => void): Promise<Track[]> {
    const files: string[] = []
    for (const p of inputs) await collectAudioFiles(p, files)
    const imported: Track[] = []
    let done = 0
    await runPool(files, 4, async (file) => {
      try {
        imported.push(await this.importFile(file))
      } catch (err) {
        console.warn('Import failed for', file, err)
      }
      done++
      onProgress?.({ done, total: files.length, current: path.basename(file) })
    })
    // Keep the original order the user selected.
    const order = new Map(files.map((f, i) => [f.toLowerCase(), i]))
    imported.sort((a, b) => (order.get(a.path.toLowerCase()) ?? 0) - (order.get(b.path.toLowerCase()) ?? 0))
    return imported
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
      sourceId: overrides.sourceId ?? null
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
      picture: pic ? Buffer.from(pic.data) : null
    }
  } catch {
    return { ...fallback, album: '', genre: '', year: null, comment: '', duration: 0, picture: null }
  }
}

async function collectAudioFiles(p: string, out: string[]): Promise<void> {
  let st
  try {
    st = await fs.stat(p)
  } catch {
    return
  }
  if (st.isFile()) {
    if (AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase())) out.push(path.resolve(p))
    return
  }
  if (!st.isDirectory()) return
  let entries
  try {
    entries = await fs.readdir(p, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(p, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) await collectAudioFiles(full, out)
    } else if (AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      out.push(full)
    }
  }
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
