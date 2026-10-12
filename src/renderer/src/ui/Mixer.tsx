// The mixer section between the decks: trim, EQ, filter, headphone cue and volume per
// channel, plus master, headphones, sampler volume and the crossfader.

import { useEffect, useRef } from 'react'
import { useDecks } from '../state/decks'
import { getEngine } from '../audio/engine'
import * as D from '../control/deck'
import * as M from '../control/mixer'
import { Btn, Fader, Knob } from './controls'
import { fitCanvas, onFrame } from './frameLoop'

const COLORS = ['#2fd6b5', '#ff7a59']

export function Mixer() {
  const m = useDecks((s) => s.mixer)
  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', padding: '6px 8px', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flex: 1, minHeight: 0 }}>
        <ChannelStrip d={0} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <Knob
            label="Master"
            value={m.master}
            defaultValue={0.8}
            onChange={M.setMasterVolume}
            onLabel={() => M.toggleLabel({ kind: 'master' })}
            display={m.master <= 0.001 ? '-∞' : `${((m.master - 0.8) * 30).toFixed(1)}dB`}
          />
          <div style={{ display: 'flex', gap: 3, height: 80, margin: '2px 0' }}>
            <Meter source="masterL" width={8} />
            <Meter source="masterR" width={8} />
          </div>
          <Knob
            label="HP Mix"
            size={32}
            value={m.hpMix}
            defaultValue={0.25}
            onChange={M.setHeadphoneMix}
            onLabel={() => M.toggleLabel({ kind: 'hpMix' })}
            title="Headphones: cue ← → master"
          />
          <Knob
            label="HP Level"
            size={32}
            value={m.hpLevel}
            defaultValue={0.7}
            onChange={M.setHeadphoneLevel}
            onLabel={() => M.toggleLabel({ kind: 'hpLevel' })}
          />
          <Knob
            label="Sampler"
            size={32}
            value={m.samplerVolume}
            defaultValue={0.7}
            onChange={M.setSamplerVolume}
            onLabel={() => M.toggleLabel({ kind: 'sampler' })}
          />
        </div>
        <ChannelStrip d={1} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
        <span
          className="label clickable"
          onMouseDown={(e) => {
            e.preventDefault()
            M.toggleLabel({ kind: 'crossfader' })
          }}
          title="Click to centre the crossfader"
        >
          X-Fade
        </span>
        <Fader length={200} thickness={26} value={m.crossfader} center defaultValue={0.5} onChange={M.setCrossfader} />
        <Btn
          style={{ fontSize: 9, padding: '0 5px' }}
          title="Crossfader curve: smooth blend or sharp cut (for scratching)"
          onPress={() => M.setCrossfaderCurve(m.crossfaderCurve === 'smooth' ? 'sharp' : 'smooth')}
        >
          {m.crossfaderCurve === 'smooth' ? 'SMOOTH' : 'SHARP'}
        </Btn>
      </div>
    </div>
  )
}

function ChannelStrip({ d }: { d: number }) {
  const s = useDecks((st) => st.decks[d])
  const color = COLORS[d]
  const lbl = (kind: 'trim' | 'filter' | 'fader') => () => M.toggleLabel({ kind, deck: d })
  // Knobs in one column, the channel fader + level meter in a tall column beside them
  // (on the side nearest the centre, so the two strips mirror each other).
  return (
    <div style={{ display: 'flex', flexDirection: d === 0 ? 'row' : 'row-reverse', gap: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
        <Knob
          label="Trim"
          size={30}
          value={(s.trim + 12) / 24}
          bipolar
          color={color}
          onChange={(v) => D.setTrim(d, v * 24 - 12)}
          onLabel={lbl('trim')}
          title={`Trim ${s.trim > 0 ? '+' : ''}${s.trim.toFixed(1)} dB (input gain)`}
        />
        {(['high', 'mid', 'low'] as const).map((band) => (
          <Knob
            key={band}
            label={band === 'high' ? 'High' : band === 'mid' ? 'Mid' : 'Low'}
            size={32}
            value={s.eq[band]}
            bipolar
            color={color}
            killed={s.kills[band]}
            onChange={(v) => D.setEq(d, band, v)}
            onLabel={() => D.toggleKill(d, band)}
          />
        ))}
        <Knob
          label="Filter"
          size={32}
          value={s.filter}
          bipolar
          color="var(--accent)"
          onChange={(v) => D.setFilter(d, v)}
          onLabel={lbl('filter')}
          title="Left: low-pass, right: high-pass"
        />
        <Btn
          lit={s.cue}
          color={color}
          style={{ width: 48, marginTop: 4 }}
          onPress={() => D.toggleCue(d)}
          title="Headphone cue"
        >
          🎧 CUE
        </Btn>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span
          className={`label clickable ${s.fader === 0 ? 'killed' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            lbl('fader')()
          }}
          title="Click to mute (click again to restore)"
        >
          Vol
        </span>
        <div style={{ display: 'flex', gap: 3, flexDirection: d === 0 ? 'row' : 'row-reverse' }}>
          <Fader
            vertical
            length={226}
            thickness={26}
            value={s.fader}
            color={color}
            defaultValue={1}
            onChange={(v) => D.setFader(d, v)}
          />
          <Meter source={d === 0 ? 'ch0' : 'ch1'} width={6} height={210} />
        </div>
      </div>
    </div>
  )
}

/**
 * Level meter. Reads the most recent block of samples from an AnalyserNode each frame,
 * takes the peak, converts it to decibels and draws a segmented bar with a peak hold.
 */
function Meter({
  source,
  width,
  height
}: {
  source: 'masterL' | 'masterR' | 'ch0' | 'ch1'
  width: number
  height?: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current!
    const g = c.getContext('2d')!
    const e = getEngine()
    const node =
      source === 'masterL'
        ? e.masterMeterL
        : source === 'masterR'
          ? e.masterMeterR
          : e.channels[source === 'ch0' ? 0 : 1].meter
    const buf = new Float32Array(node.fftSize)
    let level = 0
    let hold = 0
    let holdTime = 0
    return onFrame((now) => {
      fitCanvas(c)
      node.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i])
        if (v > peak) peak = v
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : -100
      const norm = Math.max(0, Math.min(1, (db + 48) / 48)) // -48 dB .. 0 dB
      // Fast attack, slow release, like a real meter's ballistics.
      level = norm > level ? norm : level * 0.92
      if (norm >= hold || now - holdTime > 1200) {
        hold = norm
        holdTime = now
      }
      const W = c.width
      const H = c.height
      g.clearRect(0, 0, W, H)
      const segs = 24
      const segH = H / segs
      for (let i = 0; i < segs; i++) {
        const f = (i + 1) / segs
        const on = f <= level + 1e-6
        g.fillStyle =
          f > 0.94 ? (on ? '#ff4d6d' : '#3a1820') : f > 0.8 ? (on ? '#ffd84d' : '#3a3418') : on ? '#4cd97b' : '#16301f'
        g.fillRect(0, H - (i + 1) * segH + 1, W, segH - 1.5)
      }
      g.fillStyle = '#ffffff'
      g.fillRect(0, H - hold * H, W, 1.5)
    })
  }, [source])
  return (
    <div style={{ position: 'relative', width, height: height ?? '100%', flexShrink: 0 }}>
      <canvas
        ref={canvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', borderRadius: 2 }}
      />
    </div>
  )
}

export { Meter }
