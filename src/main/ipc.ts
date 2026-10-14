// IPC handlers: the main-process side of every `window.freeswap.*` call.

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/api'
import type { AnalysisResult, ImportResult, Settings, Track, TrackPatch } from '@shared/types'
import type { LibraryRepository } from './library/repository'
import { AUDIO_EXTENSIONS, type LibraryService } from './library/service'
import type { SettingsStore } from './settings'
import type { WavRecorder } from './recording'
import type { YouTubeImporter } from './youtube'

interface Deps {
  window: () => BrowserWindow | null
  repo: LibraryRepository
  library: LibraryService
  settings: SettingsStore
  recorder: WavRecorder
  youtube: YouTubeImporter
}

export function registerIpc(d: Deps): void {
  const send = (channel: string, payload: unknown): void => {
    d.window()?.webContents.send(channel, payload)
  }

  d.library.on('tracksChanged', (tracks: Track[]) => send(IPC.libraryTracksChanged, tracks))

  const importInto = async (paths: string[], folderId: number | null): Promise<ImportResult> => {
    return d.library.importPaths(paths, folderId, (p) => send(IPC.libraryImportProgress, p))
  }

  ipcMain.handle(IPC.librarySnapshot, () => d.library.snapshot())
  ipcMain.handle(IPC.libraryImportPaths, (_e, paths: string[], folderId: number | null) => importInto(paths, folderId))
  ipcMain.handle(IPC.libraryPickPaths, async (_e, kind: 'files' | 'folder') => {
    const exts = [...AUDIO_EXTENSIONS].map((e) => e.slice(1))
    const res = await dialog.showOpenDialog(d.window()!, {
      title: kind === 'folder' ? 'Import a folder of music' : 'Import music files',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: kind === 'files' ? [{ name: 'Audio', extensions: exts }] : undefined
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle(IPC.libraryUpdateTrack, (_e, id: number, patch: TrackPatch) => d.repo.updateTrack(id, patch))
  ipcMain.handle(IPC.libraryRemoveTracks, (_e, ids: number[]) => d.repo.removeTracks(ids))
  ipcMain.handle(IPC.librarySaveAnalysis, (_e, id: number, result: AnalysisResult) => d.repo.saveAnalysis(id, result))
  ipcMain.handle(IPC.libraryGetWaveform, (_e, id: number) => d.repo.getWaveform(id))
  ipcMain.handle(IPC.libraryRelocate, async (_e, id: number) => {
    const t = d.repo.getTrack(id)
    const res = await dialog.showOpenDialog(d.window()!, {
      title: `Locate "${t?.title ?? 'track'}"`,
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return d.library.relocate(id, res.filePaths[0])
  })
  ipcMain.handle(IPC.libraryShowInFolder, (_e, id: number) => {
    const p = d.library.pathFor(id)
    if (p) shell.showItemInFolder(p)
  })

  ipcMain.handle(IPC.folderCreate, (_e, parentId: number | null, name: string) => d.repo.createFolder(parentId, name))
  ipcMain.handle(IPC.folderRename, (_e, id: number, name: string) => d.repo.renameFolder(id, name))
  ipcMain.handle(IPC.folderRemove, (_e, id: number) => d.repo.removeFolder(id))
  ipcMain.handle(IPC.folderMove, (_e, id: number, parentId: number | null, position: number) => {
    d.repo.moveFolder(id, parentId, position)
    return d.repo.allFolders()
  })
  ipcMain.handle(IPC.folderAddTracks, (_e, folderId: number, ids: number[]) => d.repo.addToFolder(folderId, ids))
  ipcMain.handle(IPC.folderRemoveTracks, (_e, folderId: number, ids: number[]) =>
    d.repo.removeFromFolder(folderId, ids)
  )
  ipcMain.handle(IPC.folderReorder, (_e, folderId: number, ids: number[]) => d.repo.reorderFolder(folderId, ids))

  ipcMain.handle(IPC.settingsGet, () => d.settings.get())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => d.settings.set(patch))
  ipcMain.handle(IPC.settingsPickFolder, async (_e, current: string) => {
    const res = await dialog.showOpenDialog(d.window()!, {
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.youtubeDownload, (_e, url: string, folderId: number | null) => d.youtube.enqueue(url, folderId))

  ipcMain.handle(IPC.recordingStart, (_e, sampleRate: number, channels: number) =>
    d.recorder.start(d.settings.get().recordingFolder, sampleRate, channels)
  )
  ipcMain.on(IPC.recordingWrite, (_e, chunk: ArrayBuffer) => d.recorder.write(chunk))
  ipcMain.handle(IPC.recordingStop, () => d.recorder.stop())
  ipcMain.handle(IPC.recordingReveal, (_e, p: string) => shell.showItemInFolder(p))
}
