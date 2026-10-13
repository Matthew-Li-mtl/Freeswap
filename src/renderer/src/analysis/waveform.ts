// Waveform overview data.
//
// The UI draws a coloured waveform where each vertical column shows how much bass, mids and
// treble there is at that moment. We precompute WAVEFORM_RATE (150) columns per second; each
// column is 4 bytes: [low, mid, high, peak], every value being the largest |sample| inside the
// column (a linear amplitude, 1.0 = full scale) scaled to 0..255.
//
// Band split (crossovers at 200 Hz and 2.5 kHz):
//   low  = 4th-order Linkwitz-Riley low-pass  @ 200 Hz  (two Butterworth biquads)
//   high = 4th-order Linkwitz-Riley high-pass @ 2.5 kHz (two Butterworth biquads)
//   mid  = 2nd-order Butterworth high-pass @ 200 Hz -> 2nd-order low-pass @ 2.5 kHz
// The mid band uses gentler 12 dB/octave slopes to save two biquads; for a display that
// only shows peak levels this is indistinguishable.
//
// Two sample rates: the overall peak and the high band need the full ~22 kHz signal, but the
// low and mid bands contain nothing above ~5 kHz, so they are filtered from the half-rate
// (~11 kHz) copy that onset and key analysis use anyway. That halves their cost. (A band
// limited signal's peak is found well enough at a sample rate a few times its top frequency.)
//
// The biquads are written out inline with their state in local variables: no function calls,
// no intermediate buffers, a single pass over each signal.
//
// Column i covers samples floor(i*sr/150) .. floor((i+1)*sr/150) at each rate. Using the exact
// fractional rate (rather than a rounded "samples per column") keeps column i at time i/150 s
// even at the end of a 2-hour mix.

import { WAVEFORM_RATE } from '../../../shared/types'
import { decimate2, highpass, lowpass } from './dsp'

function toByte(v: number): number {
  return Math.round(Math.min(1, v) * 255)
}

/** Flush denormal-range filter state to zero (see Biquad.process). */
function flush(v: number): number {
  return v > -1e-30 && v < 1e-30 ? 0 : v
}

/** End sample (exclusive) of column c at rate `sr`. */
function columnEnd(c: number, sr: number, length: number): number {
  return Math.min(length, Math.floor(((c + 1) * sr) / WAVEFORM_RATE))
}

/** Peak and high band from the full-rate signal into lanes 3 and 2. */
function fullRateLanes(x: Float32Array, sr: number, columns: number, out: Uint8Array): void {
  const { b0, b1, b2, a1, a2 } = highpass(2500, sr)
  let h1 = 0
  let h2 = 0
  let h3 = 0
  let h4 = 0
  let a = 0
  for (let c = 0; c < columns; c++) {
    const b = columnEnd(c, sr, x.length)
    let ph = 0
    let pk = 0
    for (let i = a; i < b; i++) {
      const v = x[i]
      const y = b0 * v + h1
      h1 = b1 * v - a1 * y + h2
      h2 = b2 * v - a2 * y
      const yh = b0 * y + h3
      h3 = b1 * y - a1 * yh + h4
      h4 = b2 * y - a2 * yh
      // Math.abs/Math.max compile to branch-free instructions; an `x < 0 ? -x : x` branch would
      // be mispredicted about half the time on audio.
      ph = Math.max(ph, Math.abs(yh))
      pk = Math.max(pk, Math.abs(v))
    }
    out[c * 4 + 2] = toByte(ph)
    out[c * 4 + 3] = toByte(pk)
    a = b
    if ((c & 63) === 63) {
      h1 = flush(h1)
      h2 = flush(h2)
      h3 = flush(h3)
      h4 = flush(h4)
    }
  }
}

/** Low and mid bands from the half-rate signal into lanes 0 and 1. */
function halfRateLanes(y: Float32Array, sr: number, columns: number, out: Uint8Array): void {
  const { b0: lb0, b1: lb1, b2: lb2, a1: la1, a2: la2 } = lowpass(200, sr)
  const { b0: pb0, b1: pb1, b2: pb2, a1: pa1, a2: pa2 } = highpass(200, sr)
  const { b0: qb0, b1: qb1, b2: qb2, a1: qa1, a2: qa2 } = lowpass(2500, sr)
  let l1 = 0
  let l2 = 0
  let l3 = 0
  let l4 = 0
  let m1 = 0
  let m2 = 0
  let m3 = 0
  let m4 = 0
  let a = 0
  for (let c = 0; c < columns; c++) {
    const b = columnEnd(c, sr, y.length)
    let pl = 0
    let pm = 0
    for (let i = a; i < b; i++) {
      const v = y[i]
      // low: two identical Butterworth sections
      const y1 = lb0 * v + l1
      l1 = lb1 * v - la1 * y1 + l2
      l2 = lb2 * v - la2 * y1
      const yl = lb0 * y1 + l3
      l3 = lb1 * y1 - la1 * yl + l4
      l4 = lb2 * y1 - la2 * yl
      // mid: high-pass section then low-pass section
      const y3 = pb0 * v + m1
      m1 = pb1 * v - pa1 * y3 + m2
      m2 = pb2 * v - pa2 * y3
      const ym = qb0 * y3 + m3
      m3 = qb1 * y3 - qa1 * ym + m4
      m4 = qb2 * y3 - qa2 * ym
      pl = Math.max(pl, Math.abs(yl))
      pm = Math.max(pm, Math.abs(ym))
    }
    out[c * 4] = toByte(pl)
    out[c * 4 + 1] = toByte(pm)
    a = b
    if ((c & 63) === 63) {
      l1 = flush(l1)
      l2 = flush(l2)
      l3 = flush(l3)
      l4 = flush(l4)
      m1 = flush(m1)
      m2 = flush(m2)
      m3 = flush(m3)
      m4 = flush(m4)
    }
  }
}

/**
 * @param x          mono signal
 * @param sampleRate rate of `x`
 * @param duration   track duration in seconds (decides the column count; may slightly exceed
 *                   x.length / sampleRate when x was decimated)
 * @param half       `x` decimated by 2 (decimate2(x, 'fast')), if the caller already has it
 */
export function computeWaveform(
  x: Float32Array,
  sampleRate: number,
  duration: number,
  half?: Float32Array
): Uint8Array {
  const columns = Math.max(0, Math.ceil(duration * WAVEFORM_RATE - 1e-9))
  const out = new Uint8Array(columns * 4)
  if (columns === 0 || x.length === 0) return out
  fullRateLanes(x, sampleRate, columns, out)
  halfRateLanes(half ?? decimate2(x, 'fast'), sampleRate / 2, columns, out)
  return out
}
