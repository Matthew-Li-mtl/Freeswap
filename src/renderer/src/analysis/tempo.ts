// Tempo, beat grid, downbeat and phrase detection.
//
// DJ software assumes a constant tempo (true for nearly all electronic music), so instead of
// tracking beats one by one we fit a single grid  beat_k = phase + k * 60 / bpm  to the whole
// track. Pipeline:
//
//  1. Coarse tempo: autocorrelation (ACF) of the onset envelope. If onsets repeat every L
//     frames, the envelope correlates strongly with itself shifted by L, 2L, 3L... Each
//     candidate beat period L is scored by a "comb" sum ACF(L/2) + ACF(L) + ACF(3L/2) + ...
//     + ACF(4L) over half-beat multiples, times a mild log-Gaussian prior centred on 125 BPM
//     (a tie-breaker, not a decision maker). Including the half-beats matters: with off-beat
//     hi-hats every multiple of half a beat is a period of the signal, so a comb over whole
//     beats alone scores 2/3 of the true tempo (174 -> 116) just as high; at the wrong tempo
//     the half-beat teeth land between the onsets.
//  2. Octave folding into [bpmLow, 2*bpmLow): 64, 128 and 256 BPM describe the same pulse;
//     the user decides which octave they want to see (e.g. 87 vs 174 for drum & bass).
//  3. Fine tempo over the whole track. For a candidate tempo f (beats/s) we compute
//        S_h = | sum_j onset[j] * exp(-2*pi*i * h * f * t_j) |    for harmonics h = 1..4
//     This is the Fourier transform of the onset envelope evaluated at the beat frequency and
//     its harmonics. It is the smooth version of "lay a grid over the track, slide it to the
//     best phase, add up the onset strength under the grid lines": it is large only when the
//     onsets of the *entire* track agree with one constant tempo. Because it integrates over
//     minutes, a tempo error of 0.01 BPM is clearly measurable. We search +/-1.5 BPM in
//     0.02 steps, then +/-0.04 BPM in 0.002 steps with parabolic interpolation.
//  4. Snap: electronic music is almost always produced at an integer tempo, so a result within
//     0.04 BPM of an integer is snapped; otherwise it is rounded to 0.01.
//  5. Phase: fold ("wrap") an envelope modulo the beat period into a histogram: the bin where
//     onsets pile up is the beat position. We fold the 2.9 ms low-band (< 400 Hz, kick) energy,
//     which yields the average kick envelope of the whole track, and place the beat marker
//     where it reaches half its height on the rising edge (the attack), minus the low-pass
//     filter's delay. Without a clear kick we fall back to the peak of the folded spectral
//     flux (~23 ms frames, refined by interpolation).
//  6. Downbeat ("1" of the bar): beats are numbered k = 0, 1, 2...; we score the four
//     possible offsets r = k mod 4 using per-beat features that tend to be larger on bar lines:
//     kick/bass accent, crash/onset accent, timbre change between the 4 beats before and
//     after, and chord changes (chroma). Each feature becomes a t-statistic per offset
//     ("how far above average are beats with k = r (mod 4)?") so features with different
//     units can be summed.
//  7. Phrase start (every 8 bars): the same idea at bar level with 8 offsets, using bar-scale
//     novelty (energy, timbre, harmony changes between the 4 bars before and after). Drops,
//     breakdowns and new layers land on phrase boundaries. The first bar where the music
//     starts gets a bonus, since DJ-friendly tracks start on a phrase.
//  8. Output the grid as { bpm, anchor } with the anchor on a phrase start, normalised into
//     [0, 32 beats).
//
// Optional BPM hint (from the file's tags): if a grid at the hinted tempo explains the onsets
// at least HINT_MIN_RATIO as well as our own best grid, the hint wins. That resolves octave and
// 3:2 ambiguities; a hint that is plainly wrong is ignored.
//
// "No beat" (null) is reserved for material that really has none. Two tests, both designed not
// to be vetoed by long beatless intros, breakdowns or heavy distortion:
//   - significance: do onsets prefer one phase of the grid more than chance would explain?
//     (A Rayleigh test; noise scores ~1-2, music 8+.)
//   - slow-pulse test: is the periodicity really a slow pulse such as chord changes every few
//     seconds, which also "fit" any grid that is a multiple of their rate?
// If either says "no beat" but there is a BPM hint, we trust the hint and still return a grid.

import type { BeatGrid } from '../../../shared/types'
import type { ChromaFrames } from './key'
import { NUM_BANDS, type Envelope, type LowBandEnvelope } from './onset'

export interface TempoInputs {
  /** Broadband onset strength (spectral flux). */
  flux: Envelope
  /** NUM_BANDS band energies per flux frame. */
  bands: Float32Array
  low: LowBandEnvelope
  chroma: ChromaFrames
  duration: number
}

export interface TempoResult {
  bpm: number
  grid: BeatGrid
  /** 0..1, fraction of onset energy aligned with the grid. */
  confidence: number
}

const MIN_BPM = 60
const MAX_BPM = 200
/**
 * Rhythm significance (see `periodicity`): random onsets give z ~ 1-2, a beat gives 8+.
 * Below this we say "no beat".
 */
const MIN_SIGNIFICANCE = 4
/** Pulses slower than this (BPM) are not beats: chord changes every 2 s, say. */
const SLOW_PULSE_BPM = 40
/** Above this slow-pulse ratio the "beat" is really a slow pulse (see slowPulseRatio). */
const MAX_SLOW_RATIO = 0.75
/** A BPM hint is accepted if a grid at its tempo explains this much of the best grid's score. */
const HINT_MIN_RATIO = 0.4
const DOWNBEAT_HINT = 2
const PHRASE_HINT = 1.5
// Noise floors: feature differences smaller than these are not treated as musical changes
// (see residueScores). Units: dB, log onset strength, cosine distance, scaled log energy.
const DB_FLOOR = 0.1
const ONSET_FLOOR = 0.05
const CHROMA_FLOOR = 0.01
const TIMBRE_FLOOR = 0.02

// --- small helpers ------------------------------------------------------------------------

function mod(a: number, m: number): number {
  return a - Math.floor(a / m) * m
}

/** Linearly interpolated a[pos], 0 outside the array. */
function interp(a: Float64Array, pos: number): number {
  const i = Math.floor(pos)
  if (i < 0 || i + 1 >= a.length) return 0
  const f = pos - i
  return a[i] * (1 - f) + a[i + 1] * f
}

export function foldBpm(bpm: number, low: number): number {
  let b = bpm
  while (b < low) b *= 2
  while (b >= 2 * low) b /= 2
  return b
}

export function snapBpm(bpm: number): number {
  const r = Math.round(bpm)
  return Math.abs(bpm - r) < 0.04 ? r : Math.round(bpm * 100) / 100
}

// --- 1. coarse tempo ---------------------------------------------------------------------

/** Unbiased autocorrelation r[L] for L = 0..maxLag of the mean-removed signal, r[0] = 1. */
function autocorrelation(x: Float32Array, maxLag: number): Float64Array {
  const n = x.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]
  mean /= n
  const c = new Float64Array(n)
  for (let i = 0; i < n; i++) c[i] = x[i] - mean
  const r = new Float64Array(maxLag + 1)
  for (let L = 0; L <= maxLag; L++) {
    let s = 0
    for (let i = 0, end = n - L; i < end; i++) s += c[i] * c[i + L]
    r[L] = s / (n - L)
  }
  const r0 = r[0] || 1
  for (let L = 0; L <= maxLag; L++) r[L] /= r0
  return r
}

function coarseTempo(env: Envelope): number | null {
  const { data, rate } = env
  const maxLag = Math.ceil((4 * 60 * rate) / MIN_BPM) + 2
  if (data.length < maxLag * 2) return null
  const r = autocorrelation(data, maxLag)
  let best: number | null = null
  let bestScore = 0
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const L = (60 * rate) / bpm
    let s = 0
    for (let m = 1; m <= 8; m++) s += interp(r, (m * L) / 2)
    const octaves = Math.log2(bpm / 125)
    s *= Math.exp(-0.5 * octaves * octaves)
    if (s > bestScore) {
      bestScore = s
      best = bpm
    }
  }
  return best
}

// --- 3. fine tempo -----------------------------------------------------------------------

interface Periodicity {
  /** Sum of |S_h| over harmonics 1..4. */
  score: number
  /** Largest single |S_h| divided by the envelope's total: 0..1. */
  coherence: number
  /**
   * Largest |S_h| divided by sqrt(sum of squared envelope values): a Rayleigh-style test of
   * "do onsets prefer one phase of the grid?". If onsets fell at random phases the sum would be
   * a random walk, whose length is about sqrt(sum of squares), giving ~1. A real beat adds up
   * coherently, so the value grows with the square root of the amount of rhythmic material:
   * a long intro or breakdown without drums lowers it only a little.
   */
  significance: number
}

/**
 * Magnitude of the envelope's Fourier transform at bpm/60 Hz and its first 4 harmonics.
 * The complex exponentials are generated by repeated multiplication with a fixed rotation
 * ("phasor recurrence"), which avoids calling sin/cos for every frame.
 */
function periodicity(env: Envelope, bpm: number): Periodicity {
  const { data, rate } = env
  const w = (-2 * Math.PI * bpm) / 60 / rate // radians per frame for harmonic 1
  const r1 = Math.cos(w)
  const i1 = Math.sin(w)
  const r2 = Math.cos(2 * w)
  const i2 = Math.sin(2 * w)
  const r3 = Math.cos(3 * w)
  const i3 = Math.sin(3 * w)
  const r4 = Math.cos(4 * w)
  const i4 = Math.sin(4 * w)
  let z1r = 1,
    z1i = 0,
    z2r = 1,
    z2i = 0,
    z3r = 1,
    z3i = 0,
    z4r = 1,
    z4i = 0
  let a1r = 0,
    a1i = 0,
    a2r = 0,
    a2i = 0,
    a3r = 0,
    a3i = 0,
    a4r = 0,
    a4i = 0
  let total = 0
  let squares = 0
  for (let j = 0; j < data.length; j++) {
    const v = data[j]
    if (v !== 0) {
      total += v
      squares += v * v
      a1r += v * z1r
      a1i += v * z1i
      a2r += v * z2r
      a2i += v * z2i
      a3r += v * z3r
      a3i += v * z3i
      a4r += v * z4r
      a4i += v * z4i
    }
    let t = z1r * r1 - z1i * i1
    z1i = z1r * i1 + z1i * r1
    z1r = t
    t = z2r * r2 - z2i * i2
    z2i = z2r * i2 + z2i * r2
    z2r = t
    t = z3r * r3 - z3i * i3
    z3i = z3r * i3 + z3i * r3
    z3r = t
    t = z4r * r4 - z4i * i4
    z4i = z4r * i4 + z4i * r4
    z4r = t
  }
  const m1 = Math.hypot(a1r, a1i)
  const m2 = Math.hypot(a2r, a2i)
  const m3 = Math.hypot(a3r, a3i)
  const m4 = Math.hypot(a4r, a4i)
  const best = Math.max(m1, m2, m3, m4)
  return {
    score: m1 + m2 + m3 + m4,
    coherence: total > 0 ? best / total : 0,
    significance: squares > 0 ? best / Math.sqrt(squares) : 0
  }
}

/** |sum_j env[j] * exp(-2*pi*i * hz * j / rate)|: one Fourier coefficient of the envelope. */
function fourierMagnitude(env: Envelope, hz: number): number {
  const { data, rate } = env
  const w = (-2 * Math.PI * hz) / rate
  const cr = Math.cos(w)
  const ci = Math.sin(w)
  let zr = 1
  let zi = 0
  let ar = 0
  let ai = 0
  for (let j = 0; j < data.length; j++) {
    const v = data[j]
    ar += v * zr
    ai += v * zi
    const t = zr * cr - zi * ci
    zi = zr * ci + zi * cr
    zr = t
  }
  return Math.hypot(ar, ai)
}

/**
 * Is the "beat" really a slow pulse? Chords changing every 4 s are perfectly periodic at
 * 15 BPM, and therefore also at 120 BPM (every 8th "beat" has an onset), so a grid at 120 BPM
 * fits them well. The tell-tale sign: a train of identical events every m beats has Fourier
 * components of the same size at *every* multiple of f/m (f = beat frequency), including the
 * in-between ones f*1/m ... f*(m-1)/m. A real beat (an onset on most beats, maybe with bar
 * accents) has those in-between components much weaker than the grid's own (f, 2f, 3f, 4f).
 * Returns the largest (mean in-between component / component at f) over slow periods
 * m = 2..16 whose rate f/m is below SLOW_PULSE_BPM: ~0.9 for pads, < 0.5 for beats.
 */
function slowPulseRatio(env: Envelope, bpm: number): number {
  const f = bpm / 60
  // The grid's strength: its strongest harmonic (onsets on every half beat, say, have nothing
  // at f itself but a lot at 2f).
  let atBeat = 0
  for (let h = 1; h <= 4; h++) atBeat = Math.max(atBeat, fourierMagnitude(env, f * h))
  if (atBeat <= 0) return Infinity
  let worst = 0
  for (let m = 2; m <= 16; m++) {
    if (bpm / m >= SLOW_PULSE_BPM) continue
    let sum = 0
    for (let j = 1; j < m; j++) sum += fourierMagnitude(env, (f * j) / m)
    worst = Math.max(worst, sum / (m - 1) / atBeat)
  }
  return worst
}

/** Best-scoring tempo on a grid of candidates, refined by a parabola through its neighbours. */
function searchTempo(env: Envelope, center: number, halfWidth: number, step: number): number {
  const n = Math.round(halfWidth / step)
  const scores = new Float64Array(2 * n + 1)
  let best = 0
  for (let i = 0; i <= 2 * n; i++) {
    scores[i] = periodicity(env, center + (i - n) * step).score
    if (scores[i] > scores[best]) best = i
  }
  let offset = 0
  if (best > 0 && best < 2 * n) {
    const a = scores[best - 1]
    const b = scores[best]
    const c = scores[best + 1]
    const den = a - 2 * b + c
    if (den < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
  }
  return center + (best - n + offset) * step
}

// --- 5. phase ----------------------------------------------------------------------------

/**
 * Wrap an envelope around a period: histogram[b] accumulates every value whose time falls at
 * phase b/bins of the period. Values are split linearly between neighbouring bins.
 * `t0` is the time of data[0].
 */
function foldEnvelope(data: Float32Array, rate: number, t0: number, period: number, bins: number): Float64Array {
  const h = new Float64Array(bins)
  for (let j = 0; j < data.length; j++) {
    const v = data[j]
    if (v === 0) continue
    const p = (mod(t0 + j / rate, period) / period) * bins
    const i = Math.floor(p)
    const f = p - i
    h[i % bins] += v * (1 - f)
    h[(i + 1) % bins] += v * f
  }
  return h
}

/** Circular convolution with a Hann kernel of the given radius (in bins). */
function smoothCircular(h: Float64Array, radius: number): Float64Array {
  const n = h.length
  if (radius < 1) return Float64Array.from(h)
  const kernel: number[] = []
  let ks = 0
  for (let d = -radius; d <= radius; d++) {
    const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (radius + 1))
    kernel.push(w)
    ks += w
  }
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let d = -radius; d <= radius; d++) s += h[(((i + d) % n) + n) % n] * kernel[d + radius]
    out[i] = s / ks
  }
  return out
}

/** Phase (seconds, 0..period) of the peak of the folded broadband onset envelope. */
function coarsePhase(flux: Envelope, period: number): number {
  const bins = 64
  const h = smoothCircular(foldEnvelope(flux.data, flux.rate, 0, period, bins), 1)
  let best = 0
  for (let i = 1; i < bins; i++) if (h[i] > h[best]) best = i
  const a = h[(best + bins - 1) % bins]
  const b = h[best]
  const c = h[(best + 1) % bins]
  const den = a - 2 * b + c
  const off = den < 0 ? (0.5 * (a - c)) / den : 0
  return mod(((best + off) / bins) * period, period)
}

/**
 * Locate the kick attack in the folded low-band energy. Returns the phase in seconds, or null
 * when the low band has no clear periodic attack (no kick drum).
 */
function kickPhase(low: LowBandEnvelope, period: number): number | null {
  const { data, rate } = low.energy
  const bins = Math.max(16, Math.round(period * rate))
  // Energy frame j covers [j, j+1) hops, so its centre is at (j + 0.5) / rate.
  const raw = foldEnvelope(data, rate, 0.5 / rate, period, bins)
  // Smooth over ~ +/-5 ms: averages out the ripple of the kick's own low-frequency cycles.
  const h = smoothCircular(raw, Math.max(1, Math.round((0.005 * bins) / period)))
  let p = 0
  for (let i = 1; i < bins; i++) if (h[i] > h[p]) p = i
  const peak = h[p]
  let base = peak
  for (let d = 0; d <= bins / 2; d++) base = Math.min(base, h[(p - d + bins) % bins])
  if (peak <= 0 || peak - base < 0.2 * peak) return null
  // Walk back from the peak to where the rising edge crosses half height.
  const thr = base + 0.5 * (peak - base)
  for (let d = 1; d <= bins / 2; d++) {
    const i = (p - d + bins) % bins
    const v = h[i]
    if (v < thr) {
      const next = h[(i + 1) % bins]
      const frac = next > v ? (thr - v) / (next - v) : 0
      return mod(((p - d + frac) / bins) * period - low.delay, period)
    }
  }
  return null
}

/**
 * Beat phase: the kick attack if there is a clear one that agrees (within a quarter beat) with
 * the broadband onsets, otherwise the onset peak. The agreement check stops e.g. an off-beat
 * bass line from being mistaken for the kick.
 */
function beatPhase(inp: TempoInputs, period: number): number {
  const coarse = coarsePhase(inp.flux, period)
  const kick = kickPhase(inp.low, period)
  if (kick == null) return coarse
  const d = mod(kick - coarse, period)
  return Math.min(d, period - d) <= period / 4 ? kick : coarse
}

// --- 6/7. per-beat features, downbeat and phrase -----------------------------------------

/**
 * Score each residue class k mod P with a t-statistic: how far the mean of the feature over
 * those k is above the overall mean, in units of its standard error. Invalid values are NaN.
 * `floor` is added (in quadrature) to the standard deviation: in a perfectly repetitive loop
 * every feature is ~constant, and without a floor its tiny random wiggles would be blown up
 * into large, meaningless t-values that override the more reliable hints.
 */
function residueScores(f: Float64Array, P: number, floor: number): Float64Array {
  const out = new Float64Array(P)
  let n = 0
  let sum = 0
  let sum2 = 0
  const rs = new Float64Array(P)
  const rn = new Float64Array(P)
  for (let k = 0; k < f.length; k++) {
    const v = f[k]
    if (Number.isNaN(v)) continue
    n++
    sum += v
    sum2 += v * v
    const r = k % P
    rs[r] += v
    rn[r]++
  }
  if (n < 2 * P) return out
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean) + floor * floor)
  if (sd < 1e-9) return out
  for (let r = 0; r < P; r++) {
    if (rn[r] === 0) continue
    const t = (rs[r] / rn[r] - mean) / (sd / Math.sqrt(rn[r]))
    out[r] = Math.max(-10, Math.min(10, t))
  }
  return out
}

function cosineDistance(a: Float64Array, ao: number, b: Float64Array, bo: number, n: number): number {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    ab += a[ao + i] * b[bo + i]
    aa += a[ao + i] * a[ao + i]
    bb += b[bo + i] * b[bo + i]
  }
  return aa > 0 && bb > 0 ? 1 - ab / Math.sqrt(aa * bb) : 0
}

/** Sum of rows [from, to) of a row-major matrix with `width` columns, into `out`. */
function sumRows(m: Float64Array, width: number, from: number, to: number, out: Float64Array, outOffset = 0): void {
  for (let c = 0; c < width; c++) out[outOffset + c] = 0
  for (let r = from; r < to; r++) for (let c = 0; c < width; c++) out[outOffset + c] += m[r * width + c]
}

function euclidean(a: Float64Array, b: Float64Array, n: number, scale: number): number {
  let s = 0
  for (let i = 0; i < n; i++) {
    const d = (a[i] - b[i]) * scale
    s += d * d
  }
  return Math.sqrt(s / n)
}

interface BeatFeatures {
  count: number
  /** dB energy of the kick band during the beat */
  lowDb: Float64Array
  /** log10 band energies (NUM_BANDS per beat) */
  bandLog: Float64Array
  /** linear total energy, for finding where the music starts */
  energy: Float64Array
  /** chroma summed over the beat (12 per beat) */
  chroma: Float64Array
  /** log of the strongest onset near the beat */
  onset: Float64Array
}

function beatFeatures(inp: TempoInputs, phase: number, period: number): BeatFeatures {
  const count = Math.max(0, Math.floor((inp.duration - phase) / period) + 1)
  const lowDb = new Float64Array(count)
  const bandLog = new Float64Array(count * NUM_BANDS)
  const energy = new Float64Array(count)
  const chroma = new Float64Array(count * 12)
  const onset = new Float64Array(count)
  const le = inp.low.energy
  const fl = inp.flux
  const cr = inp.chroma
  const nFlux = fl.data.length
  const nChroma = cr.data.length / 12
  const bandAcc = new Float64Array(NUM_BANDS)
  for (let k = 0; k < count; k++) {
    const t0 = phase + k * period
    const t1 = t0 + period

    // Kick band energy, starting slightly before the beat so the attack is fully included.
    let e = 0
    const ja = Math.max(0, Math.ceil((t0 - 0.05 * period) * le.rate - 0.5))
    const jb = Math.min(le.data.length, Math.ceil((t1 - 0.05 * period) * le.rate - 0.5))
    for (let j = ja; j < jb; j++) e += le.data[j]
    lowDb[k] = 10 * Math.log10(e + 1e-10)

    // Timbre bands averaged over the beat. Frame j stands for the interval (j +/- 0.5) / rate;
    // frames that straddle the beat's edges count with the fraction that lies inside. Without
    // this, a beat would contain sometimes n and sometimes n+1 whole frames, and that jitter
    // looks like a timbre change.
    const u0 = t0 * fl.rate + 0.5 // beat edges in "frame index + 0.5" units
    const u1 = t1 * fl.rate + 0.5
    const fa = Math.max(0, Math.floor(u0))
    const fb = Math.min(nFlux, Math.ceil(u1))
    bandAcc.fill(0)
    let wsum = 0
    for (let j = fa; j < fb; j++) {
      const w = Math.min(j + 1, u1) - Math.max(j, u0)
      if (w <= 0) continue
      wsum += w
      for (let b = 0; b < NUM_BANDS; b++) bandAcc[b] += w * inp.bands[j * NUM_BANDS + b]
    }
    let total = 0
    for (let b = 0; b < NUM_BANDS; b++) {
      const v = wsum > 0 ? bandAcc[b] / wsum : 0
      total += v
      bandLog[k * NUM_BANDS + b] = Math.log10(v + 1e-8)
    }
    energy[k] = total

    // Strongest onset within +/-30 ms of the beat.
    let o = 0
    const oa = Math.max(0, Math.floor((t0 - 0.03) * fl.rate))
    const ob = Math.min(nFlux - 1, Math.ceil((t0 + 0.03) * fl.rate))
    for (let j = oa; j <= ob; j++) o = Math.max(o, fl.data[j])
    onset[k] = Math.log(o + 1e-4)

    // Chroma frames centred inside the beat (or the nearest one if the beat is very short).
    let ca = Math.max(0, Math.ceil(t0 * cr.rate))
    let cb = Math.min(nChroma, Math.ceil(t1 * cr.rate))
    if (cb <= ca) {
      ca = Math.min(nChroma - 1, Math.max(0, Math.round((t0 + period / 2) * cr.rate)))
      cb = ca + 1
    }
    for (let j = ca; j < cb; j++) for (let c = 0; c < 12; c++) chroma[k * 12 + c] += cr.data[j * 12 + c]
  }
  return { count, lowDb, bandLog, energy, chroma, onset }
}

/** Index of the first beat where the music has clearly started. */
function firstStrongBeat(energy: Float64Array): number {
  const sorted = Float64Array.from(energy).sort()
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  for (let k = 0; k < energy.length; k++) if (energy[k] >= 0.1 * median && energy[k] > 0) return k
  return 0
}

function argmax(a: Float64Array): number {
  let best = 0
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i
  return best
}

/**
 * Turn a smooth novelty curve into a "local peak" curve: f[k] - mean(f[k-1], f[k+1]).
 * Novelty measured with sliding windows rises and falls like a triangle around a change; this
 * keeps only the tip, so the exact beat/bar of the change stands out.
 */
function peakiness(f: Float64Array): Float64Array {
  const out = new Float64Array(f.length).fill(NaN)
  for (let k = 1; k < f.length - 1; k++) out[k] = f[k] - 0.5 * (f[k - 1] + f[k + 1])
  return out
}

/** Which beat offset (0..3) starts bars. */
function chooseDownbeat(f: BeatFeatures, firstBeat: number): number {
  const K = f.count
  const active = (k: number): boolean => k >= firstBeat && f.energy[k] > 0
  const nan = (): Float64Array => new Float64Array(K).fill(NaN)

  // Local contrast: is this beat's kick (or onset) stronger than its neighbours'?
  const accent = nan()
  const onsetAccent = nan()
  for (let k = 1; k < K - 1; k++) {
    if (!active(k - 1) || !active(k + 1)) continue
    accent[k] = f.lowDb[k] - 0.5 * (f.lowDb[k - 1] + f.lowDb[k + 1])
    onsetAccent[k] = f.onset[k] - 0.5 * (f.onset[k - 1] + f.onset[k + 1])
  }

  // Chord change from the previous beat, and bar-scale novelty: how different are the 4 beats
  // starting here from the 4 before? (Both are largest when k is the first beat of a bar.)
  const chordChange = nan()
  const timbre = nan()
  const harmony = nan()
  const a = new Float64Array(12)
  const b = new Float64Array(12)
  for (let k = 0; k < K; k++) {
    if (k >= 1 && active(k - 1) && active(k)) {
      chordChange[k] = cosineDistance(f.chroma, k * 12, f.chroma, (k - 1) * 12, 12)
    }
    if (k < 4 || k + 4 > K || !active(k - 4)) continue
    sumRows(f.bandLog, NUM_BANDS, k, k + 4, a)
    sumRows(f.bandLog, NUM_BANDS, k - 4, k, b)
    timbre[k] = euclidean(a, b, NUM_BANDS, 0.25)
    sumRows(f.chroma, 12, k, k + 4, a)
    sumRows(f.chroma, 12, k - 4, k, b)
    harmony[k] = cosineDistance(a, 0, b, 0, 12)
  }

  const total = new Float64Array(4)
  const features: [Float64Array, number][] = [
    [accent, DB_FLOOR],
    [onsetAccent, ONSET_FLOOR],
    [chordChange, CHROMA_FLOOR],
    [peakiness(timbre), TIMBRE_FLOOR],
    [peakiness(harmony), CHROMA_FLOOR]
  ]
  for (const [feat, floor] of features) {
    const s = residueScores(feat, 4, floor)
    for (let r = 0; r < 4; r++) total[r] += s[r]
  }
  total[firstBeat % 4] += DOWNBEAT_HINT
  return argmax(total)
}

/** Which bar offset (0..7) starts 8-bar phrases, given bars start at beat `downbeat`. */
function choosePhrase(f: BeatFeatures, downbeat: number, firstBeat: number): number {
  const M = Math.floor((f.count - downbeat) / 4)
  const firstBar = Math.floor((firstBeat - downbeat) / 4) // may be -1 (pickup bar)
  const W = 4 // compare the 4 bars after a candidate boundary with the 4 bars before it

  // Bar-level features: mean band log-energies, loudness (dB), chroma.
  const bars = new Float64Array(M * NUM_BANDS)
  const barDb = new Float64Array(M)
  const barChroma = new Float64Array(M * 12)
  const tmp = new Float64Array(12)
  for (let m = 0; m < M; m++) {
    const k = downbeat + 4 * m
    sumRows(f.bandLog, NUM_BANDS, k, k + 4, bars, m * NUM_BANDS)
    let e = 0
    for (let i = 0; i < 4; i++) e += f.energy[k + i] / 4
    barDb[m] = 10 * Math.log10(e + 1e-10)
    sumRows(f.chroma, 12, k, k + 4, tmp)
    barChroma.set(tmp, m * 12)
  }

  const timbre = new Float64Array(M).fill(NaN)
  const loudness = new Float64Array(M).fill(NaN)
  const harmony = new Float64Array(M).fill(NaN)
  const a = new Float64Array(12)
  const b = new Float64Array(12)
  for (let m = W; m + W <= M; m++) {
    sumRows(bars, NUM_BANDS, m, m + W, a)
    sumRows(bars, NUM_BANDS, m - W, m, b)
    timbre[m] = euclidean(a, b, NUM_BANDS, 0.25 / W)
    let la = 0
    let lb = 0
    for (let i = 0; i < W; i++) {
      la += barDb[m + i]
      lb += barDb[m - 1 - i]
    }
    loudness[m] = Math.abs(la - lb) / W
    sumRows(barChroma, 12, m, m + W, a)
    sumRows(barChroma, 12, m - W, m, b)
    harmony[m] = cosineDistance(a, 0, b, 0, 12)
  }

  const total = new Float64Array(8)
  const features: [Float64Array, number][] = [
    [timbre, TIMBRE_FLOOR],
    [loudness, DB_FLOOR],
    [harmony, CHROMA_FLOOR]
  ]
  for (const [feat, floor] of features) {
    const s = residueScores(peakiness(feat), 8, floor)
    for (let r = 0; r < 8; r++) total[r] += s[r]
  }
  total[mod(firstBar, 8)] += PHRASE_HINT
  return argmax(total)
}

// --- main entry --------------------------------------------------------------------------

export interface TempoOptions {
  /** Tempi are folded into [bpmLow, 2 * bpmLow). */
  bpmLow: number
  /** BPM from the file's tags, if any (any octave; it gets folded). */
  bpmHint?: number | null
}

/** Coarse + fine tempo search around `center` (already folded). */
function refineTempo(flux: Envelope, center: number, halfWidth: number): number {
  const bpm = searchTempo(flux, center, halfWidth, 0.02)
  return searchTempo(flux, bpm, 0.04, 0.002)
}

export function detectTempo(inp: TempoInputs, opts: TempoOptions): TempoResult | null {
  const { flux } = inp
  const { bpmLow } = opts
  let total = 0
  for (let j = 0; j < flux.data.length; j++) total += flux.data[j]
  if (!(total > 0)) return null // silence or a constant tone: nothing to align a grid to

  const rawHint = opts.bpmHint
  const hint =
    rawHint != null && Number.isFinite(rawHint) && rawHint >= 30 && rawHint <= 300 ? foldBpm(rawHint, bpmLow) : null

  // Our own estimate.
  const coarse = coarseTempo(flux)
  let bpm = coarse == null ? null : refineTempo(flux, foldBpm(coarse, bpmLow), 1.5)

  // The tag's estimate, used when it explains the onsets reasonably well compared with ours.
  // This settles octave / 3:2 ambiguities the way the producer or a previous tool did, while a
  // tag that is plainly wrong (a grid at its tempo explains little) is ignored.
  if (hint != null) {
    let atHint = refineTempo(flux, hint, 0.6)
    if (Math.abs(atHint - hint) <= 0.05) atHint = hint // tags are usually exact; keep e.g. 92.5
    if (bpm == null || periodicity(flux, atHint).score >= HINT_MIN_RATIO * periodicity(flux, bpm).score) bpm = atHint
  }
  if (bpm == null) return null
  bpm = foldBpm(snapBpm(foldBpm(bpm, bpmLow)), bpmLow)

  // Is there a beat at all? Only reject when the evidence says "no": no significant periodicity
  // (noise, ambient) or the periodicity is a slow pulse (pads). Weak or partial beats pass.
  const { coherence, significance } = periodicity(flux, bpm)
  if (significance < MIN_SIGNIFICANCE || slowPulseRatio(flux, bpm) >= MAX_SLOW_RATIO) {
    if (hint == null) return null
    bpm = foldBpm(snapBpm(hint), bpmLow) // can't hear a beat: trust the tag
  }

  const period = 60 / bpm
  const phase = beatPhase(inp, period)

  const feats = beatFeatures(inp, phase, period)
  if (feats.count < 8) return null
  const first = firstStrongBeat(feats.energy)
  const downbeat = chooseDownbeat(feats, first)
  const phraseBar = choosePhrase(feats, downbeat, first)
  const anchor = mod(phase + (downbeat + 4 * phraseBar) * period, 32 * period)
  return { bpm, grid: { bpm, anchor }, confidence: coherence }
}
