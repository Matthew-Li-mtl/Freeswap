// One deck panel: track info, overview waveform, effects, jog, tempo, loops, pads, transport.

import { useEffect, useRef, type CSSProperties } from 'react'
import { formatKey } from '@shared/musicKey'
import { api } from '../platform'
import { useDecks, deck, type PadMode } from '../state/decks'
import { useLibrary } from '../state/library'
import { useSettings } from '../state/settings'
import { useUi } from '../state/ui'
import { assignSample } from '../control/sampler'
import { getEngine } from '../audio/engine'
import { BEAT_DIVISIONS, FX_LIST, formatBeats } from '../audio/effects'
import * as D from '../control/deck'
import { toggleLabel } from '../control/mixer'
import { Btn, Fader } from './controls'
import { Jog } from './Jog'
import { OverviewWaveform } from './Waveforms'
import { formatTime, onFrame } from './frameLoop'
import { readDraggedTracks, importDroppedFiles } from './dnd'

const COLORS = ['#2fd6b5', '#ff7a59']
const TEMPO_RANGES = [0.06, 0.1, 0.16, 0.5]

export function Deck({ d }: { d: number }) {
  const color = COLORS[d]
  const mirrored = d === 1
  return (
    <div
      className="panel deck"
      style={
        { '--deck': color, display: 'flex', flexDirection: 'column', gap: 6, padding: 8, minWidth: 0 } as CSSProperties
      }
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault()
        const ids = readDraggedTracks(e)
        if (ids.length) return void D.loadTrack(d, ids[0])
        const imported = await importDroppedFiles(e)
        if (imported.length) void D.loadTrack(d, imported[0].id)
      }}
    >
      <DeckHeader d={d} />
      <div style={{ height: 40 }}>
        <OverviewWaveform d={d} />
      </div>
      <FxRow d={d} />
      <div
        style={{
          display: 'flex',
          flexDirection: mirrored ? 'row-reverse' : 'row',
          gap: 10,
          flex: 1,
          minHeight: 0,
          alignItems: 'stretch'
        }}
      >
        <TempoColumn d={d} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <Jog d={d} size={158} />
          <Transport d={d} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <LoopRow d={d} />
          <Pads d={d} />
          <ToggleRow d={d} />
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ header

function DeckHeader({ d }: { d: number }) {
  const s = useDecks((st) => st.decks[d])
  const track = useLibrary((st) => (s.trackId != null ? st.tracks[s.trackId] : undefined))
  const notation = useSettings((st) => st.settings.keyNotation)
  const elapsed = useRef<HTMLSpanElement>(null)
  const remain = useRef<HTMLSpanElement>(null)
  const bpm = D.currentBpm(s)

  useEffect(
    () =>
      onFrame(() => {
        const st = deck(d)
        if (!elapsed.current || !remain.current) return
        const pos = st.trackId != null ? getEngine().channels[d].player.posHeard() : 0
        elapsed.current.textContent = formatTime(pos)
        remain.current.textContent = '-' + formatTime(Math.max(0, st.duration - pos))
        remain.current.style.color = st.trackId != null && st.duration - pos < 30 ? 'var(--danger)' : 'var(--text-dim)'
      }),
    [d]
  )

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 50 }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 4,
          flexShrink: 0,
          background: track?.hasArtwork ? `center/cover url(${api.artworkUrl(track.id)})` : 'var(--panel-3)',
          border: `1px solid ${COLORS[d]}55`
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {s.loading ? 'Loading…' : (track?.title ?? (s.error || 'No track loaded'))}
        </div>
        <div style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {track?.artist}
          {s.analyzing && <span style={{ color: 'var(--warn)', marginLeft: 8 }}>analysing…</span>}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="mono" style={{ fontSize: 13 }}>
          <span ref={elapsed}>00:00.0</span>
        </div>
        <div className="mono" style={{ fontSize: 11 }}>
          <span ref={remain}>-00:00.0</span>
        </div>
      </div>
      <div
        title="Key (click to edit the beat grid, BPM and key)"
        onMouseDown={() => s.trackId != null && D.toggleGridEdit(d)}
        style={{ width: 44, textAlign: 'center', cursor: 'pointer' }}
      >
        <div className="label">Key</div>
        <div className="mono" style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>
          {s.key != null ? formatKey(s.key, notation) : '—'}
        </div>
      </div>
      <div
        title="BPM (click to edit the beat grid)"
        onMouseDown={() => s.trackId != null && D.toggleGridEdit(d)}
        style={{ width: 74, textAlign: 'right', cursor: 'pointer' }}
      >
        <div className="label">{s.master && <span style={{ color: COLORS[d] }}>MASTER </span>}BPM</div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: COLORS[d], lineHeight: 1 }}>
          {bpm ? bpm.toFixed(2) : '—'}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ effects

function FxRow({ d }: { d: number }) {
  const fx = useDecks((s) => s.decks[d].fx)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {fx.map((f, i) => {
        const info = FX_LIST.find((x) => x.id === f.type)
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--panel-2)',
              border: `1px solid ${f.enabled ? 'var(--deck)' : 'var(--line)'}`,
              borderRadius: 6,
              padding: '2px 4px',
              minWidth: 0
            }}
          >
            {/* The slot's name doubles as its on/off switch. */}
            <Btn
              lit={f.enabled}
              color="var(--deck)"
              style={{ padding: '0 5px', minHeight: 20 }}
              onPress={() => toggleLabel({ kind: 'fx', deck: d, slot: i })}
              title="Switch this effect on / off"
            >
              FX{i + 1}
            </Btn>
            <select
              value={f.type}
              tabIndex={-1}
              style={{ flex: 1, minWidth: 0, padding: '1px 2px', fontSize: 11 }}
              onChange={(e) => D.setFxType(d, i, e.target.value as typeof f.type)}
              title="Effect"
            >
              {FX_LIST.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            {info?.beats != null && (
              <select
                value={f.beats}
                tabIndex={-1}
                className="mono"
                style={{ width: 46, padding: '1px 2px', fontSize: 10 }}
                onChange={(e) => D.setFxBeats(d, i, Number(e.target.value))}
                title="Length in beats"
              >
                {BEAT_DIVISIONS.map((b) => (
                  <option key={b} value={b}>
                    {formatBeats(b)}
                  </option>
                ))}
              </select>
            )}
            <MiniKnob value={f.depth} onChange={(v) => D.setFxDepth(d, i, v)} lit={f.enabled} />
          </div>
        )
      })}
    </div>
  )
}

function MiniKnob({ value, onChange, lit }: { value: number; onChange: (v: number) => void; lit: boolean }) {
  const drag = useRef<{ y: number; v: number } | null>(null)
  const a = (-135 + value * 270) * (Math.PI / 180)
  return (
    <svg
      width={22}
      height={22}
      style={{ cursor: 'ns-resize', flexShrink: 0 }}
      onPointerDown={(e) => {
        ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, v: value }
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onChange(Math.max(0, Math.min(1, drag.current.v + (drag.current.y - e.clientY) / (e.shiftKey ? 800 : 150))))
      }}
      onPointerUp={() => (drag.current = null)}
      onWheel={(e) => onChange(Math.max(0, Math.min(1, value - Math.sign(e.deltaY) * 0.04)))}
    >
      <title>Effect depth</title>
      <circle cx={11} cy={11} r={9.5} fill="#10131a" stroke={lit ? 'var(--deck)' : '#3a4250'} />
      <line
        x1={11}
        y1={11}
        x2={11 + Math.sin(a) * 8}
        y2={11 - Math.cos(a) * 8}
        stroke="#e8ebf1"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}

// ------------------------------------------------------------------ tempo

function TempoColumn({ d }: { d: number }) {
  const s = useDecks((st) => st.decks[d])
  const range = s.tempoRange
  const value = (s.tempo + range) / (2 * range) // 0..1, 0 = slowest
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 62 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <span
          className="label clickable"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleLabel({ kind: 'tempo', deck: d })
          }}
          title="Click to reset tempo to 0 (click again to restore)"
        >
          Tempo
        </span>
      </div>
      {/* Like hardware: pushing the tempo fader DOWN (towards you) makes it faster. */}
      <Fader
        vertical
        invert
        length={118}
        thickness={30}
        value={value}
        center
        color="var(--deck)"
        defaultValue={0.5}
        fine={8}
        title="Tempo (down = faster). Shift for fine, double-click to reset"
        onChange={(v) => D.setTempo(d, v * 2 * range - range)}
      />
      <div className="mono" style={{ fontSize: 11, color: s.tempo === 0 ? 'var(--text-dim)' : 'var(--text)' }}>
        {s.tempo >= 0 ? '+' : ''}
        {(s.tempo * 100).toFixed(2)}%
      </div>
      <Btn
        style={{ minHeight: 18, padding: '0 4px', fontSize: 9, width: 58 }}
        title="Tempo fader range"
        onPress={() => D.setTempoRange(d, TEMPO_RANGES[(TEMPO_RANGES.indexOf(range) + 1) % TEMPO_RANGES.length])}
      >
        ±{Math.round(range * 100)}%
      </Btn>
      <Btn
        lit={s.sync}
        color="var(--deck)"
        style={{ width: 58 }}
        onPress={() => D.toggleSync(d)}
        title="Beat sync to the other deck"
      >
        SYNC
      </Btn>
      <Btn
        lit={s.master}
        color="var(--deck)"
        style={{ width: 58 }}
        onPress={() => D.makeMaster(d)}
        title="Make this the tempo master"
      >
        MASTER
      </Btn>
    </div>
  )
}

// ------------------------------------------------------------------ transport

function Transport({ d }: { d: number }) {
  const playing = useDecks((s) => s.decks[d].playing)
  const big: CSSProperties = { width: 52, height: 40, borderRadius: '50%', fontSize: 15 }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Btn style={{ width: 34, height: 28 }} onPress={() => D.jumpToStart(d)} title="Jump to start">
        ⏮
      </Btn>
      <Btn style={big} color="#ffb547" onPress={() => D.cueDown(d)} onRelease={() => D.cueUp(d)} title="Cue">
        CUE
      </Btn>
      <Btn style={big} lit={playing} color="var(--ok)" onPress={() => D.togglePlay(d)} title="Play / pause">
        {playing ? '❚❚' : '▶'}
      </Btn>
    </div>
  )
}

// ------------------------------------------------------------------ loops

function LoopRow({ d }: { d: number }) {
  const loop = useDecks((s) => s.decks[d].loop)
  const grid = useDecks((s) => s.decks[d].grid)
  let lenText = '—'
  if (loop && loop.end != null) {
    const beats = grid ? (loop.end - loop.start) / (60 / grid.bpm) : 0
    lenText = grid
      ? beats >= 1
        ? `${+beats.toFixed(2)}`
        : `1/${Math.round(1 / beats)}`
      : `${(loop.end - loop.start).toFixed(2)}s`
  }
  const active = !!loop?.active
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <span className="label" style={{ width: 30 }}>
        Loop
      </span>
      <Btn lit={!!loop && loop.end == null} color="#ffbe28" onPress={() => D.loopIn(d)}>
        IN
      </Btn>
      <Btn onPress={() => D.loopOut(d)}>OUT</Btn>
      <Btn lit={active} color="#ffbe28" onPress={() => D.reloop(d)} title="Reloop / exit loop">
        {active ? 'EXIT' : 'RELOOP'}
      </Btn>
      <Btn onPress={() => D.autoLoop(d, 4)} title="Loop 4 beats from the current beat">
        4 BEAT
      </Btn>
      <Btn onPress={() => D.loopHalve(d)}>½</Btn>
      <Btn onPress={() => D.loopDouble(d)}>×2</Btn>
      <span
        className="mono"
        style={{ marginLeft: 'auto', color: active ? '#ffbe28' : 'var(--text-faint)', fontSize: 11 }}
      >
        {lenText}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ pads

const MODES: [PadMode, string][] = [
  ['hotcue', 'HOT CUE'],
  ['beatjump', 'BEAT JUMP'],
  ['padfx', 'PAD FX'],
  ['sampler', 'SAMPLER']
]

function Pads({ d }: { d: number }) {
  const s = useDecks((st) => st.decks[d])
  useUi((u) => u.samplerVersion) // re-render when samples change
  const samplerInfo = s.padMode === 'sampler' ? getEngine().sampler.info() : []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        {MODES.map(([m, label]) => (
          <Btn
            key={m}
            lit={s.padMode === m}
            color="var(--deck)"
            style={{ fontSize: 9 }}
            onPress={() => D.setPadMode(d, m)}
          >
            {label}
          </Btn>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
        {Array.from({ length: 8 }, (_, i) => {
          let label = ''
          let color: string | undefined
          let lit = false
          if (s.padMode === 'hotcue') {
            const hc = s.hotCues[i]
            label = hc ? `${i + 1}  ${formatTime(hc.time, false)}` : `${i + 1}`
            color = hc ? hc.color : undefined
            lit = !!hc
          } else if (s.padMode === 'beatjump') {
            const b = D.BEAT_JUMPS[i]
            label = b < 0 ? `◀ ${-b}` : `${b} ▶`
          } else if (s.padMode === 'padfx') {
            label = D.PAD_FX[i].label
          } else {
            label = samplerInfo[d * 8 + i]?.name || '—'
          }
          return (
            <div
              key={i}
              onDragOver={(e) => {
                if (s.padMode === 'sampler') e.preventDefault()
              }}
              onDrop={(e) => {
                if (s.padMode !== 'sampler') return
                const ids = readDraggedTracks(e)
                if (!ids.length) return
                e.preventDefault()
                e.stopPropagation()
                void assignSample(d * 8 + i, ids[0])
              }}
            >
              <Btn
                lit={lit}
                color={color}
                style={{ height: 36, fontSize: 10, borderRadius: 6, width: '100%', overflow: 'hidden' }}
                title={
                  s.padMode === 'hotcue'
                    ? 'Set / jump to hot cue. Right-click or Shift-click deletes.'
                    : s.padMode === 'sampler'
                      ? 'Play sample. Right-click stops it. Drag a track from the library here to use it as a sample.'
                      : undefined
                }
                onPress={(e) => D.padDown(d, i, e.shiftKey)}
                onRelease={() => D.padUp(d, i)}
              >
                <span
                  onContextMenu={(e) => {
                    e.preventDefault()
                    D.padDown(d, i, true)
                  }}
                  style={{ width: '100%' }}
                >
                  {label}
                </span>
              </Btn>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToggleRow({ d }: { d: number }) {
  const s = useDecks((st) => st.decks[d])
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <Btn
        lit={s.quantize}
        color="var(--accent)"
        onPress={() => D.toggleQuantize(d)}
        title="Snap cues and loops to the beat grid"
      >
        QUANTIZE
      </Btn>
      <Btn
        lit={s.slip}
        color="var(--accent)"
        onPress={() => D.toggleSlip(d)}
        title="Slip: after a loop/scratch, carry on as if it never happened"
      >
        SLIP
      </Btn>
      <Btn
        lit={s.vinyl}
        color="var(--accent)"
        onPress={() => D.toggleVinyl(d)}
        title="Vinyl mode: the jog platter scratches"
      >
        VINYL
      </Btn>
      <Btn
        lit={s.keyLock}
        color="var(--accent)"
        onPress={() => D.toggleKeyLock(d)}
        title="Key lock: change tempo without changing pitch"
      >
        KEY LOCK
      </Btn>
      <Btn lit={s.gridEdit} color="var(--warn)" onPress={() => D.toggleGridEdit(d)} title="Edit beat grid, BPM and key">
        GRID
      </Btn>
    </div>
  )
}
