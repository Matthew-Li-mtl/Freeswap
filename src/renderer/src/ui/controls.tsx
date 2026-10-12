// Hardware-style controls: knobs, faders and buttons.
// They react on pointer DOWN (not click) so they feel instant, never take keyboard
// focus (so the space bar etc. never "presses" the last clicked button), and support
// fine adjustment with Shift, the mouse wheel, and double-click to reset.

import { useRef, type CSSProperties, type ReactNode } from 'react'

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

// ------------------------------------------------------------------ Btn

interface BtnProps {
  children: ReactNode
  lit?: boolean
  color?: string
  onPress?: (e: React.PointerEvent) => void
  onRelease?: () => void
  title?: string
  className?: string
  style?: CSSProperties
  disabled?: boolean
}

export function Btn({ children, lit, color, onPress, onRelease, title, className, style, disabled }: BtnProps) {
  const down = useRef(false)
  return (
    <button
      tabIndex={-1}
      title={title}
      className={`btn ${lit ? 'lit' : ''} ${disabled ? 'disabled' : ''} ${className ?? ''}`}
      style={{ ...(color ? ({ '--lit': color } as CSSProperties) : null), ...style }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        down.current = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        onPress?.(e)
      }}
      onPointerUp={() => {
        if (down.current) onRelease?.()
        down.current = false
      }}
      onPointerCancel={() => {
        if (down.current) onRelease?.()
        down.current = false
      }}
    >
      {children}
    </button>
  )
}

// ------------------------------------------------------------------ Knob

interface KnobProps {
  value: number // 0..1
  onChange: (v: number) => void
  label: string
  onLabel?: () => void
  killed?: boolean
  size?: number
  bipolar?: boolean
  defaultValue?: number
  color?: string
  title?: string
  display?: string
}

const START = -135
const SWEEP = 270

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 > a0 ? 1 : 0
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`
}

export function Knob({
  value,
  onChange,
  label,
  onLabel,
  killed,
  size = 38,
  bipolar,
  defaultValue = bipolar ? 0.5 : 0,
  color = 'var(--accent)',
  title,
  display
}: KnobProps) {
  const drag = useRef<{ y: number; v: number } | null>(null)
  const c = size / 2
  const r = size / 2 - 3
  const angle = START + clamp01(value) * SWEEP
  const from = bipolar ? 0 : START
  const [px, py] = polar(c, c, r - 6, angle)
  const [ix, iy] = polar(c, c, r * 0.32, angle)
  return (
    <div className="knob" title={title} style={{ width: Math.max(size, 44) }}>
      <div
        className={`label ${onLabel ? 'clickable' : ''} ${killed ? 'killed' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          if (e.button === 0) onLabel?.()
        }}
        title={onLabel ? 'Click to kill / reset' : undefined}
      >
        {label}
      </div>
      <svg
        width={size}
        height={size}
        style={{ cursor: 'ns-resize', display: 'block', opacity: killed ? 0.55 : 1 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, v: value }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const sens = e.shiftKey ? 1000 : 180
          onChange(clamp01(drag.current.v + (drag.current.y - e.clientY) / sens))
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => onChange(defaultValue)}
        onWheel={(e) => onChange(clamp01(value - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.03)))}
      >
        <circle cx={c} cy={c} r={r} fill="#10131a" stroke="#2f3644" strokeWidth={1} />
        <path d={arc(c, c, r - 1.5, START, START + SWEEP)} stroke="#2a303b" strokeWidth={3} fill="none" />
        {Math.abs(angle - from) > 0.5 && (
          <path
            d={arc(c, c, r - 1.5, Math.min(from, angle), Math.max(from, angle))}
            stroke={killed ? 'var(--danger)' : color}
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
          />
        )}
        <circle cx={c} cy={c} r={r - 6} fill="url(#knobface)" stroke="#3a4250" strokeWidth={1} />
        <line x1={ix} y1={iy} x2={px} y2={py} stroke="#e8ebf1" strokeWidth={2} strokeLinecap="round" />
        <defs>
          <radialGradient id="knobface" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#3a4150" />
            <stop offset="100%" stopColor="#1b1f27" />
          </radialGradient>
        </defs>
      </svg>
      {display != null && <div className="knob-value mono">{display}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ Fader

interface FaderProps {
  value: number // 0..1
  onChange: (v: number) => void
  vertical?: boolean
  length: number
  thickness?: number
  /** Vertical faders: true means top = 0 (used for tempo, where down = faster). */
  invert?: boolean
  defaultValue?: number
  color?: string
  center?: boolean
  title?: string
  fine?: number
}

export function Fader({
  value,
  onChange,
  vertical,
  length,
  thickness = 28,
  invert,
  defaultValue,
  color = 'var(--accent)',
  center,
  title,
  fine = 4
}: FaderProps) {
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; v: number } | null>(null)
  const cap = vertical ? 14 : 18
  const travel = length - cap
  // Position along the track in px from the top (vertical) or left (horizontal).
  const frac = vertical ? (invert ? value : 1 - value) : value
  const offset = clamp01(frac) * travel
  const toValue = (px: number) => {
    const f = clamp01(px / travel)
    return vertical ? (invert ? f : 1 - f) : f
  }
  return (
    <div
      ref={track}
      className="fader"
      title={title}
      style={{
        position: 'relative',
        width: vertical ? thickness : length,
        height: vertical ? length : thickness,
        cursor: vertical ? 'ns-resize' : 'ew-resize',
        touchAction: 'none'
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        const rect = track.current!.getBoundingClientRect()
        const p = vertical ? e.clientY - rect.top : e.clientX - rect.left
        const onCap = p >= offset - 2 && p <= offset + cap + 2
        if (!onCap) onChange(toValue(p - cap / 2))
        drag.current = { start: vertical ? e.clientY : e.clientX, v: onCap ? value : toValue(p - cap / 2) }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const delta = (vertical ? e.clientY : e.clientX) - drag.current.start
        const scale = e.shiftKey ? fine : 1
        const startPx = (vertical ? (invert ? drag.current.v : 1 - drag.current.v) : drag.current.v) * travel
        onChange(toValue(startPx + delta / scale))
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => defaultValue != null && onChange(defaultValue)}
      onWheel={(e) => {
        const step = (e.shiftKey ? 0.002 : 0.02) * Math.sign(e.deltaY)
        onChange(clamp01(value + (vertical && !invert ? -step : step)))
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: vertical ? thickness / 2 - 2 : cap / 2,
          top: vertical ? cap / 2 : thickness / 2 - 2,
          width: vertical ? 4 : travel,
          height: vertical ? travel : 4,
          background: '#07080b',
          borderRadius: 2,
          boxShadow: 'inset 0 0 0 1px #2a303b'
        }}
      />
      {center && (
        <div
          style={{
            position: 'absolute',
            left: vertical ? 2 : cap / 2 + travel / 2 - 1,
            top: vertical ? cap / 2 + travel / 2 - 1 : 2,
            width: vertical ? thickness - 4 : 2,
            height: vertical ? 2 : thickness - 4,
            background: '#3b4352'
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: vertical ? 0 : offset,
          top: vertical ? offset : 0,
          width: vertical ? thickness : cap,
          height: vertical ? cap : thickness,
          borderRadius: 3,
          background: 'linear-gradient(#4a5263, #262b35)',
          border: '1px solid #59627a',
          boxShadow: '0 2px 6px rgba(0,0,0,0.6)'
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: vertical ? 3 : cap / 2 - 1,
            top: vertical ? cap / 2 - 1 : 3,
            width: vertical ? thickness - 8 : 2,
            height: vertical ? 2 : thickness - 8,
            background: color
          }}
        />
      </div>
    </div>
  )
}
