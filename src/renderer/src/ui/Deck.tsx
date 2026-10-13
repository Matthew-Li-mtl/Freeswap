// One deck panel: track info, overview waveform, effects, jog, tempo, loops, pads, transport.

import { useEffect, useRef, type CSSProperties } from 'react'
import { formatKey } from '@shared/musicKey'
import { TEMPO_RANGES } from '@shared/types'
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
import { useKeyHint } from './keyHint'
import { GridEditor } from './GridEditor'

const COLORS = ['#2fd6b5', '#ff7a59']

export function Deck({ d }: { d: number }) {
  const color = COLORS[d]
  const mirrored = d === 1
  const gridEdit = useDecks((s) => s.decks[d].gridEdit)
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
      {gridEdit ? <GridEditor d={d} /> : <FxRow d={d} />}
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
          title={track ? 'Click to edit title / artist' : undefined}
          onMouseDown={() => track && useUi.setState({ editTrack: track.id })}
          style={{
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: track ? 'pointer' : undefined
          }}
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
  const hint = useKeyHint()
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
              title={hint('Switch this effect on / off', `d${d}.fx${i + 1}.toggle`)}
            >
              FX{i + 1}
            </Btn>
            <select
              value={f.type}
              tabIndex={-1}
              style={{ flex: 1, minWidth: 0, padding: '1px 2px', fontSize: 11 }}
              onChange={(e) => D.setFxType(d, i, e.target.value as typeof f.type)}
              title={hint('Effect (next effect)', `d${d}.fx${i + 1}.next`)}
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
                title={hint('Length in beats (cycle)', `d${d}.fx${i + 1}.length`)}
              >
                {BEAT_DIVISIONS.map((b) => (
                  <option key={b} value={b}>
                    {formatBeats(b)}
                  </option>
                ))}
              </select>
            )}
            <MiniKnob
              value={f.depth}
              onChange={(v) => D.setFxDepth(d, i, v)}
              lit={f.enabled}
              title={hint('Effect depth (right-click resets)', [`d${d}.fx${i + 1}.up`, `d${d}.fx${i + 1}.down`])}
            />
          </div>
        )
      })}
    </div>
  )
}

function MiniKnob({
  value,
  onChange,
  lit,
  title
}: {
  value: number
  onChange: (v: number) => void
  lit: boolean
  title: string
}) {
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
      onContextMenu={(e) => {
        e.preventDefault()
        onChange(0.5)
      }}
    >
      <title>{title}</title>
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
  const hint = useKeyHint()
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
          title={hint('Click to reset tempo to 0 (click again to restore)', `d${d}.tempo.reset`)}
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
        title={hint('Tempo (down = faster). Shift = fine, right-click resets', [`d${d}.tempo.down`, `d${d}.tempo.up`])}
        onChange={(v) => D.setTempo(d, v * 2 * range - range)}
      />
      <div className="mono" style={{ fontSize: 11, color: s.tempo === 0 ? 'var(--text-dim)' : 'var(--text)' }}>
        {s.tempo >= 0 ? '+' : ''}
        {(s.tempo * 100).toFixed(2)}%
      </div>
      <Btn
        style={{ minHeight: 18, padding: '0 4px', fontSize: 9, width: 58 }}
        title={hint('Tempo fader range', `d${d}.tempoRange`)}
        onPress={() => D.setTempoRange(d, TEMPO_RANGES[(TEMPO_RANGES.indexOf(range) + 1) % TEMPO_RANGES.length])}
      >
        ±{Math.round(range * 100)}%
      </Btn>
      <Btn
        lit={s.sync}
        color="var(--deck)"
        style={{ width: 58 }}
        onPress={() => D.toggleSync(d)}
        title={hint('Beat sync to the other deck', `d${d}.sync`)}
      >
        SYNC
      </Btn>
      <Btn
        lit={s.master}
        color="var(--deck)"
        style={{ width: 58 }}
        onPress={() => D.makeMaster(d)}
        title={hint('Make this the tempo master', `d${d}.master`)}
      >
        MASTER
      </Btn>
    </div>
  )
}

// ------------------------------------------------------------------ transport

function Transport({ d }: { d: number }) {
  const playing = useDecks((s) => s.decks[d].playing)
  const hint = useKeyHint()
  const big: CSSProperties = { width: 58, height: 38, borderRadius: 8, fontSize: 14 }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Btn
        style={{ width: 34, height: 28 }}
        onPress={() => D.jumpToStart(d)}
        title={hint('Jump to start', `d${d}.start`)}
      >
        ⏮
      </Btn>
      <Btn
        style={big}
        color="#ffb547"
        onPress={() => D.cueDown(d)}
        onRelease={() => D.cueUp(d)}
        title={hint('Cue: set / return to the cue point, hold to preview', `d${d}.cue`)}
      >
        CUE
      </Btn>
      <Btn
        style={big}
        lit={playing}
        color="var(--ok)"
        onPress={() => D.togglePlay(d)}
        title={hint('Play / pause', `d${d}.play`)}
      >
        {playing ? '❚❚' : '▶'}
      </Btn>
    </div>
  )
}

// ------------------------------------------------------------------ loops

function LoopRow({ d }: { d: number }) {
  const loop = useDecks((s) => s.decks[d].loop)
  const grid = useDecks((s) => s.decks[d].grid)
  const anchor = useDecks((s) => s.decks[d].loopAnchor)
  const hint = useKeyHint()
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
      <Btn
        lit={!!loop && loop.end == null}
        color="#ffbe28"
        onPress={() => D.loopIn(d)}
        title={hint('Loop in: mark the loop start', `d${d}.loopIn`)}
      >
        IN
      </Btn>
      <Btn onPress={() => D.loopOut(d)} title={hint('Loop out: mark the end and start looping', `d${d}.loopOut`)}>
        OUT
      </Btn>
      <Btn lit={active} color="#ffbe28" onPress={() => D.reloop(d)} title={hint('Reloop / exit loop', `d${d}.reloop`)}>
        {active ? 'EXIT' : 'RELOOP'}
      </Btn>
      <Btn onPress={() => D.autoLoop(d, 4)} title={hint('Loop 4 beats from the current beat', `d${d}.autoLoop`)}>
        4 BEAT
      </Btn>
      <Btn onPress={() => D.loopHalve(d)} title={hint('Halve the loop', `d${d}.loopHalve`)}>
        ½
      </Btn>
      <Btn onPress={() => D.loopDouble(d)} title={hint('Double the loop', `d${d}.loopDouble`)}>
        ×2
      </Btn>
      <Btn
        style={{ padding: '0 5px', fontSize: 9 }}
        onPress={() => D.toggleLoopAnchor(d)}
        title={hint(
          anchor === 'start'
            ? '½ / ×2 keep the loop START fixed and move the end. Click to keep the END fixed instead.'
            : '½ / ×2 keep the loop END fixed and move the start. Click to keep the START fixed instead.',
          `d${d}.loopAnchor`
        )}
      >
        {anchor === 'start' ? '|◀ START' : 'END ▶|'}
      </Btn>
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
  const hint = useKeyHint()
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
            title={hint(`Pad mode: ${label.toLowerCase()}`, `d${d}.mode.${m}`)}
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
                title={hint(
                  s.padMode === 'hotcue'
                    ? 'Set / jump to hot cue. Right-click or Shift-click deletes.'
                    : s.padMode === 'sampler'
                      ? 'Play sample. Right-click stops it. Drag a track from the library here to use it as a sample.'
                      : s.padMode === 'padfx'
                        ? 'Hold for the effect'
                        : 'Jump by beats',
                  `d${d}.pad${i + 1}`
                )}
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
  const hint = useKeyHint()
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <Btn
        lit={s.quantize}
        color="var(--accent)"
        onPress={() => D.toggleQuantize(d)}
        title={hint('Snap cues and loops to the beat grid', `d${d}.quantize`)}
      >
        QUANTIZE
      </Btn>
      <Btn
        lit={s.slip}
        color="var(--accent)"
        onPress={() => D.toggleSlip(d)}
        title={hint('Slip: after a loop/scratch, carry on as if it never happened', `d${d}.slip`)}
      >
        SLIP
      </Btn>
      <Btn
        lit={s.vinyl}
        color="var(--accent)"
        onPress={() => D.toggleVinyl(d)}
        title={hint('Vinyl mode: the jog platter scratches', `d${d}.vinyl`)}
      >
        VINYL
      </Btn>
      <Btn
        lit={s.keyLock}
        color="var(--accent)"
        onPress={() => D.toggleKeyLock(d)}
        title={hint('Key lock: change tempo without changing pitch', `d${d}.keyLock`)}
      >
        KEY LOCK
      </Btn>
      <Btn
        lit={s.gridEdit}
        color="var(--warn)"
        onPress={() => D.toggleGridEdit(d)}
        title={hint('Edit beat grid, BPM and key', `d${d}.grid.edit`)}
      >
        GRID
      </Btn>
      <TapButton d={d} />
    </div>
  )
}

/** Tap along with the beat: sets the BPM and (while playing) where the beats are. */
export function TapButton({ d }: { d: number }) {
  const tapBpm = useDecks((st) => st.decks[d].tapBpm)
  const tapCount = useDecks((st) => st.decks[d].tapCount)
  const hint = useKeyHint()
  const tapping = tapCount > 0
  return (
    <Btn
      lit={tapping}
      color="var(--warn)"
      style={{ minWidth: 64 }}
      onPress={() => D.tapTempo(d)}
      title={hint(
        'Tap along with the beat (4+ taps). While playing, your first tap becomes beat 1 and the grid lines up with your taps.',
        `d${d}.grid.tap`
      )}
    >
      {tapping ? `${tapBpm ? tapBpm.toFixed(1) : '…'} (${tapCount})` : 'TAP'}
    </Btn>
  )
}
