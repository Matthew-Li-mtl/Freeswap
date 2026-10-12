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
// This is the hottest loop of the whole analysis (6 filters x every sample), so the six
// biquads are written out inline with their state in local variables: no function calls, no
// intermediate buffers, a single pass over the signal.
//
// Column i covers samples floor(i*sr/150) .. floor((i+1)*sr/150). Using the exact fractional
// rate (rather than a rounded "samples per column") keeps column i at time i/150 s even at
// the end of a 2-hour mix.

import { WAVEFORM_RATE } from '../../../shared/types'
import { highpass, lowpass } from './dsp'

function toByte(v: number): number {
  return Math.round(Math.min(1, v) * 255)
}

/** Flush denormal-range filter state to zero (see Biquad.process). */
function flush(v: number): number {
  return v > -1e-30 && v < 1e-30 ? 0 : v
}

/**
 * @param x          mono signal
 * @param sampleRate rate of `x`
 * @param duration   track duration in seconds (decides the column count; may slightly exceed
 *                   x.length / sampleRate when x was decimated)
 */
export function computeWaveform(x: Float32Array, sampleRate: number, duration: number): Uint8Array {
  const columns = Math.max(0, Math.ceil(duration * WAVEFORM_RATE - 1e-9))
  const out = new Uint8Array(columns * 4)
  if (columns === 0 || x.length === 0) return out

  const L = lowpass(200, sampleRate)
  const H = highpass(2500, sampleRate)
  const MH = highpass(200, sampleRate)
  const ML = lowpass(2500, sampleRate)
  const { b0: lb0, b1: lb1, b2: lb2, a1: la1, a2: la2 } = L
  const { b0: hb0, b1: hb1, b2: hb2, a1: ha1, a2: ha2 } = H
  const { b0: pb0, b1: pb1, b2: pb2, a1: pa1, a2: pa2 } = MH
  const { b0: qb0, b1: qb1, b2: qb2, a1: qa1, a2: qa2 } = ML
  // Transposed direct form II state (two values per biquad).
  let l1 = 0,
    l2 = 0,
    l3 = 0,
    l4 = 0 // low: two sections
  let h1 = 0,
    h2 = 0,
    h3 = 0,
    h4 = 0 // high: two sections
  let m1 = 0,
    m2 = 0,
    m3 = 0,
    m4 = 0 // mid: HP section then LP section

  let a = 0
  for (let c = 0; c < columns; c++) {
    const b = Math.min(x.length, Math.floor(((c + 1) * sampleRate) / WAVEFORM_RATE))
    let pl = 0
    let pm = 0
    let ph = 0
    let pk = 0
    for (let i = a; i < b; i++) {
      const v = x[i]
      // low
      const y1 = lb0 * v + l1
      l1 = lb1 * v - la1 * y1 + l2
      l2 = lb2 * v - la2 * y1
      const yl = lb0 * y1 + l3
      l3 = lb1 * y1 - la1 * yl + l4
      l4 = lb2 * y1 - la2 * yl
      // high
      const y2 = hb0 * v + h1
      h1 = hb1 * v - ha1 * y2 + h2
      h2 = hb2 * v - ha2 * y2
      const yh = hb0 * y2 + h3
      h3 = hb1 * y2 - ha1 * yh + h4
      h4 = hb2 * y2 - ha2 * yh
      // mid
      const y3 = pb0 * v + m1
      m1 = pb1 * v - pa1 * y3 + m2
      m2 = pb2 * v - pa2 * y3
      const ym = qb0 * y3 + m3
      m3 = qb1 * y3 - qa1 * ym + m4
      m4 = qb2 * y3 - qa2 * ym
      // running peaks of |value|
      const al = yl < 0 ? -yl : yl
      const am = ym < 0 ? -ym : ym
      const ah = yh < 0 ? -yh : yh
      const av = v < 0 ? -v : v
      if (al > pl) pl = al
      if (am > pm) pm = am
      if (ah > ph) ph = ah
      if (av > pk) pk = av
    }
    const o = c * 4
    out[o] = toByte(pl)
    out[o + 1] = toByte(pm)
    out[o + 2] = toByte(ph)
    out[o + 3] = toByte(pk)
    a = b
    if ((c & 63) === 63) {
      l1 = flush(l1)
      l2 = flush(l2)
      l3 = flush(l3)
      l4 = flush(l4)
      h1 = flush(h1)
      h2 = flush(h2)
      h3 = flush(h3)
      h4 = flush(h4)
      m1 = flush(m1)
      m2 = flush(m2)
      m3 = flush(m3)
      m4 = flush(m4)
    }
  }
  return out
}
