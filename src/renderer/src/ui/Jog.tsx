// The jog wheel, drawn on a canvas.
//  - Top platter (inner disc): grabs the "record". In vinyl mode you can scratch;
//    the marker turns at 33⅓ RPM (one turn = 1.8 s of audio) like a real record.
//  - Outer ring: spinning it briefly speeds up / slows down the track (pitch bend),
//    which is how you nudge two tracks into phase while beat-matching.
// The coloured arc around the edge shows how far through the track you are.

import { useEffect, useRef } from 'react'
import { deck } from '../state/decks'
import { getEngine } from '../audio/engine'
import * as D from '../control/deck'
import { fitCanvas, onFrame } from './frameLoop'

const COLORS = ['#2fd6b5', '#ff7a59']

export function Jog({ d, size }: { d: number; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const touch = useRef<{ zone: 'platter' | 'ring'; angle: number; time: number } | null>(null)

  useEffect(() => {
    const c = canvas.current!
    const g = c.getContext('2d')!
    return onFrame(() => {
      fitCanvas(c)
      const W = c.width
      const dpr = window.devicePixelRatio || 1
      const cx = W / 2
      const R = W / 2 - 2 * dpr
      const platterR = R * 0.78
      const s = deck(d)
      g.clearRect(0, 0, W, W)

      // outer ring with grip ridges
      g.beginPath()
      g.arc(cx, cx, R, 0, Math.PI * 2)
      g.fillStyle = touch.current?.zone === 'ring' ? '#2a303c' : '#1c2028'
      g.fill()
      g.strokeStyle = '#11141a'
      g.lineWidth = 1.5 * dpr
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2
        g.beginPath()
        g.moveTo(cx + Math.cos(a) * (platterR + 4 * dpr), cx + Math.sin(a) * (platterR + 4 * dpr))
        g.lineTo(cx + Math.cos(a) * (R - 2 * dpr), cx + Math.sin(a) * (R - 2 * dpr))
        g.stroke()
      }

      const p = getEngine().channels[d].player
      const pos = s.trackId != null ? p.posHeard() : 0
      // progress arc
      if (s.trackId != null && s.duration > 0) {
        const frac = Math.max(0, Math.min(1, pos / s.duration))
        g.beginPath()
        g.arc(cx, cx, platterR + 2 * dpr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
        g.strokeStyle = COLORS[d]
        g.lineWidth = 3 * dpr
        g.stroke()
        const cueA = -Math.PI / 2 + (s.cuePoint / s.duration) * Math.PI * 2
        g.fillStyle = '#ffb547'
        g.beginPath()
        g.arc(
          cx + Math.cos(cueA) * (platterR + 2 * dpr),
          cx + Math.sin(cueA) * (platterR + 2 * dpr),
          3 * dpr,
          0,
          Math.PI * 2
        )
        g.fill()
      }

      // platter
      const grad = g.createRadialGradient(cx - platterR * 0.3, cx - platterR * 0.3, platterR * 0.1, cx, cx, platterR)
      grad.addColorStop(0, touch.current?.zone === 'platter' ? '#3a4252' : '#2c323e')
      grad.addColorStop(1, '#14171d')
      g.beginPath()
      g.arc(cx, cx, platterR, 0, Math.PI * 2)
      g.fillStyle = grad
      g.fill()
      // grooves
      g.strokeStyle = 'rgba(255,255,255,0.035)'
      g.lineWidth = dpr
      for (let r = platterR * 0.45; r < platterR - 4 * dpr; r += 5 * dpr) {
        g.beginPath()
        g.arc(cx, cx, r, 0, Math.PI * 2)
        g.stroke()
      }
      // rotating marker
      const angle = (pos / 1.8) * Math.PI * 2 - Math.PI / 2
      g.strokeStyle = s.trackId != null ? '#e8ebf1' : '#3a4150'
      g.lineWidth = 3 * dpr
      g.lineCap = 'round'
      g.beginPath()
      g.moveTo(cx + Math.cos(angle) * platterR * 0.5, cx + Math.sin(angle) * platterR * 0.5)
      g.lineTo(cx + Math.cos(angle) * (platterR - 6 * dpr), cx + Math.sin(angle) * (platterR - 6 * dpr))
      g.stroke()

      // centre label
      g.beginPath()
      g.arc(cx, cx, platterR * 0.38, 0, Math.PI * 2)
      g.fillStyle = '#0f1116'
      g.fill()
      g.fillStyle = COLORS[d]
      g.font = `bold ${platterR * 0.3}px Segoe UI`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(String(d + 1), cx, cx - platterR * 0.04)
      g.fillStyle = '#6b7383'
      g.font = `${platterR * 0.1}px Segoe UI`
      g.fillText(s.vinyl ? 'VINYL' : 'CDJ', cx, cx + platterR * 0.22)
    })
  }, [d])

  const geometry = (e: React.PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect()
    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2
    return { r: Math.hypot(x, y) / (rect.width / 2), angle: Math.atan2(y, x) }
  }

  return (
    <canvas
      ref={canvas}
      style={{ width: size, height: size, display: 'block', cursor: 'grab', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const { r, angle } = geometry(e)
        if (r > 1) return
        ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        const zone = r < 0.78 ? 'platter' : 'ring'
        touch.current = { zone, angle, time: performance.now() }
        if (zone === 'platter') D.jogTouch(d, true)
      }}
      onPointerMove={(e) => {
        const t = touch.current
        if (!t) return
        const { angle } = geometry(e)
        let da = angle - t.angle
        if (da > Math.PI) da -= Math.PI * 2
        if (da < -Math.PI) da += Math.PI * 2
        const now = performance.now()
        const dt = (now - t.time) / 1000
        t.angle = angle
        t.time = now
        if (t.zone === 'platter') D.jogTurn(d, da, dt)
        else D.jogBend(d, da, dt)
      }}
      onPointerUp={() => {
        if (touch.current?.zone === 'platter') D.jogTouch(d, false)
        touch.current = null
      }}
      onWheel={(e) => D.jogBend(d, -Math.sign(e.deltaY) * 0.12, 0.016)}
    />
  )
}
