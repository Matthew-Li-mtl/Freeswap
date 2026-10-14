// Drag-and-drop helpers: dragging tracks inside the app, and dropping files from Explorer.

import type { Track } from '@shared/types'
import { api } from '../platform'
import { folderPath, highlightFolders, reloadFolders, upsertTracks, useLibrary } from '../state/library'
import { analysisQueue } from '../library/analysisQueue'
import { toast } from '../state/ui'

export const TRACKS_MIME = 'application/x-freeswap-tracks'
export const FOLDER_MIME = 'application/x-freeswap-folder'

export function setDragTracks(e: React.DragEvent, ids: number[]): void {
  e.dataTransfer.setData(TRACKS_MIME, JSON.stringify(ids))
  e.dataTransfer.effectAllowed = 'copyMove'
}

export function readDraggedTracks(e: React.DragEvent): number[] {
  const raw = e.dataTransfer.getData(TRACKS_MIME)
  if (!raw) return []
  try {
    return JSON.parse(raw) as number[]
  } catch {
    return []
  }
}

export function hasFiles(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

/**
 * Paths of files/folders dropped from the OS. Read them straight away inside the drop
 * handler: the browser empties the drag data once the event is over (e.g. after an await).
 */
export function droppedPaths(e: React.DragEvent): string[] {
  return [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
}

/** Import files/folders dropped from the OS into the library (and the given folder). */
export async function importDroppedFiles(e: React.DragEvent, folderId: number | null = null): Promise<Track[]> {
  const paths = droppedPaths(e)
  if (!paths.length) return []
  return importPaths(paths, folderId)
}

export async function importPaths(paths: string[], folderId: number | null): Promise<Track[]> {
  const { tracks, folders } = await api.library.importPaths(paths, folderId)
  useLibrary.setState({ importing: null })
  upsertTracks(tracks)
  await reloadFolders()
  highlightFolders(folders)
  analysisQueue.enqueue(tracks.filter((t) => !t.analyzed).map((t) => t.id))
  const where =
    folderId != null
      ? ` into "${folderPath(folderId)
          .map((f) => f.name)
          .join(' › ')}"`
      : ''
  if (tracks.length) toast(`Imported ${tracks.length} track${tracks.length === 1 ? '' : 's'}${where}`)
  else toast('No audio files found there')
  return tracks
}
