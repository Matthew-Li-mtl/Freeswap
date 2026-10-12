// Quick reference of the current keyboard layout (F1).

import { useMemo } from 'react'
import { useUi } from '../state/ui'
import { useSettings } from '../state/settings'
import { allActions, currentKeymap } from '../input/bindings'
import { prettyCombo } from '../input/actions'
import { Btn } from './controls'

const LAYERS: [string, (c: string) => boolean][] = [
  ['No modifier — performance', (c) => !c.includes('+')],
  ['Shift — mixer', (c) => c.startsWith('Shift')],
  ['Ctrl — effects & pad modes', (c) => c.startsWith('Control')],
  ['Alt — kills & beat grid', (c) => c.startsWith('Alt')]
]

export function KeyOverlay() {
  const open = useUi((s) => s.showKeys)
  const keymap = useSettings((s) => s.settings.keymap)
  const map = useMemo(() => currentKeymap(), [keymap, open])
  if (!open) return null
  const actions = allActions()
  const groups = ['Deck 1', 'Deck 2', 'Mixer', 'App']

  return (
    <div className="modal-backdrop" onPointerDown={() => useUi.setState({ showKeys: false })}>
      <div className="modal" style={{ width: 1180 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Keyboard shortcuts
          <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11 }}>
            Left hand plays deck 1, right hand deck 2. Each hand uses its own Shift / Ctrl / Alt for layers. Change them
            in Settings.
          </span>
          <Btn className="ghost" onPress={() => useUi.setState({ showKeys: false })}>
            ✕
          </Btn>
        </div>
        <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.8fr 0.8fr', gap: 18 }}>
          {groups.map((g) => (
            <div key={g}>
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 6,
                  color: g === 'Deck 1' ? 'var(--deck1)' : g === 'Deck 2' ? 'var(--deck2)' : 'var(--text)'
                }}
              >
                {g}
              </div>
              {LAYERS.map(([layer, test]) => {
                const rows = actions
                  .filter((a) => a.group === g)
                  .map((a) => ({ a, combos: (map[a.id] ?? []).filter(test) }))
                  .filter((r) => r.combos.length)
                if (!rows.length) return null
                return (
                  <div key={layer} style={{ marginBottom: 10 }}>
                    <div className="label" style={{ marginBottom: 3 }}>
                      {layer}
                    </div>
                    {rows.map(({ a, combos }) => (
                      <div
                        key={a.id}
                        style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '1px 0' }}
                      >
                        <span style={{ color: 'var(--text-dim)' }}>{a.label}</span>
                        <span className="mono" style={{ whiteSpace: 'nowrap' }}>
                          {combos.map(prettyCombo).join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
