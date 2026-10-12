// The contract between the UI and "the platform" (file system, database, downloads).
// On the desktop this is implemented by the Electron main process and exposed through
// the preload script as `window.freeswap`. A future browser version would implement the
// same interface with IndexedDB / the File System Access API, so the UI never needs to
// know which one it is talking to.

import type {
  AnalysisResult,
  DownloadJob,
  Folder,
  ImportProgress,
  LibrarySnapshot,
  Settings,
  Track,
  TrackPatch
} from './types'

export type Unsubscribe = () => void

export interface FreeswapAPI {
  library: {
    getSnapshot(): Promise<LibrarySnapshot>
    importPaths(paths: string[], folderId: number | null): Promise<Track[]>
    pickAndImport(kind: 'files' | 'folder', folderId: number | null): Promise<Track[]>
    updateTrack(id: number, patch: TrackPatch): Promise<Track>
    removeTracks(ids: number[]): Promise<void>
    saveAnalysis(id: number, result: AnalysisResult): Promise<Track>
    getWaveform(id: number): Promise<Uint8Array | null>
    relocateTrack(id: number): Promise<Track | null>
    showInFolder(id: number): Promise<void>
    onTracksChanged(cb: (tracks: Track[]) => void): Unsubscribe
    onImportProgress(cb: (p: ImportProgress) => void): Unsubscribe
  }
  folders: {
    create(parentId: number | null, name: string): Promise<Folder>
    rename(id: number, name: string): Promise<void>
    remove(id: number): Promise<void>
    move(id: number, parentId: number | null, position: number): Promise<Folder[]>
    addTracks(folderId: number, trackIds: number[]): Promise<number[]>
    removeTracks(folderId: number, trackIds: number[]): Promise<number[]>
    reorderTracks(folderId: number, trackIds: number[]): Promise<number[]>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    pickFolder(current: string): Promise<string | null>
  }
  youtube: {
    download(url: string, folderId: number | null): Promise<void>
    onJobs(cb: (jobs: DownloadJob[]) => void): Unsubscribe
  }
  recording: {
    start(sampleRate: number, channels: number): Promise<string>
    write(chunk: ArrayBuffer): void
    stop(): Promise<string>
    reveal(path: string): Promise<void>
  }
  /** URL the renderer can fetch() to read a track's audio bytes. */
  trackUrl(id: number, transcode?: boolean): string
  artworkUrl(id: number): string
  /** Absolute path of a file dropped onto the window (desktop only). */
  pathForFile(file: File): string
}

/** IPC channel names, shared by main and preload so they can't drift apart. */
export const IPC = {
  librarySnapshot: 'library:snapshot',
  libraryImportPaths: 'library:importPaths',
  libraryPickImport: 'library:pickImport',
  libraryUpdateTrack: 'library:updateTrack',
  libraryRemoveTracks: 'library:removeTracks',
  librarySaveAnalysis: 'library:saveAnalysis',
  libraryGetWaveform: 'library:getWaveform',
  libraryRelocate: 'library:relocate',
  libraryShowInFolder: 'library:showInFolder',
  libraryTracksChanged: 'library:tracksChanged',
  libraryImportProgress: 'library:importProgress',
  folderCreate: 'folder:create',
  folderRename: 'folder:rename',
  folderRemove: 'folder:remove',
  folderMove: 'folder:move',
  folderAddTracks: 'folder:addTracks',
  folderRemoveTracks: 'folder:removeTracks',
  folderReorder: 'folder:reorder',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsPickFolder: 'settings:pickFolder',
  youtubeDownload: 'youtube:download',
  youtubeJobs: 'youtube:jobs',
  recordingStart: 'recording:start',
  recordingWrite: 'recording:write',
  recordingStop: 'recording:stop',
  recordingReveal: 'recording:reveal'
} as const

export const MEDIA_SCHEME = 'fsmedia'
