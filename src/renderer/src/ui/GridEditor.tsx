// Beat grid / BPM / key editor, shown over a deck's zoomed waveform.

import { useEffect, useState } from 'react'
import { allKeys, formatKey } from '@shared/musicKey'
import { useDecks } from '../state/decks'
import { useSettings } from '../state/settings'
import * as D from '../control/deck'
import { Btn } from './controls'

export function GridEditor({ d }: { d: number }) {
  const grid = useDecks((s) => s.decks[d].grid)
  const key = useDecks((s) => s.decks[d].key)
  const notation = useSettings((s) => s.settings.keyNotation)
  const [bpmText, setBpmText] = useState(grid ? grid.bpm.toFixed(2) : '')

  useEffect(() => setBpmText(grid ? grid.bpm.toFixed(2) : ''), [grid?.bpm])

  const commitBpm = () => {
    const v = parseFloat(bpmText)
    if (v > 20 && v < 400) D.setGridBpm(d, v)
    else setBpmText(grid ? grid.bpm.toFixed(2) : '')
  }

  return (
    <div
      style={{
        position: 'absolute',
        right: 6,
        bottom: 4,
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        background: 'rgba(21,24,30,0.92)',
        border: '1px solid var(--line-2)',
        borderRadius: 6,
        padding: '3px 6px'
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="label">Grid</span>
      <Btn title="Move grid 10 ms earlier" onPress={() => D.shiftGrid(d, -10)}>
        ◀◀
      </Btn>
      <Btn title="Move grid 1 ms earlier" onPress={() => D.shiftGrid(d, -1)}>
        ◀
      </Btn>
      <Btn title="Move grid 1 ms later" onPress={() => D.shiftGrid(d, 1)}>
        ▶
      </Btn>
      <Btn title="Move grid 10 ms later" onPress={() => D.shiftGrid(d, 10)}>
        ▶▶
      </Btn>
      <Btn title="Put beat 1 (bar and phrase start) exactly at the playhead" onPress={() => D.setDownbeatHere(d)}>
        SET 1
      </Btn>
      <span className="label" style={{ marginLeft: 4 }}>
        Beat 1
      </span>
      <Btn title="Downbeat one beat earlier" onPress={() => D.shiftDownbeat(d, -1)}>
        ◀
      </Btn>
      <Btn title="Downbeat one beat later" onPress={() => D.shiftDownbeat(d, 1)}>
        ▶
      </Btn>
      <span className="label" style={{ marginLeft: 4 }}>
        Phrase
      </span>
      <Btn title="Phrase markers one bar earlier" onPress={() => D.shiftDownbeat(d, -4)}>
        ◀
      </Btn>
      <Btn title="Phrase markers one bar later" onPress={() => D.shiftDownbeat(d, 4)}>
        ▶
      </Btn>
      <span className="label" style={{ marginLeft: 4 }}>
        BPM
      </span>
      <input
        className="mono"
        style={{ width: 62 }}
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
      <Btn title="Double BPM" onPress={() => grid && D.setGridBpm(d, grid.bpm * 2)}>
        ×2
      </Btn>
      <Btn title="Halve BPM" onPress={() => grid && D.setGridBpm(d, grid.bpm / 2)}>
        ÷2
      </Btn>
      <Btn title="Tap along to the beat (4+ taps)" onPress={() => D.tapTempo(d)}>
        TAP
      </Btn>
      <span className="label" style={{ marginLeft: 4 }}>
        Key
      </span>
      <select value={key ?? ''} onChange={(e) => D.setKey(d, e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">—</option>
        {allKeys().map((k) => (
          <option key={k} value={k}>
            {formatKey(k, notation)} ({formatKey(k, notation === 'camelot' ? 'musical' : 'camelot')})
          </option>
        ))}
      </select>
      <Btn title="Discard edits and analyse again" onPress={() => void D.reanalyze(d)}>
        RE-ANALYSE
      </Btn>
      <Btn lit color="var(--ok)" onPress={() => D.toggleGridEdit(d)}>
        DONE
      </Btn>
    </div>
  )
}
