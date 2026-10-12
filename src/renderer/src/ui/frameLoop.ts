// One shared requestAnimationFrame loop for everything that animates (waveforms, jog
// wheels, meters, clocks). Components register a draw callback; nothing re-renders
// through React for per-frame updates.

type Draw = (now: number) => void

const draws = new Set<Draw>()
let running = false

function frame(now: number): void {
  for (const d of draws) {
    try {
      d(now)
    } catch (err) {
      console.error(err)
    }
  }
  if (draws.size) requestAnimationFrame(frame)
  else running = false
}

export function onFrame(draw: Draw): () => void {
  draws.add(draw)
  if (!running) {
    running = true
    requestAnimationFrame(frame)
  }
  return () => draws.delete(draw)
}

/** Size a canvas's backing store to its CSS size × devicePixelRatio. Returns true if resized. */
export function fitCanvas(c: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(c.clientWidth * dpr)
  const h = Math.round(c.clientHeight * dpr)
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    return true
  }
  return false
}

export function formatTime(sec: number, tenths = true): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return tenths ? `${base}.${Math.floor((sec * 10) % 10)}` : base
}
