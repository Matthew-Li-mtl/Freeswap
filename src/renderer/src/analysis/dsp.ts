// Small DSP toolbox: biquad (2nd-order IIR) filters and a 2x decimator.
//
// Biquads
// -------
// A biquad implements the difference equation
//   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
// i.e. the transfer function H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2).
// Coefficients come from Robert Bristow-Johnson's "Audio EQ Cookbook", the de-facto standard
// recipes that map (type, centre frequency, Q, gain) to b/a values via the bilinear transform.
// Cascading two identical 2nd-order Butterworth sections (Q = 1/sqrt(2)) gives a 4th-order
// Linkwitz-Riley filter (-6 dB at the crossover, 24 dB/octave), the classic crossover choice.
//
// We run them in "Transposed Direct Form II", which needs just two state variables per section
// and is numerically well behaved in floating point.
//
// Decimation
// ----------
// Halving the sample rate (44.1 -> 22.05 kHz) halves the cost of everything downstream. Before
// throwing away every other sample we must remove content above the new Nyquist frequency
// (fs/4 of the old rate), or it would "alias" (fold back) into the audible range. A half-band
// FIR filter is ideal: its cutoff is exactly fs/4, and every second coefficient is zero, so it
// costs about half the multiplications of a general FIR of the same length.

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function prewarp(freq: number, sampleRate: number, q: number): { cw: number; alpha: number; sw: number } {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.499)) / sampleRate
  const sw = Math.sin(w0)
  return { cw: Math.cos(w0), sw, alpha: sw / (2 * q) }
}

export function lowpass(freq: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cw, alpha } = prewarp(freq, sampleRate, q)
  return normalise((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)
}

export function highpass(freq: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cw, alpha } = prewarp(freq, sampleRate, q)
  return normalise((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)
}

/** Band-pass with 0 dB gain at the centre frequency. */
export function bandpass(freq: number, sampleRate: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cw, alpha } = prewarp(freq, sampleRate, q)
  return normalise(alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha)
}

/** High shelf: boosts (or cuts) everything above `freq` by `gainDb`. */
export function highShelf(freq: number, sampleRate: number, gainDb: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cw, alpha } = prewarp(freq, sampleRate, q)
  const A = Math.pow(10, gainDb / 40)
  const s = 2 * Math.sqrt(A) * alpha
  return normalise(
    A * (A + 1 + (A - 1) * cw + s),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - s),
    A + 1 - (A - 1) * cw + s,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - s
  )
}

/** One biquad section with its own state, so long signals can be filtered chunk by chunk. */
export class Biquad {
  private z1 = 0
  private z2 = 0

  constructor(readonly c: BiquadCoeffs) {}

  reset(): void {
    this.z1 = 0
    this.z2 = 0
  }

  /** Filter input[0..n) into output[0..n) (output may be the same array as input). */
  process(input: Float32Array, n = input.length, output: Float32Array = input): void {
    const { b0, b1, b2, a1, a2 } = this.c
    let z1 = this.z1
    let z2 = this.z2
    for (let i = 0; i < n; i++) {
      const x = input[i]
      const y = b0 * x + z1
      z1 = b1 * x - a1 * y + z2
      z2 = b2 * x - a2 * y
      output[i] = y
    }
    // Flush tiny values: after a long silence the state decays into "denormal" floats, which
    // are extremely slow on most CPUs.
    this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1
    this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2
  }
}

/** Several biquads in series (e.g. two Butterworth sections = one Linkwitz-Riley filter). */
export class BiquadChain {
  readonly stages: Biquad[]

  constructor(coeffs: BiquadCoeffs[]) {
    this.stages = coeffs.map((c) => new Biquad(c))
  }

  process(input: Float32Array, n = input.length, output: Float32Array = input): void {
    let src = input
    for (const s of this.stages) {
      s.process(src, n, output)
      src = output
    }
  }
}

/** 4th-order Linkwitz-Riley low/high-pass as two Butterworth sections. */
export function linkwitzRiley(kind: 'lowpass' | 'highpass', freq: number, sampleRate: number): BiquadCoeffs[] {
  const c = kind === 'lowpass' ? lowpass(freq, sampleRate) : highpass(freq, sampleRate)
  return [c, c]
}

/** Complex frequency response H(e^jw) of one biquad at `freq` Hz. */
function response(c: BiquadCoeffs, freq: number, sampleRate: number): [number, number] {
  const w = (2 * Math.PI * freq) / sampleRate
  // e^-jw and e^-2jw
  const c1 = Math.cos(w)
  const s1 = -Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = -Math.sin(2 * w)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2
  const ni = c.b1 * s1 + c.b2 * s2
  const dr = 1 + c.a1 * c1 + c.a2 * c2
  const di = c.a1 * s1 + c.a2 * s2
  const den = dr * dr + di * di
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den]
}

/**
 * Group delay (seconds) of a filter cascade at `freq`: how late the *envelope* of a narrow-band
 * signal comes out of the filter. Computed as -d(phase)/d(omega) by a central difference.
 * We use it to cancel the lag that filtering adds to onset times.
 */
export function groupDelay(chain: BiquadCoeffs[], freq: number, sampleRate: number): number {
  const df = Math.max(0.01, freq * 1e-3)
  let total = 0
  for (const c of chain) {
    const [ar, ai] = response(c, freq + df, sampleRate)
    const [br, bi] = response(c, freq - df, sampleRate)
    // Phase difference = arg(H(f+df) * conj(H(f-df))), which avoids wrap-around issues.
    const dphi = Math.atan2(ai * br - ar * bi, ar * br + ai * bi)
    total += -dphi / (2 * Math.PI * 2 * df)
  }
  return total
}

// --- Decimation ---------------------------------------------------------------------------

/**
 * Filter lengths (odd; taps at even offsets other than the centre are zero).
 * 'high' (47 taps): ~60 dB rejection from ~0.29 of the input rate, used to bring 44.1/48 kHz
 *   audio down to 22/24 kHz for display and loudness.
 * 'fast' (23 taps, 6 multiplies per output): wider transition band. Used for the internal
 *   22 -> 11 kHz step feeding onset and key analysis: anything that aliases lands above
 *   ~3.7 kHz, far from the notes (< 2.1 kHz) and harmless for onset detection.
 */
const HALFBAND_TAPS = { high: 47, fast: 23 }
export type DecimationQuality = keyof typeof HALFBAND_TAPS

function besselI0(x: number): number {
  // Power series for the modified Bessel function of the first kind, order 0.
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

const halfbandCache = new Map<DecimationQuality, Float64Array>()

/**
 * Half-band low-pass (cutoff = 1/4 of the sample rate) as a Kaiser-windowed sinc.
 * Returns the one-sided odd taps h[1], h[3], ... (h[0] is exactly 0.5, h[-k] = h[k]).
 */
function halfbandTaps(quality: DecimationQuality): Float64Array {
  const cached = halfbandCache.get(quality)
  if (cached) return cached
  const M = (HALFBAND_TAPS[quality] - 1) / 2
  const beta = 6 // Kaiser shape: ~60 dB stop-band attenuation
  const i0b = besselI0(beta)
  const odd = new Float64Array((M + 1) >> 1)
  let sum = 0
  for (let j = 0; j < odd.length; j++) {
    const k = 2 * j + 1
    const sinc = Math.sin((Math.PI * k) / 2) / ((Math.PI * k) / 2) // ideal response at cutoff fs/4
    const r = k / M
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b
    odd[j] = 0.5 * sinc * w
    sum += 2 * odd[j]
  }
  // Normalise so the DC gain is exactly 1 (0.5 from the centre tap + 0.5 from the rest).
  for (let j = 0; j < odd.length; j++) odd[j] *= 0.5 / sum
  halfbandCache.set(quality, odd)
  return odd
}

/**
 * Low-pass filter at fs/4 and keep every other sample. Output length is ceil(n / 2), so output
 * sample m sits at exactly the same time as input sample 2m (the filter is symmetric, i.e.
 * zero-phase: no delay is introduced).
 */
export function decimate2(x: Float32Array, quality: DecimationQuality = 'high'): Float32Array {
  const n = x.length
  const out = new Float32Array((n + 1) >> 1)
  const h = halfbandTaps(quality)
  const T = h.length
  const reach = 2 * T - 1 // furthest input offset used
  // Interior: every tap is inside the signal. Split off so the hot loop has no edge checks.
  const mFirst = Math.min(out.length, Math.ceil(reach / 2))
  const mLast = Math.max(mFirst, Math.floor((n - 1 - reach) / 2) + 1) // exclusive
  if (T === 6) {
    // Hand-unrolled 6-pair version for the 'fast' filter (the internal 22 -> 11 kHz step).
    const h0 = h[0]
    const h1 = h[1]
    const h2 = h[2]
    const h3 = h[3]
    const h4 = h[4]
    const h5 = h[5]
    for (let m = mFirst; m < mLast; m++) {
      const c = 2 * m
      out[m] =
        0.5 * x[c] +
        h0 * (x[c - 1] + x[c + 1]) +
        h1 * (x[c - 3] + x[c + 3]) +
        h2 * (x[c - 5] + x[c + 5]) +
        h3 * (x[c - 7] + x[c + 7]) +
        h4 * (x[c - 9] + x[c + 9]) +
        h5 * (x[c - 11] + x[c + 11])
    }
  } else {
    for (let m = mFirst; m < mLast; m++) {
      const c = 2 * m
      let acc = 0.5 * x[c]
      for (let j = 0, k = 1; j < T; j++, k += 2) acc += h[j] * (x[c - k] + x[c + k])
      out[m] = acc
    }
  }
  // Edges: treat samples outside the signal as silence.
  const edge = (m: number): void => {
    const c = 2 * m
    let acc = 0.5 * x[c]
    for (let j = 0, k = 1; j < T; j++, k += 2) {
      const a = c - k >= 0 ? x[c - k] : 0
      const b = c + k < n ? x[c + k] : 0
      acc += h[j] * (a + b)
    }
    out[m] = acc
  }
  for (let m = 0; m < mFirst; m++) edge(m)
  for (let m = mLast; m < out.length; m++) edge(m)
  return out
}
