import { useEffect, useRef } from 'react'
import { useDecks } from '../state/decks'
import { useUi } from '../state/ui'
import { api } from '../platform'
import { toggleRecording } from '../control/mixer'
import { Btn } from './controls'
import { formatTime, onFrame } from './frameLoop'

export function TopBar() {
  const recording = useDecks((s) => s.mixer.recording)
  const last = useDecks((s) => s.mixer.lastRecording)
  const recTime = useRef<HTMLSpanElement>(null)
  const clock = useRef<HTMLSpanElement>(null)

  useEffect(
    () =>
      onFrame(() => {
        const m = useDecks.getState().mixer
        if (recTime.current)
          recTime.current.textContent = m.recording ? formatTime((Date.now() - m.recordStartedAt) / 1000, false) : ''
        if (clock.current)
          clock.current.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }),
    []
  )

  return (
    <div className="topbar">
      <span className="wordmark">FREESWAP</span>
      <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>free · open source</span>
      <div style={{ flex: 1 }} />
      <span ref={clock} className="mono" style={{ color: 'var(--text-dim)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Btn
          lit={recording}
          color="var(--danger)"
          onPress={() => void toggleRecording()}
          title="Record the master output to a WAV file [F9]"
        >
          ● REC
        </Btn>
        <span ref={recTime} className="mono" style={{ color: 'var(--danger)', minWidth: 40 }} />
        {last && !recording && (
          <Btn className="ghost" onPress={() => void api.recording.reveal(last)} title={last}>
            last mix ↗
          </Btn>
        )}
      </div>
      <Btn onPress={() => useUi.setState({ showKeys: true })} title="Keyboard shortcuts [F1]">
        ⌨ KEYS
      </Btn>
      <Btn onPress={() => useUi.setState({ showSettings: true })} title="Settings [F2]">
        ⚙ SETTINGS
      </Btn>
    </div>
  )
}
