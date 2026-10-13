// Musical key detection (Krumhansl-Schmuckler style template matching).
//
// Pipeline
//   1. STFT with long frames (4096 samples at 11 kHz = 0.37 s, 2.7 Hz bin spacing) so that
//      neighbouring semitones are resolvable down to ~50 Hz. Frames don't overlap: averaged
//      over a whole track, the statistics are just as good, at half the cost. We run on the
//      half-rate (~11 kHz) signal since notes above 2.1 kHz are not used anyway.
//   2. Peak picking: keep only spectral local maxima that stand clearly above the local average
//      spectrum. Tonal components (notes and their harmonics) give sharp peaks; drums and noise
//      give broad humps, so this is a cheap way to ignore percussion.
//      Each peak's exact frequency is refined by fitting a parabola through the log magnitudes
//      of the peak bin and its two neighbours.
//   3. Tuning estimation: many records are not tuned to A = 440 Hz (vinyl rips, pitched
//      edits...). For every peak we compute its deviation from the nearest equal-tempered
//      semitone, and take the magnitude-weighted *circular* mean of these deviations (deviation
//      is periodic: +0.5 and -0.5 semitone are the same place between two notes). The result is
//      subtracted before mapping peaks to notes.
//   4. Harmonic suppression (see pass 3 below) and chroma: fold every peak onto one of the 12
//      pitch classes (C, C#, ... B), ignoring octave. A separate "bass chroma" accumulates only
//      peaks below 250 Hz; bass lines dwell on the tonic, so it gets extra weight.
//   5. Key scoring (estimateKey): Pearson correlation of the summed chroma with 24 key profiles
//      (12 major + 12 minor rotations), plus three musically motivated nudges:
//      - "third test": the major vs minor third above the tonic is the one note that separates
//        parallel keys (A major vs A minor), so its balance is scored explicitly;
//      - "loop starts": when a beat grid is known, chroma from the first bar of every 4-bar
//        group is added again. Dance-music loops nearly always start on the tonic chord, and
//        this is the only cue that separates relative keys (C major vs A minor share all their
//        notes; "Am F C G" and "C G Am F" have identical note statistics);
//      - a small minor-mode prior, because most electronic dance music is in minor keys.
//
// Profiles: Krumhansl & Kessler (1982) probe-tone ratings. We tried Temperley's Kostka-Payne
// corpus profiles too: they are sharper but weight the major-key tonic so strongly that modal
// minor loops (i-VI-VII, i-VI-III-VII, the bread and butter of EDM) come out as the relative
// major. Krumhansl-Kessler is more balanced between the modes. EDM-trained profiles (Faraldo
// et al. 2016) are another good option.
//
// The per-frame chroma is also returned: the beat tracker uses harmonic changes to locate
// bar lines.

import type { BeatGrid } from '../../../shared/types'
import { RealFft, hannWindow } from './fft'

/** Krumhansl-Kessler key profiles, index 0 = tonic. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

// Lowest frequency counted in the chroma: 50 Hz keeps bass notes from G#1 up (A1 = 55 Hz is a
// common EDM bass root). Lower, kick drums (45-60 Hz sine bodies) start to look like notes.
const F_MIN = 50
/** Peaks down to here are found (to recognise harmonics of deep bass) but not counted. */
const F_PICK = 35
const F_MAX = 2100
const BASS_MAX = 250
const BASS_WEIGHT = 0.6
/** Weight kept by peaks that look like a 3rd/5th/6th/7th harmonic of a lower peak. */
const HARMONIC_WEIGHT = 0.2
/** Extra weight of chroma from the first bar of each 4-bar group (needs a beat grid). */
const LOOP_WEIGHT = 0.75
/** Weight of the major-vs-minor-third balance in a key's score. */
const THIRD_WEIGHT = 0.1
/** Bonus for minor keys (correlation units). */
const MINOR_BIAS = 0.03
/** Chroma flatter than this is treated as atonal (noise, pure percussion). */
const MAX_FLATNESS = 0.6

export interface ChromaFrames {
  /** 12 values per frame (C..B); frame j is centred on time j / rate. */
  data: Float32Array
  rate: number
}

export interface ChromaAnalysis {
  /** Estimated tuning offset in semitones relative to A440 (-0.5 .. 0.5). */
  tuning: number
  chroma: ChromaFrames
  /** Whole-track chroma, and the same restricted to the bass register. */
  total: Float64Array
  bass: Float64Array
}

/** Growable list of spectral peaks (struct-of-arrays to avoid one object per peak). */
class PeakList {
  freq = new Float32Array(4096)
  amp = new Float32Array(4096)
  frame = new Int32Array(4096)
  length = 0

  push(f: number, a: number, j: number): void {
    if (this.length === this.freq.length) {
      const grow = <T extends Float32Array | Int32Array>(old: T, make: (n: number) => T): T => {
        const next = make(old.length * 2)
        next.set(old)
        return next
      }
      this.freq = grow(this.freq, (n) => new Float32Array(n))
      this.amp = grow(this.amp, (n) => new Float32Array(n))
      this.frame = grow(this.frame, (n) => new Int32Array(n))
    }
    this.freq[this.length] = f
    this.amp[this.length] = a
    this.frame[this.length] = j
    this.length++
  }
}

function midiOf(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440)
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, shift: number): number {
  // Correlation of a[i] with b[(i - shift) mod 12], i.e. profile b transposed up by `shift`.
  let ma = 0
  let mb = 0
  for (let i = 0; i < 12; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= 12
  mb /= 12
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma
    const y = b[(i - shift + 12) % 12] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
}

/**
 * Score all 24 keys for a 12-bin chroma vector (index = key number, see musicKey.ts):
 * profile correlation + third test + minor prior.
 */
export function keyScores(chroma: ArrayLike<number>): Float64Array {
  const scores = new Float64Array(24)
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj3 = chroma[(tonic + 4) % 12]
    const min3 = chroma[(tonic + 3) % 12]
    const third = (maj3 - min3) / (maj3 + min3 + 1e-9) // +1 = clearly major, -1 = clearly minor
    scores[tonic] = pearson(chroma, MAJOR_PROFILE, tonic) + THIRD_WEIGHT * third
    scores[tonic + 12] = pearson(chroma, MINOR_PROFILE, tonic) - THIRD_WEIGHT * third + MINOR_BIAS
  }
  return scores
}

function addNormalised(dst: Float64Array, src: ArrayLike<number>, weight: number): void {
  let max = 0
  for (let i = 0; i < 12; i++) max = Math.max(max, src[i])
  if (max > 0) for (let i = 0; i < 12; i++) dst[i] += (weight * src[i]) / max
}

/** Chroma summed over the first bar of every 4-bar group of the grid. */
function loopStartChroma(c: ChromaFrames, grid: BeatGrid): Float64Array {
  const out = new Float64Array(12)
  const beat = 60 / grid.bpm
  const nFrames = c.data.length / 12
  const end = nFrames / c.rate
  const group = 16 * beat
  for (let t = grid.anchor - Math.ceil(grid.anchor / group) * group; t < end; t += group) {
    const a = Math.max(0, Math.ceil(t * c.rate))
    const b = Math.min(nFrames, Math.ceil((t + 4 * beat) * c.rate))
    for (let j = a; j < b; j++) for (let i = 0; i < 12; i++) out[i] += c.data[j * 12 + i]
  }
  return out
}

/** Key number 0-23, or null when the audio has no tonal content (silence, noise). */
export function estimateKey(a: ChromaAnalysis, grid?: BeatGrid | null): number | null {
  let max = 0
  let sum = 0
  for (let i = 0; i < 12; i++) {
    max = Math.max(max, a.total[i])
    sum += a.total[i]
  }
  if (max < 1e-4) return null // silence
  // Chroma flatness (mean / max): ~0.1-0.35 for music, > 0.7 for noise, which has no key.
  if (sum / 12 / max > MAX_FLATNESS) return null
  const vec = new Float64Array(12)
  addNormalised(vec, a.total, 1)
  addNormalised(vec, a.bass, BASS_WEIGHT)
  if (grid) addNormalised(vec, loopStartChroma(a.chroma, grid), LOOP_WEIGHT)
  const scores = keyScores(vec)
  let best = 0
  for (let k = 1; k < 24; k++) if (scores[k] > scores[best]) best = k
  return best
}

export function analyzeChroma(x: Float32Array, sampleRate: number): ChromaAnalysis {
  const N = Math.pow(2, Math.max(8, Math.round(Math.log2((sampleRate * 8192) / 22050))))
  const hop = N // no overlap: key statistics don't need it, and it halves the work
  const fft = new RealFft(N)
  const window = hannWindow(N)
  const mag = new Float32Array(fft.bins)
  const prefix = new Float64Array(fft.bins + 1)
  const nFrames = x.length === 0 ? 0 : Math.floor((x.length - 1) / hop) + 1
  const binHz = sampleRate / N
  const kLo = Math.max(2, Math.floor(F_PICK / binHz))
  const kHi = Math.min(fft.bins - 2, Math.ceil(F_MAX / binHz))
  const avgRadius = Math.max(4, Math.round(40 / binHz)) // local average over +/- 40 Hz
  const kTop = Math.min(fft.bins, kHi + avgRadius + 1) // highest bin we ever look at
  const norm = 4 / N
  const peaks = new PeakList()

  // Pass 1: STFT + peak picking.
  for (let j = 0; j < nFrames; j++) {
    fft.powerAt(x, j * hop, window, mag)
    prefix[0] = 0
    let frameMax = 0
    for (let k = 0; k < kTop; k++) {
      const m = Math.sqrt(mag[k]) * norm
      mag[k] = m
      prefix[k + 1] = prefix[k] + m
      if (k >= kLo && k <= kHi && m > frameMax) frameMax = m
    }
    if (frameMax < 1e-5) continue // silence (below -100 dBFS)
    const floor = frameMax * 0.003 // ignore peaks 50 dB below the frame's loudest
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k]
      if (m <= floor || m <= mag[k - 1] || m < mag[k + 1]) continue
      const a = Math.max(0, k - avgRadius)
      const b = Math.min(fft.bins, k + avgRadius + 1)
      const localMean = (prefix[b] - prefix[a]) / (b - a)
      if (m < 2 * localMean) continue
      // Parabolic interpolation on log magnitude -> fractional bin offset in [-0.5, 0.5].
      const la = Math.log(mag[k - 1] + 1e-12)
      const lb = Math.log(m + 1e-12)
      const lc = Math.log(mag[k + 1] + 1e-12)
      const den = la - 2 * lb + lc
      const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0
      peaks.push((k + delta) * binHz, m, j)
    }
  }

  // Pass 2: global tuning = circular mean of each peak's distance to the nearest semitone.
  let tc = 0
  let ts = 0
  for (let p = 0; p < peaks.length; p++) {
    if (peaks.freq[p] < F_MIN) continue // too few bins per semitone down there to be precise
    const midi = midiOf(peaks.freq[p])
    const dev = midi - Math.round(midi)
    tc += peaks.amp[p] * Math.cos(2 * Math.PI * dev)
    ts += peaks.amp[p] * Math.sin(2 * Math.PI * dev)
  }
  const tuning = tc === 0 && ts === 0 ? 0 : Math.atan2(ts, tc) / (2 * Math.PI)

  // Pass 3: harmonic suppression. A harmonic tone at f0 also produces peaks at 2f0, 3f0, 4f0...
  // Octave multiples (2, 4, 8) land on the same pitch class and are harmless, but 3f0 and 6f0
  // add the fifth, 5f0 a major third and 7f0 a minor seventh, none of which is being played.
  // A loud bass note's 5th harmonic is enough to turn A minor into A major! So when a peak sits
  // at 3, 5, 6 or 7 times the frequency of a much louder (> 3x amplitude) lower peak in the same
  // frame, we count it only partially. The loudness condition matters: the third of a chord
  // often coincides with the bass note's 5th harmonic, and a real note is about as loud as the
  // bass, while a harmonic is much weaker.
  const weight = new Float32Array(peaks.length).fill(1)
  for (let start = 0; start < peaks.length;) {
    let end = start
    while (end < peaks.length && peaks.frame[end] === peaks.frame[start]) end++
    for (let p = start; p < end; p++) {
      const fp = peaks.freq[p]
      for (let q = start; q < p; q++) {
        const r = fp / peaks.freq[q]
        if (r < 2.5) break // peaks are sorted by frequency
        const h = Math.round(r)
        const oddHarmonic = h === 3 || h === 5 || h === 6 || h === 7
        if (oddHarmonic && Math.abs(r - h) < 0.03 * h && peaks.amp[q] > 3 * peaks.amp[p]) {
          weight[p] = HARMONIC_WEIGHT
          break
        }
      }
    }
    start = end
  }

  // Pass 4: chroma, with each peak weighted down as it strays from the (re-tuned) semitone.
  const chroma = new Float32Array(nFrames * 12)
  const total = new Float64Array(12)
  const bass = new Float64Array(12)
  for (let p = 0; p < peaks.length; p++) {
    if (peaks.freq[p] < F_MIN) continue
    const m = midiOf(peaks.freq[p]) - tuning
    const r = Math.round(m)
    const c = Math.cos(Math.PI * (m - r))
    const w = peaks.amp[p] * c * c * weight[p]
    const pc = ((r % 12) + 12) % 12
    chroma[peaks.frame[p] * 12 + pc] += w
    total[pc] += w
    if (peaks.freq[p] < BASS_MAX) bass[pc] += w
  }

  return { tuning, chroma: { data: chroma, rate: sampleRate / hop }, total, bass }
}
