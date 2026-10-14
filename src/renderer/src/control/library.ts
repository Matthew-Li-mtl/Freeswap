// Library actions: importing, folders, removing, re-analysing.

import { api } from '../platform'
import { folderPath, getTrack, setMembership, upsertTracks, useLibrary, type View } from '../state/library'
import { useDecks } from '../state/decks'
import { toast } from '../state/ui'
import { analysisQueue } from '../library/analysisQueue'
import { importPaths } from '../ui/dnd'
import { askChoice } from '../ui/ChoiceDialog'

export function currentFolder(): number | null {
  const v = useLibrary.getState().view
  return v === 'collection' ? null : v
}

/**
 * Where should new music go? If a folder is selected in the library, ask whether to put it
 * there or at the top level. Returns the folder id, null for the top level, or 'cancel'.
 */
export async function chooseImportTarget(what = 'the imported music'): Promise<number | null | 'cancel'> {
  const folderId = currentFolder()
  if (folderId == null) return null
  const name = folderPath(folderId)
    .map((f) => f.name)
    .join(' › ')
  const choice = await askChoice({
    title: 'Where should it go?',
    message: `The folder "${name}" is selected in your library.\nPut ${what} inside it, or at the top level of your folders?`,
    choices: [
      { id: 'top', label: 'TOP LEVEL' },
      { id: 'folder', label: `INTO "${name.toUpperCase()}"`, primary: true }
    ]
  })
  if (choice == null) return 'cancel'
  return choice === 'folder' ? folderId : null
}

export async function pickAndImport(kind: 'files' | 'folder'): Promise<void> {
  const paths = await api.library.pickPaths(kind)
  if (!paths.length) return
  const target = await chooseImportTarget()
  if (target === 'cancel') return
  await importPaths(paths, target)
}

/** Files dropped onto the track list: same question as the import buttons. */
export async function importDropped(paths: string[]): Promise<void> {
  if (!paths.length) return
  const target = await chooseImportTarget()
  if (target === 'cancel') return
  await importPaths(paths, target)
}

export { importPaths }

export function setView(view: View): void {
  useLibrary.setState({ view, selection: [], anchor: null })
}

export async function createFolder(parentId: number | null, name = 'New folder'): Promise<number> {
  const f = await api.folders.create(parentId, name)
  useLibrary.setState((s) => ({
    folders: [...s.folders, f],
    expanded: parentId != null ? { ...s.expanded, [parentId]: true } : s.expanded
  }))
  return f.id
}

export async function renameFolder(id: number, name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) return
  await api.folders.rename(id, clean)
  useLibrary.setState((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) }))
}

export async function deleteFolder(id: number): Promise<void> {
  await api.folders.remove(id)
  // Deleting cascades to sub-folders in the database; reload the tree to match.
  const snap = await api.library.getSnapshot()
  useLibrary.setState((s) => ({
    folders: snap.folders,
    membership: snap.membership,
    view: s.view === id || !snap.folders.some((f) => f.id === s.view) ? 'collection' : s.view
  }))
}

export async function moveFolder(id: number, parentId: number | null, position: number): Promise<void> {
  try {
    const folders = await api.folders.move(id, parentId, position)
    useLibrary.setState((s) => ({
      folders,
      expanded: parentId != null ? { ...s.expanded, [parentId]: true } : s.expanded
    }))
  } catch (err) {
    toast((err as Error).message, 'error')
  }
}

export async function addToFolder(folderId: number, ids: number[]): Promise<void> {
  setMembership(folderId, await api.folders.addTracks(folderId, ids))
}

export async function removeFromFolder(folderId: number, ids: number[]): Promise<void> {
  setMembership(folderId, await api.folders.removeTracks(folderId, ids))
  useLibrary.setState({ selection: [] })
}

/** Move = add to the destination and remove from where they were dragged from. */
export async function moveTracks(from: number, to: number, ids: number[]): Promise<void> {
  if (from === to) return
  await addToFolder(to, ids)
  await removeFromFolder(from, ids)
}

export async function reorderInFolder(folderId: number, ids: number[], beforeId: number | null): Promise<void> {
  const cur = useLibrary.getState().membership[folderId] ?? []
  const moving = new Set(ids)
  const rest = cur.filter((id) => !moving.has(id))
  const at = beforeId != null ? rest.indexOf(beforeId) : rest.length
  rest.splice(at < 0 ? rest.length : at, 0, ...ids.filter((id) => cur.includes(id)))
  setMembership(folderId, await api.folders.reorderTracks(folderId, rest))
}

export async function removeFromLibrary(ids: number[]): Promise<void> {
  const loaded = useDecks.getState().decks.map((d) => d.trackId)
  const safe = ids.filter((id) => !loaded.includes(id))
  if (safe.length < ids.length) toast('Tracks loaded on a deck were kept')
  if (!safe.length) return
  await api.library.removeTracks(safe)
  useLibrary.setState((s) => {
    const tracks = { ...s.tracks }
    for (const id of safe) delete tracks[id]
    const membership: Record<number, number[]> = {}
    for (const [k, v] of Object.entries(s.membership)) membership[Number(k)] = v.filter((id) => !safe.includes(id))
    return { tracks, membership, selection: [] }
  })
}

export async function reanalyzeTracks(ids: number[]): Promise<void> {
  for (const id of ids) {
    const t = await api.library.updateTrack(id, { grid: null, key: null })
    upsertTracks([t])
  }
  analysisQueue.enqueue(ids, true)
}

export async function relocate(id: number): Promise<void> {
  const t = await api.library.relocateTrack(id)
  if (t) {
    upsertTracks([t])
    toast(`Found "${t.title}"`)
  }
}

export async function downloadYouTube(url: string): Promise<void> {
  const clean = url.trim()
  if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(clean)) {
    toast("That doesn't look like a YouTube link", 'error')
    return
  }
  const target = await chooseImportTarget('the download')
  if (target === 'cancel') return
  await api.youtube.download(clean, target)
  toast('Added to the download queue')
}

export function isMissing(id: number): boolean {
  const t = getTrack(id)
  return !!t && !t.available
}
