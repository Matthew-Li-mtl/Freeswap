// The preload script runs in an isolated context with access to a few Electron APIs.
// It exposes a small, typed API (`window.freeswap`) to the page; the page itself has no
// Node.js access, which keeps a malicious file or URL from touching the system.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, MEDIA_SCHEME, type FreeswapAPI } from '@shared/api'

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: FreeswapAPI = {
  library: {
    getSnapshot: () => ipcRenderer.invoke(IPC.librarySnapshot),
    importPaths: (paths, folderId) => ipcRenderer.invoke(IPC.libraryImportPaths, paths, folderId),
    pickPaths: (kind) => ipcRenderer.invoke(IPC.libraryPickPaths, kind),
    updateTrack: (id, patch) => ipcRenderer.invoke(IPC.libraryUpdateTrack, id, patch),
    removeTracks: (ids) => ipcRenderer.invoke(IPC.libraryRemoveTracks, ids),
    saveAnalysis: (id, result) => ipcRenderer.invoke(IPC.librarySaveAnalysis, id, result),
    getWaveform: (id) => ipcRenderer.invoke(IPC.libraryGetWaveform, id),
    relocateTrack: (id) => ipcRenderer.invoke(IPC.libraryRelocate, id),
    showInFolder: (id) => ipcRenderer.invoke(IPC.libraryShowInFolder, id),
    onTracksChanged: (cb) => listen(IPC.libraryTracksChanged, cb),
    onImportProgress: (cb) => listen(IPC.libraryImportProgress, cb)
  },
  folders: {
    create: (parentId, name) => ipcRenderer.invoke(IPC.folderCreate, parentId, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.folderRename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.folderRemove, id),
    move: (id, parentId, position) => ipcRenderer.invoke(IPC.folderMove, id, parentId, position),
    addTracks: (folderId, ids) => ipcRenderer.invoke(IPC.folderAddTracks, folderId, ids),
    removeTracks: (folderId, ids) => ipcRenderer.invoke(IPC.folderRemoveTracks, folderId, ids),
    reorderTracks: (folderId, ids) => ipcRenderer.invoke(IPC.folderReorder, folderId, ids)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    pickFolder: (current) => ipcRenderer.invoke(IPC.settingsPickFolder, current)
  },
  youtube: {
    download: (url, folderId) => ipcRenderer.invoke(IPC.youtubeDownload, url, folderId),
    onJobs: (cb) => listen(IPC.youtubeJobs, cb)
  },
  recording: {
    start: (sampleRate, channels) => ipcRenderer.invoke(IPC.recordingStart, sampleRate, channels),
    write: (chunk) => ipcRenderer.send(IPC.recordingWrite, chunk),
    stop: () => ipcRenderer.invoke(IPC.recordingStop),
    reveal: (p) => ipcRenderer.invoke(IPC.recordingReveal, p)
  },
  trackUrl: (id, transcode) => `${MEDIA_SCHEME}://track/${id}${transcode ? '?transcode' : ''}`,
  artworkUrl: (id) => `${MEDIA_SCHEME}://artwork/${id}`,
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('freeswap', api)
