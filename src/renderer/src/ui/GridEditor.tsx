// Beat grid / BPM / key editor. It replaces the deck's effects row while open, so the
// waveform above stays fully visible while you line the markers up.

import { useEffect, useState } from 'react'
import { allKeys, formatKey } from '@shared/musicKey'
import { useDecks } from '../state/decks'
import { useSettings } from '../state/settings'
import * as D from '../control/deck'
import { Btn } from './controls'
import { useKeyHint } from './keyHint'
import { TapButton } from './Deck'

const small = { minHeight: 20, padding: '0 6px' }

export function GridEditor({ d }: { d: number }) {
  const grid = useDecks((s) => s.decks[d].grid)
  const key = useDecks((s) => s.decks[d].key)
  const notation = useSettings((s) => s.settings.keyNotation)
  const hint = useKeyHint()
  const [bpmText, setBpmText] = useState(grid ? grid.bpm.toFixed(2) : '')

  useEffect(() => setBpmText(grid ? grid.bpm.toFixed(2) : ''), [grid?.bpm])

  const commitBpm = () => {
    const v = parseFloat(bpmText)
    if (v > 20 && v < 400) D.setGridBpm(d, v)
    else setBpmText(grid ? grid.bpm.toFixed(2) : '')
  }

  const row = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap' as const }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: 'var(--panel-2)',
        border: '1px solid var(--warn)',
        borderRadius: 6,
        padding: '4px 6px'
      }}
    >
      <div style={row}>
        <span className="label" style={{ color: 'var(--warn)', width: 34 }}>
          Grid
        </span>
        <Btn style={small} title={hint('Move all markers 100 ms earlier', [])} onPress={() => D.shiftGrid(d, -100)}>
          ◀◀ 100
        </Btn>
        <Btn
          style={small}
          title={hint('Move all markers 10 ms earlier', `d${d}.grid.earlier`)}
          onPress={() => D.shiftGrid(d, -10)}
        >
          ◀ 10
        </Btn>
        <Btn
          style={small}
          title={hint('Move all markers 10 ms later', `d${d}.grid.later`)}
          onPress={() => D.shiftGrid(d, 10)}
        >
          10 ▶
        </Btn>
        <Btn style={small} title="Move all markers 100 ms later" onPress={() => D.shiftGrid(d, 100)}>
          100 ▶▶
        </Btn>
        <Btn
          style={small}
          title={hint('Put beat 1 (bar and phrase start) exactly at the playhead', `d${d}.grid.downbeat`)}
          onPress={() => D.setDownbeatHere(d)}
        >
          SET 1
        </Btn>
        <span className="label" style={{ marginLeft: 6 }}>
          Beat 1
        </span>
        <Btn
          style={small}
          title={hint('Downbeat one beat earlier', `d${d}.grid.beatLeft`)}
          onPress={() => D.shiftDownbeat(d, -1)}
        >
          ◀
        </Btn>
        <Btn
          style={small}
          title={hint('Downbeat one beat later', `d${d}.grid.beatRight`)}
          onPress={() => D.shiftDownbeat(d, 1)}
        >
          ▶
        </Btn>
        <span className="label" style={{ marginLeft: 6 }}>
          Phrase
        </span>
        <Btn
          style={small}
          title={hint('Phrase markers one bar earlier', `d${d}.grid.barLeft`)}
          onPress={() => D.shiftDownbeat(d, -4)}
        >
          ◀
        </Btn>
        <Btn
          style={small}
          title={hint('Phrase markers one bar later', `d${d}.grid.barRight`)}
          onPress={() => D.shiftDownbeat(d, 4)}
        >
          ▶
        </Btn>
      </div>
      <div style={row}>
        <span className="label" style={{ width: 34 }}>
          BPM
        </span>
        <input
          className="mono"
          style={{ width: 64, padding: '1px 4px' }}
          value={bpmText}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={commitBpm}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setBpmText(grid ? grid.bpm.toFixed(2) : '')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <Btn style={small} title="Double BPM" onPress={() => grid && D.setGridBpm(d, grid.bpm * 2)}>
          ×2
        </Btn>
        <Btn style={small} title="Halve BPM" onPress={() => grid && D.setGridBpm(d, grid.bpm / 2)}>
          ÷2
        </Btn>
        <TapButton d={d} />
        <span className="label" style={{ marginLeft: 6 }}>
          Key
        </span>
        <select
          style={{ padding: '1px 2px' }}
          value={key ?? ''}
          onChange={(e) => D.setKey(d, e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">—</option>
          {allKeys().map((k) => (
            <option key={k} value={k}>
              {formatKey(k, notation)} ({formatKey(k, notation === 'camelot' ? 'musical' : 'camelot')})
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <Btn style={small} title="Discard edits and analyse again" onPress={() => void D.reanalyze(d)}>
          RE-ANALYSE
        </Btn>
        <Btn
          style={small}
          lit
          color="var(--ok)"
          onPress={() => D.toggleGridEdit(d)}
          title={hint('Close the grid editor', `d${d}.grid.edit`)}
        >
          DONE
        </Btn>
      </div>
    </div>
  )
}
