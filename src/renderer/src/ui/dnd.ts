// Drag-and-drop helpers: dragging tracks inside the app, and dropping files from Explorer.

import type { Track } from '@shared/types'
import { api } from '../platform'
import { upsertTracks, reloadFolders, useLibrary } from '../state/library'
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

/** Import files/folders dropped from the OS into the library (and the given folder). */
export async function importDroppedFiles(e: React.DragEvent, folderId: number | null = null): Promise<Track[]> {
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
  if (!paths.length) return []
  return importPaths(paths, folderId)
}

export async function importPaths(paths: string[], folderId: number | null): Promise<Track[]> {
  const tracks = await api.library.importPaths(paths, folderId)
  useLibrary.setState({ importing: null })
  upsertTracks(tracks)
  await reloadFolders()
  const fresh = tracks.filter((t) => !t.analyzed)
  analysisQueue.enqueue(fresh.map((t) => t.id))
  if (tracks.length) toast(`Imported ${tracks.length} track${tracks.length === 1 ? '' : 's'}`)
  else toast('No audio files found there')
  return tracks
}
