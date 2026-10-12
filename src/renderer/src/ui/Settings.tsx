import { useEffect, useMemo, useState } from 'react'
import { useSettings, updateSettings } from '../state/settings'
import { useUi, toast } from '../state/ui'
import { AudioEngine, getEngine } from '../audio/engine'
import { api } from '../platform'
import { allActions, captureCombo, currentKeymap, resetKeymap, setBindings } from '../input/bindings'
import { prettyCombo } from '../input/actions'
import { setTempoRange } from '../control/deck'
import { Btn } from './controls'

export function SettingsModal() {
  const open = useUi((s) => s.showSettings)
  if (!open) return null
  return (
    <div className="modal-backdrop" onPointerDown={() => useUi.setState({ showSettings: false })}>
      <div className="modal" style={{ width: 860 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Settings
          <Btn className="ghost" onPress={() => useUi.setState({ showSettings: false })}>
            ✕
          </Btn>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <AudioSection />
          <GeneralSection />
          <KeymapSection />
        </div>
      </div>
    </div>
  )
}

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '200px 1fr',
  alignItems: 'center',
  gap: 12,
  minHeight: 30
}
const h: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }

function AudioSection() {
  const s = useSettings((st) => st.settings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const load = () => void AudioEngine.listOutputs().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])

  const apply = async (masterDeviceId: string, headphoneDeviceId: string) => {
    // "Default" and the device it points to are the same hardware under two ids;
    // groupId tells us when two entries are really one physical device.
    const group = (id: string) => devices.find((d) => d.deviceId === id)?.groupId
    if (
      headphoneDeviceId &&
      (headphoneDeviceId === masterDeviceId || group(headphoneDeviceId) === group(masterDeviceId))
    ) {
      toast('Master and headphones must be two different devices', 'error')
      return
    }
    await updateSettings({ masterDeviceId, headphoneDeviceId })
    await getEngine().setOutputs(masterDeviceId, headphoneDeviceId)
  }

  const name = (d: MediaDeviceInfo) =>
    d.label || (d.deviceId === 'default' ? 'System default' : `Device ${d.deviceId.slice(0, 6)}`)

  return (
    <section>
      <div style={h}>Audio outputs</div>
      <div style={row}>
        <span>Master (speakers)</span>
        <select value={s.masterDeviceId} onChange={(e) => void apply(e.target.value, s.headphoneDeviceId)}>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {name(d)}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <span>Headphones (cue)</span>
        <select value={s.headphoneDeviceId} onChange={(e) => void apply(s.masterDeviceId, e.target.value)}>
          <option value="">Off</option>
          {devices
            .filter((d) => d.deviceId !== s.masterDeviceId)
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {name(d)}
              </option>
            ))}
        </select>
      </div>
      <div style={{ color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.5 }}>
        Choose any two different devices — e.g. speakers on your sound card and headphones on a USB adapter or
        Bluetooth. The headphones hear the channels with 🎧 CUE on, blended with the master by HP MIX.
      </div>
    </section>
  )
}

function GeneralSection() {
  const s = useSettings((st) => st.settings)
  return (
    <section>
      <div style={h}>General</div>
      <div style={row}>
        <span>Key notation</span>
        <select
          value={s.keyNotation}
          onChange={(e) => void updateSettings({ keyNotation: e.target.value as 'camelot' | 'musical' })}
        >
          <option value="camelot">Camelot wheel (8A, 9B…)</option>
          <option value="musical">Musical (Am, E…)</option>
        </select>
      </div>
      <div style={row}>
        <span>BPM detection range</span>
        <select value={s.bpmRangeLow} onChange={(e) => void updateSettings({ bpmRangeLow: Number(e.target.value) })}>
          {[60, 70, 75, 80, 88, 95].map((lo) => (
            <option key={lo} value={lo}>
              {lo} – {lo * 2 - 1} BPM
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <span>Default tempo range</span>
        <select
          value={s.defaultTempoRange}
          onChange={(e) => {
            const r = Number(e.target.value)
            void updateSettings({ defaultTempoRange: r })
            setTempoRange(0, r)
            setTempoRange(1, r)
          }}
        >
          {[0.06, 0.1, 0.16, 0.5].map((r) => (
            <option key={r} value={r}>
              ±{Math.round(r * 100)}%
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <span>Auto gain</span>
        <label>
          <input
            type="checkbox"
            checked={s.autoGain}
            onChange={(e) => void updateSettings({ autoGain: e.target.checked })}
          />{' '}
          Set each track's trim from its measured loudness when loading
        </label>
      </div>
      <div style={row}>
        <span>Protect playing deck</span>
        <label>
          <input
            type="checkbox"
            checked={s.lockPlayingDeck}
            onChange={(e) => void updateSettings({ lockPlayingDeck: e.target.checked })}
          />{' '}
          Don't load a new track onto a deck that is playing
        </label>
      </div>
      <FolderRow
        label="YouTube downloads"
        value={s.downloadFolder}
        onPick={(p) => void updateSettings({ downloadFolder: p })}
      />
      <FolderRow
        label="Mix recordings"
        value={s.recordingFolder}
        onPick={(p) => void updateSettings({ recordingFolder: p })}
      />
    </section>
  )
}

function FolderRow({ label, value, onPick }: { label: string; value: string; onPick: (p: string) => void }) {
  return (
    <div style={row}>
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
        <span
          className="mono"
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-dim)'
          }}
        >
          {value}
        </span>
        <Btn
          onPress={async () => {
            const p = await api.settings.pickFolder(value)
            if (p) onPick(p)
          }}
        >
          CHANGE…
        </Btn>
      </div>
    </div>
  )
}

function KeymapSection() {
  const keymap = useSettings((s) => s.settings.keymap)
  const [filter, setFilter] = useState('')
  const [capturing, setCapturing] = useState<string | null>(null)
  const map = useMemo(() => currentKeymap(), [keymap])
  const actions = allActions().filter(
    (a) => !filter || `${a.group} ${a.label}`.toLowerCase().includes(filter.toLowerCase())
  )
  const groups = [...new Set(actions.map((a) => a.group))]

  const add = async (id: string) => {
    setCapturing(id)
    const combo = await captureCombo()
    setCapturing(null)
    if (combo) await setBindings(id, [...(map[id] ?? []).filter((c) => c !== combo), combo])
  }

  return (
    <section>
      <div style={{ ...h, display: 'flex', alignItems: 'center', gap: 10 }}>
        Keyboard shortcuts
        <input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 180 }}
        />
        <span style={{ flex: 1 }} />
        <Btn
          onPress={() => {
            if (confirm('Reset all keyboard shortcuts to the defaults?')) void resetKeymap()
          }}
        >
          RESET TO DEFAULTS
        </Btn>
      </div>
      <div style={{ color: 'var(--text-faint)', marginBottom: 8 }}>
        Click + then press a key (optionally while holding one Shift/Ctrl/Alt). Left and right modifiers are different
        keys, so each hand can have its own layers. Esc cancels.
      </div>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 10 }}>
          <div className="label" style={{ marginBottom: 4 }}>
            {g}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 18 }}>
            {actions
              .filter((a) => a.group === g)
              .map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minHeight: 26,
                    borderBottom: '1px solid var(--line)'
                  }}
                >
                  <span style={{ flex: 1 }}>{a.label}</span>
                  {(map[a.id] ?? []).map((c) => (
                    <span
                      key={c}
                      className="mono"
                      style={{
                        background: 'var(--panel-3)',
                        borderRadius: 4,
                        padding: '1px 6px',
                        fontSize: 11,
                        cursor: 'pointer'
                      }}
                      title="Click to remove"
                      onClick={() =>
                        void setBindings(
                          a.id,
                          (map[a.id] ?? []).filter((x) => x !== c)
                        )
                      }
                    >
                      {prettyCombo(c)} ✕
                    </span>
                  ))}
                  <Btn className="ghost" style={{ minHeight: 18, padding: '0 6px' }} onPress={() => void add(a.id)}>
                    {capturing === a.id ? 'press a key…' : '+'}
                  </Btn>
                </div>
              ))}
          </div>
        </div>
      ))}
    </section>
  )
}
