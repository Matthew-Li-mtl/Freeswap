import { useEffect, useRef, useState } from 'react'
import { api } from './platform'
import { createEngine } from './audio/engine'
import { loadSettings, settings, updateSettings, useSettings } from './state/settings'
import { getTrack, loadLibrary, reloadFolders, upsertTracks, useLibrary } from './state/library'
import { useUi } from './state/ui'
import { initDecks, loadTrack, setTempoRange, syncEngineFromState } from './control/deck'
import { applyMixerToEngine } from './control/mixer'
import { restoreSamples } from './control/sampler'
import { analysisQueue } from './library/analysisQueue'
import { initKeyboard } from './input/bindings'
import { TopBar } from './ui/TopBar'
import { ZoomedWaveform } from './ui/Waveforms'
import { Deck } from './ui/Deck'
import { Mixer } from './ui/Mixer'
import { Browser, moveSelection, searchInputRef, selectedTrack } from './ui/Browser'
import { SettingsModal } from './ui/Settings'
import { KeyOverlay } from './ui/KeyOverlay'
import { ContextMenu } from './ui/ContextMenu'
import { TrackInfoModal } from './ui/TrackInfo'

async function boot(): Promise<void> {
  const s = await loadSettings()
  await loadLibrary()
  const engine = await createEngine()
  initDecks()
  syncEngineFromState()
  applyMixerToEngine()
  setTempoRange(0, s.defaultTempoRange)
  setTempoRange(1, s.defaultTempoRange)
  await engine.setOutputs(s.masterDeviceId, s.headphoneDeviceId)

  api.library.onTracksChanged((tracks) => {
    const fresh = tracks.filter((t) => !getTrack(t.id))
    upsertTracks(tracks)
    if (fresh.length) {
      // New tracks (e.g. a finished YouTube download): analyse them and refresh folders.
      analysisQueue.enqueue(fresh.filter((t) => !t.analyzed).map((t) => t.id))
      void reloadFolders()
    }
  })
  api.library.onImportProgress((p) => useLibrary.setState({ importing: p.done < p.total ? p : null }))
  api.youtube.onJobs((downloads) => useLibrary.setState({ downloads }))

  void restoreSamples()

  // Anything imported but never analysed (e.g. the app was closed mid-way) gets queued.
  const pending = Object.values(useLibrary.getState().tracks).filter((t) => !t.analyzed && t.available)
  analysisQueue.enqueue(pending.map((t) => t.id))

  initKeyboard({
    'app.search': () => searchInputRef.current?.focus(),
    'app.keys': () => useUi.setState((u) => ({ showKeys: !u.showKeys, showSettings: false })),
    'app.settings': () => useUi.setState((u) => ({ showSettings: !u.showSettings, showKeys: false })),
    'app.up': () => moveSelection(-1),
    'app.down': () => moveSelection(1),
    'app.load1': () => {
      const id = selectedTrack()
      if (id != null) void loadTrack(0, id)
    },
    'app.load2': () => {
      const id = selectedTrack()
      if (id != null) void loadTrack(1, id)
    }
  })
}

export function App() {
  const [state, setState] = useState<'booting' | 'ready' | 'error'>('booting')
  const [error, setError] = useState('')

  useEffect(() => {
    boot()
      .then(() => setState('ready'))
      .catch((err) => {
        console.error(err)
        setError(String(err?.stack ?? err))
        setState('error')
      })
  }, [])

  if (state === 'booting')
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="wordmark" style={{ fontSize: 22 }}>
          FREESWAP
        </span>
      </div>
    )
  if (state === 'error')
    return (
      <div style={{ padding: 24 }}>
        <h3>Freeswap couldn't start</h3>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--danger)' }}>{error}</pre>
      </div>
    )
  return <Main />
}

function Main() {
  const browserHeight = useSettings((s) => s.settings.browserHeight)
  const toasts = useUi((s) => s.toasts)
  const drag = useRef<{ y: number; h: number } | null>(null)
  const [h, setH] = useState(browserHeight)
  const [winH, setWinH] = useState(window.innerHeight)
  useEffect(() => setH(browserHeight), [browserHeight])
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div
      className="app"
      style={{ gridTemplateRows: `38px 152px minmax(0, 1fr) 6px ${Math.max(120, Math.min(h, winH - 580))}px` }}
    >
      <TopBar />
      <div className="waveforms" style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 1 }}>
        <ZoomedWaveform d={0} />
        <ZoomedWaveform d={1} />
      </div>
      <div className="decks">
        <Deck d={0} />
        <Mixer />
        <Deck d={1} />
      </div>
      <div
        className="splitter"
        onPointerDown={(e) => {
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, h }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const next = drag.current.h - (e.clientY - drag.current.y)
          setH(Math.max(120, Math.min(window.innerHeight - 580, next)))
        }}
        onPointerUp={() => {
          drag.current = null
          if (h !== settings().browserHeight) void updateSettings({ browserHeight: h })
        }}
      />
      <Browser />
      <SettingsModal />
      <KeyOverlay />
      <ContextMenu />
      <TrackInfoModal />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
