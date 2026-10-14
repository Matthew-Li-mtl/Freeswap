// Library state: every track, the folder tree, and what the browser is showing.

import { create } from 'zustand'
import type { DownloadJob, Folder, ImportProgress, Track } from '@shared/types'
import { formatKey, camelotName, musicalName } from '@shared/musicKey'
import { api } from '../platform'

export type SortKey =
  'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'album' | 'genre' | 'addedAt' | 'source' | 'order'

export type View = 'collection' | number // number = folder id

interface LibraryStore {
  tracks: Record<number, Track>
  folders: Folder[]
  membership: Record<number, number[]>
  view: View
  search: string
  sort: { key: SortKey; dir: 1 | -1 }
  selection: number[]
  anchor: number | null // last clicked row (for shift-click ranges)
  expanded: Record<number, boolean>
  importing: ImportProgress | null
  analysisQueue: number
  downloads: DownloadJob[]
  /** Folders to flash briefly (e.g. just imported). */
  highlight: number[]
}

export const useLibrary = create<LibraryStore>(() => ({
  tracks: {},
  folders: [],
  membership: {},
  view: 'collection',
  search: '',
  sort: { key: 'addedAt', dir: -1 },
  selection: [],
  anchor: null,
  expanded: {},
  importing: null,
  analysisQueue: 0,
  downloads: [],
  highlight: []
}))

export function getTrack(id: number): Track | undefined {
  return useLibrary.getState().tracks[id]
}

export async function loadLibrary(): Promise<void> {
  const snap = await api.library.getSnapshot()
  const tracks: Record<number, Track> = {}
  for (const t of snap.tracks) tracks[t.id] = t
  useLibrary.setState({ tracks, folders: snap.folders, membership: snap.membership })
}

let highlightTimer = 0

/**
 * Briefly flash folders in the tree (after an import). Their parent folders are expanded
 * so they're visible, but the folders themselves stay collapsed.
 */
export function highlightFolders(ids: number[]): void {
  if (!ids.length) return
  const expanded = { ...useLibrary.getState().expanded }
  for (const id of ids) for (const f of folderPath(id).slice(0, -1)) expanded[f.id] = true
  useLibrary.setState({ highlight: ids, expanded })
  clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => useLibrary.setState({ highlight: [] }), 4000)
}

/** Re-read the folder tree and folder contents (after imports create folders). */
export async function reloadFolders(): Promise<void> {
  const snap = await api.library.getSnapshot()
  useLibrary.setState({ folders: snap.folders, membership: snap.membership })
}

export function upsertTracks(list: Track[]): void {
  if (!list.length) return
  useLibrary.setState((s) => {
    const tracks = { ...s.tracks }
    for (const t of list) tracks[t.id] = t
    return { tracks }
  })
}

export function setMembership(folderId: number, ids: number[]): void {
  useLibrary.setState((s) => ({ membership: { ...s.membership, [folderId]: ids } }))
}

/** Folder ids from the root down to `id` (for breadcrumbs / expanding). */
export function folderPath(id: number): Folder[] {
  const byId = new Map(useLibrary.getState().folders.map((f) => [f.id, f]))
  const out: Folder[] = []
  let f = byId.get(id)
  while (f) {
    out.unshift(f)
    f = f.parentId != null ? byId.get(f.parentId) : undefined
  }
  return out
}

// ----------------------------- search & sort -----------------------------

/**
 * Every word you type must match somewhere (title, artist, album, genre, comment,
 * key in either notation, or BPM). "bpm:120-128" filters by a tempo range.
 */
export function filterTracks(tracks: Track[], query: string): Track[] {
  const q = query.trim().toLowerCase()
  if (!q) return tracks
  const tokens = q.split(/\s+/)
  const ranges: [number, number][] = []
  const words: string[] = []
  for (const tok of tokens) {
    const m = /^bpm:(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(tok)
    if (m) ranges.push([Number(m[1]), Number(m[2] ?? m[1]) + (m[2] ? 0 : 0.999)])
    else words.push(tok)
  }
  return tracks.filter((t) => {
    for (const [lo, hi] of ranges) if (t.bpm == null || t.bpm < lo || t.bpm > hi) return false
    if (!words.length) return true
    const keyText = t.key != null ? `${camelotName(t.key)} ${musicalName(t.key)}`.toLowerCase() : ''
    const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.comment} ${keyText} ${
      t.bpm != null ? t.bpm.toFixed(2) : ''
    }`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export function sortTracks(tracks: Track[], key: SortKey, dir: 1 | -1, order?: number[]): Track[] {
  const out = [...tracks]
  if (key === 'order' && order) {
    const pos = new Map(order.map((id, i) => [id, i]))
    out.sort((a, b) => ((pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)) * dir)
    return out
  }
  const str = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  out.sort((a, b) => {
    let r = 0
    switch (key) {
      case 'title':
        r = str(a.title, b.title)
        break
      case 'artist':
        r = str(a.artist, b.artist) || str(a.title, b.title)
        break
      case 'album':
        r = str(a.album, b.album)
        break
      case 'genre':
        r = str(a.genre, b.genre)
        break
      case 'source':
        r = str(a.source, b.source)
        break
      case 'bpm':
        r = (a.bpm ?? -1) - (b.bpm ?? -1)
        break
      case 'key':
        r = str(
          a.key != null ? formatKey(a.key, 'camelot').padStart(3, '0') : '~',
          b.key != null ? formatKey(b.key, 'camelot').padStart(3, '0') : '~'
        )
        break
      case 'duration':
        r = a.duration - b.duration
        break
      case 'addedAt':
        r = a.addedAt - b.addedAt || a.id - b.id
        break
      default:
        r = 0
    }
    return r * dir
  })
  return out
}

/** Tracks currently listed in the browser (view + search + sort). */
export function visibleTracks(s: LibraryStore): Track[] {
  let list: Track[]
  if (s.view === 'collection') list = Object.values(s.tracks)
  else list = (s.membership[s.view] ?? []).map((id) => s.tracks[id]).filter(Boolean)
  const order = s.view === 'collection' ? undefined : s.membership[s.view]
  return sortTracks(filterTracks(list, s.search), s.sort.key, s.sort.dir, order)
}
