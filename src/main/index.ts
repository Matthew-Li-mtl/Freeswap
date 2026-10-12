// Electron main process entry point: creates the window and wires up the back end
// (database, library, file protocol, downloads, recording).

import { app, BrowserWindow, Menu, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/api'
import { openDatabase } from './db/database'
import { LibraryRepository } from './library/repository'
import { LibraryService } from './library/service'
import { VolumeWatcher } from './library/volumes'
import { handleMediaProtocol, registerMediaScheme } from './protocol'
import { registerIpc } from './ipc'
import { SettingsStore } from './settings'
import { WavRecorder } from './recording'
import { YouTubeImporter } from './youtube'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A separate data folder (library database, settings) can be chosen for testing or a
// portable install, e.g. FREESWAP_USER_DATA=D:\FreeswapData
if (process.env.FREESWAP_USER_DATA) app.setPath('userData', process.env.FREESWAP_USER_DATA)

// Audio should start without a click first, and keep running at full speed when the
// window is in the background (otherwise Chromium throttles timers and the mix stutters).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

registerMediaScheme()

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null

async function boot(): Promise<void> {
  const db = openDatabase(path.join(app.getPath('userData'), 'freeswap.db'))
  const repo = new LibraryRepository(db)
  const settings = new SettingsStore(db)
  const volumes = new VolumeWatcher()
  await volumes.start()
  const library = new LibraryService(repo, volumes, path.join(app.getPath('userData'), 'artwork'))
  await library.init()

  handleMediaProtocol(library)

  const youtube = new YouTubeImporter(
    library,
    () => settings.get().downloadFolder,
    (jobs) => mainWindow?.webContents.send(IPC.youtubeJobs, jobs),
    (tracks, folderId) => {
      if (folderId != null)
        repo.addToFolder(
          folderId,
          tracks.map((t) => t.id)
        )
      mainWindow?.webContents.send(IPC.libraryTracksChanged, tracks)
    }
  )

  const recorder = new WavRecorder()
  registerIpc({
    window: () => mainWindow,
    repo,
    library,
    settings,
    recorder,
    youtube
  })

  // Allow the page to list audio output devices (with names) and pick one.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'speaker-selection', 'audioCapture'].includes(permission)
  )
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(['media', 'speaker-selection'].includes(permission))
  )

  Menu.setApplicationMenu(null)
  createWindow()

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    // Finish any recording first so its WAV header gets the final length.
    e.preventDefault()
    quitting = true
    volumes.stop()
    void recorder.stop().finally(() => {
      db.close()
      app.quit()
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#0d0f13',
    title: 'Freeswap',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  // F12 toggles the developer tools (handy for debugging; harmless for users).
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools()
  })
  // Never navigate away from the app or open new windows from links.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    // Dev mode: echo the page's console into this terminal for easier debugging.
    mainWindow.webContents.on('console-message', (e) => {
      const { level, message } = e as unknown as { level: string; message: string }
      console.log(`[renderer:${level}] ${message}`)
    })
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => app.quit())

void app.whenReady().then(boot)
