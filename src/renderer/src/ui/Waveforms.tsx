// Waveform displays.
//
// Zoomed view: a few seconds around the playhead, scrolling as the track plays. Colours
// are drawn additively ("lighter" blending): lows in red, mids in green, highs in blue,
// so a bass-heavy kick looks red, a vocal looks green/yellow, and a full-range hit turns
// white. Beat markers are thin, bar markers (every 4 beats) medium, phrase markers
// (every 8 bars = 32 beats) thick.
//
// The horizontal axis is *real time*, not track time: a deck playing 5 % faster has its
// waveform squeezed by 5 %. That way, when two decks are beat-matched, their beat
// markers have the same spacing on screen and you can line them up by eye.

import { useEffect, useRef } from 'react'
import { WAVEFORM_RATE } from '@shared/types'
import type { DeckState } from '../state/decks'
import { deck, useDecks } from '../state/decks'
import { settings, updateSettings } from '../state/settings'
import { getEngine } from '../audio/engine'
import { getWaveform } from '../library/waveforms'
import * as D from '../control/deck'
import { fitCanvas, onFrame } from './frameLoop'
import { GridEditor } from './GridEditor'

const BAND_COLORS = ['rgb(255,52,40)', 'rgb(40,220,80)', 'rgb(60,130,255)']
const BAND_GAIN = [1.0, 1.5, 2.2]
const DECK_COLORS = ['#2fd6b5', '#ff7a59']

function drawBands(
  g: CanvasRenderingContext2D,
  data: Uint8Array,
  t0: number,
  t1: number,
  x0: number,
  pxPerSec: number,
  mid: number,
  half: number
): void {
  const cols = data.length / 4
  const colW = pxPerSec / WAVEFORM_RATE
  // When zoomed out, merge columns in fixed groups (aligned to multiples of `group`)
  // so the picture doesn't shimmer as it scrolls.
  const group = colW >= 1 ? 1 : Math.ceil(1 / colW)
  const iStart = Math.max(0, Math.floor((t0 * WAVEFORM_RATE) / group) * group)
  const iEnd = Math.min(cols, Math.ceil(t1 * WAVEFORM_RATE) + group)
  const w = Math.max(1, colW * group) + 0.6
  g.globalCompositeOperation = 'lighter'
  for (let b = 0; b < 3; b++) {
    g.beginPath()
    const gain = BAND_GAIN[b] / 255
    for (let i = iStart; i < iEnd; i += group) {
      let a = 0
      const jEnd = Math.min(cols, i + group)
      for (let j = i; j < jEnd; j++) {
        const v = data[j * 4 + b]
        if (v > a) a = v
      }
      if (a === 0) continue
      const h = Math.min(1, a * gain) * half
      const x = x0 + (i / WAVEFORM_RATE) * pxPerSec
      g.rect(x, mid - h, w, h * 2)
    }
    g.fillStyle = BAND_COLORS[b]
    g.fill()
  }
  g.globalCompositeOperation = 'source-over'
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

// ---------------------------------------------------------------- zoomed

export function ZoomedWaveform({ d }: { d: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const gridEdit = useDecks((s) => s.decks[d].gridEdit)
  const drag = useRef<{ x: number } | null>(null)

  useEffect(() => {
    const c = canvas.current!
    const g = c.getContext('2d')!
    return onFrame(() => {
      fitCanvas(c)
      const W = c.width
      const H = c.height
      const dpr = window.devicePixelRatio || 1
      g.fillStyle = '#08090c'
      g.fillRect(0, 0, W, H)
      const s = deck(d)
      const cx = Math.round(W / 2)
      if (s.trackId == null) {
        g.fillStyle = '#3b4250'
        g.font = `${12 * dpr}px Segoe UI`
        g.textAlign = 'center'
        g.fillText(`DECK ${d + 1} — drag a track here`, W / 2, H / 2 + 4 * dpr)
        return
      }
      const p = getEngine().channels[d].player
      const pos = p.posHeard()
      const rate = 1 + s.tempo
      const pxPerSec = W / (settings().waveformZoom * rate)
      const t0 = pos - cx / pxPerSec
      const t1 = pos + (W - cx) / pxPerSec
      const toX = (t: number) => cx + (t - pos) * pxPerSec
      const mid = H / 2
      const half = H / 2 - 3 * dpr

      // loop region (behind the waveform)
      if (s.loop && s.loop.end != null) {
        const xa = toX(s.loop.start)
        const xb = toX(s.loop.end)
        g.fillStyle = s.loop.active ? 'rgba(255,190,40,0.18)' : 'rgba(255,190,40,0.06)'
        g.fillRect(xa, 0, xb - xa, H)
      }

      const data = getWaveform(s.trackId)
      if (data) drawBands(g, data, t0, t1, toX(0), pxPerSec, mid, half)
      else {
        g.fillStyle = '#3b4250'
        g.font = `${11 * dpr}px Segoe UI`
        g.textAlign = 'center'
        g.fillText(s.loading ? 'Loading…' : 'Analysing…', W / 2, mid + 4 * dpr)
      }

      // dim what has already played
      g.fillStyle = 'rgba(8,9,12,0.35)'
      g.fillRect(0, 0, cx, H)

      drawGrid(g, s, t0, t1, toX, H, dpr, pxPerSec)

      // memory cue point
      g.fillStyle = '#ffb547'
      const xc = toX(s.cuePoint)
      g.fillRect(xc - dpr, 0, 2 * dpr, H)
      tri(g, xc, H, 6 * dpr, -1)

      // hot cues
      s.hotCues.forEach((h, i) => {
        if (!h) return
        const x = toX(h.time)
        if (x < -20 || x > W + 20) return
        g.fillStyle = h.color
        g.fillRect(x - dpr, 0, 2 * dpr, H)
        g.fillRect(x, 0, 14 * dpr, 13 * dpr)
        g.fillStyle = '#0d0f13'
        g.font = `bold ${10 * dpr}px Segoe UI`
        g.textAlign = 'center'
        g.fillText(String(i + 1), x + 7 * dpr, 10 * dpr)
      })

      // loop in/out markers
      if (s.loop) {
        g.fillStyle = '#ffbe28'
        g.fillRect(toX(s.loop.start) - dpr, 0, 2 * dpr, H)
        if (s.loop.end != null) g.fillRect(toX(s.loop.end) - dpr, 0, 2 * dpr, H)
      }

      // playhead
      g.fillStyle = DECK_COLORS[d]
      g.fillRect(cx - dpr, 0, 2 * dpr, H)
      tri(g, cx, 0, 6 * dpr, 1)
      tri(g, cx, H, 6 * dpr, -1)
    })
  }, [d])

  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <canvas
        ref={canvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
        onPointerDown={(e) => {
          if (e.button !== 0 || deck(d).trackId == null) return
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX }
          D.grabStart(d)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const c = canvas.current!
          const s = deck(d)
          const pxPerSecCss = c.clientWidth / (settings().waveformZoom * (1 + s.tempo))
          D.grabMove(d, -(e.clientX - drag.current.x) / pxPerSecCss)
          drag.current.x = e.clientX
        }}
        onPointerUp={() => {
          if (drag.current) D.grabEnd(d)
          drag.current = null
        }}
        onWheel={(e) => {
          const z = settings().waveformZoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15)
          void updateSettings({ waveformZoom: Math.max(2, Math.min(40, z)) })
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 6,
          top: 4,
          fontSize: 10,
          fontWeight: 700,
          color: DECK_COLORS[d],
          pointerEvents: 'none',
          letterSpacing: '0.1em'
        }}
      >
        {d + 1}
      </div>
      {gridEdit && <GridEditor d={d} />}
    </div>
  )
}

function tri(g: CanvasRenderingContext2D, x: number, y: number, size: number, dir: 1 | -1): void {
  g.beginPath()
  g.moveTo(x - size, y)
  g.lineTo(x + size, y)
  g.lineTo(x, y + size * dir)
  g.closePath()
  g.fill()
}

function drawGrid(
  g: CanvasRenderingContext2D,
  s: DeckState,
  t0: number,
  t1: number,
  toX: (t: number) => number,
  H: number,
  dpr: number,
  pxPerSec: number
): void {
  if (!s.grid) return
  const beat = 60 / s.grid.bpm
  const beatPx = beat * pxPerSec
  const k0 = Math.ceil((t0 - s.grid.anchor) / beat)
  const k1 = Math.floor((t1 - s.grid.anchor) / beat)
  for (let k = k0; k <= k1; k++) {
    const phrase = mod(k, 32) === 0
    const bar = mod(k, 4) === 0
    // Skip markers that would be too dense to read when zoomed far out.
    if (!bar && beatPx < 6 * dpr) continue
    if (!phrase && beatPx * 4 < 6 * dpr) continue
    const x = Math.round(toX(s.grid.anchor + k * beat))
    if (phrase) {
      g.fillStyle = 'rgba(255,255,255,0.85)'
      g.fillRect(x - 1.5 * dpr, 0, 3 * dpr, H)
      g.fillStyle = '#ff4d6d'
      g.fillRect(x - 1.5 * dpr, 0, 3 * dpr, 5 * dpr)
      g.fillRect(x - 1.5 * dpr, H - 5 * dpr, 3 * dpr, 5 * dpr)
    } else if (bar) {
      g.fillStyle = 'rgba(255,255,255,0.5)'
      g.fillRect(x - dpr, 0, 2 * dpr, H)
    } else {
      g.fillStyle = 'rgba(255,255,255,0.22)'
      g.fillRect(x - 0.5 * dpr, 0, Math.max(1, dpr), H)
    }
  }
}

// ---------------------------------------------------------------- overview

export function OverviewWaveform({ d }: { d: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const cache = useRef<{ key: string; img: HTMLCanvasElement } | null>(null)

  useEffect(() => {
    const c = canvas.current!
    const g = c.getContext('2d')!
    return onFrame(() => {
      fitCanvas(c)
      const W = c.width
      const H = c.height
      const dpr = window.devicePixelRatio || 1
      const s = deck(d)
      g.fillStyle = '#0a0b0f'
      g.fillRect(0, 0, W, H)
      if (s.trackId == null || !s.duration) return
      const data = getWaveform(s.trackId)
      const key = `${s.trackId}:${W}:${H}:${data ? data.length : 0}`
      if (data && cache.current?.key !== key) {
        // The whole-track picture never changes, so render it once to an offscreen canvas.
        const img = document.createElement('canvas')
        img.width = W
        img.height = H
        const ig = img.getContext('2d')!
        drawBands(ig, data, 0, s.duration, 0, W / s.duration, H / 2, H / 2 - dpr)
        cache.current = { key, img }
      }
      if (data && cache.current) g.drawImage(cache.current.img, 0, 0)

      const toX = (t: number) => (t / s.duration) * W
      const pos = getEngine().channels[d].player.posHeard()
      // phrase ticks along the bottom
      if (s.grid) {
        const phrase = (32 * 60) / s.grid.bpm
        g.fillStyle = 'rgba(255,255,255,0.35)'
        for (let t = s.grid.anchor; t < s.duration; t += phrase)
          g.fillRect(toX(t), H - 4 * dpr, Math.max(1, dpr), 4 * dpr)
      }
      // played part
      g.fillStyle = 'rgba(10,11,15,0.55)'
      g.fillRect(0, 0, toX(pos), H)
      if (s.loop && s.loop.end != null) {
        g.fillStyle = s.loop.active ? 'rgba(255,190,40,0.35)' : 'rgba(255,190,40,0.15)'
        g.fillRect(toX(s.loop.start), 0, Math.max(2, toX(s.loop.end) - toX(s.loop.start)), H)
      }
      g.fillStyle = '#ffb547'
      tri(g, toX(s.cuePoint), H, 5 * dpr, -1)
      s.hotCues.forEach((h) => {
        if (!h) return
        g.fillStyle = h.color
        tri(g, toX(h.time), 0, 5 * dpr, 1)
      })
      // remaining-time warning: flash the playhead in the last 30 s
      const warn = s.duration - pos < 30 && s.playing && Math.floor(performance.now() / 400) % 2 === 0
      g.fillStyle = warn ? '#ff4d6d' : '#ffffff'
      g.fillRect(toX(pos) - dpr, 0, 2 * dpr, H)
    })
  }, [d])

  const seek = (e: React.PointerEvent) => {
    const s = deck(d)
    if (s.trackId == null) return
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    D.seekTo(d, ((e.clientX - rect.left) / rect.width) * s.duration)
  }

  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden', borderRadius: 4 }}>
      <canvas
        ref={canvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'pointer' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          seek(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seek(e)
        }}
      />
    </div>
  )
}
