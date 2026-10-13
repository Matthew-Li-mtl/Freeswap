// Onset-strength envelopes: "how much new sound starts at time t?"
//
// Beat tracking never looks at raw samples; it looks at an onset envelope, a slowly sampled
// curve that spikes whenever a note or drum hit begins. We compute two of them.
//
// Both are computed from the half-rate (~11 kHz) signal: onsets are just as visible below
// 5.5 kHz, and it halves the work.
//
// 1. Spectral flux (broadband, ~43 frames/s)
//    - Short-time Fourier transform: Hann-windowed frames of ~46 ms (512 samples at 11 kHz),
//      one every ~23 ms (hop 256, 50 % overlap), each centred on its time stamp.
//    - Magnitudes are summed into a log-frequency filterbank (semitone-wide bands above
//      ~340 Hz), then log-compressed: log(1 + g*|X|). Loudness perception is roughly
//      logarithmic, and the compression stops a loud kick from drowning a quiet hi-hat.
//    - Flux = sum over bands of the *increase* in log magnitude since the previous frame
//      (half-wave rectified: decays are not onsets).
//    - Subtract a moving average (~0.5 s) and clip at zero, so the envelope measures onsets
//      relative to their surroundings rather than the overall loudness of a section.
//    The same STFT also yields per-frame energies in 8 octave-ish bands, used later as a cheap
//    "timbre" description for finding bar and phrase boundaries.
//
// 2. Low-band energy (kick drum, ~345 frames/s)
//    Spectral flux has ~23 ms time resolution, too coarse to place a beat marker exactly on a
//    kick. So we also low-pass the signal at 400 Hz and sum its energy over ~2.9 ms hops. Beat
//    phase is later refined on this curve. Why 400 Hz and not ~100 Hz where the kick's body
//    sits? Real kicks start with a fast pitch sweep (often 150-300 Hz falling to ~50 Hz in
//    20-40 ms). A narrow bass band only "hears" the kick once the sweep has come down, which
//    puts the marker ~10 ms late. 400 Hz keeps the sweep while still rejecting hi-hats.

import { BiquadChain, groupDelay, linkwitzRiley } from './dsp'
import { RealFft, hannWindow } from './fft'

/** A uniformly sampled curve: value j describes time j / rate (seconds). */
export interface Envelope {
  data: Float32Array
  rate: number
}

export interface SpectralOnsets {
  /** Onset strength (local-mean subtracted, >= 0). Frame j is centred on time j / rate. */
  flux: Envelope
  /** Band energies, NUM_BANDS values per flux frame (row-major). */
  bands: Float32Array
}

export interface LowBandEnvelope {
  /** Energy of the < 400 Hz band; value j covers samples [j*hop, (j+1)*hop), centred on (j + 0.5) / rate. */
  energy: Envelope
  /** Seconds the low-pass filter delays the kick's envelope (subtract to get true onset time). */
  delay: number
}

/** Upper edges (Hz) of the timbre bands; the last band runs up to Nyquist. */
const BAND_EDGES = [100, 200, 400, 800, 1600, 3200, 6400]
export const NUM_BANDS = BAND_EDGES.length + 1

/**
 * Seconds between flux frames (~43 frames/s). Precise beat *phase* comes from the kick
 * envelope, and tempo is measured over the whole track, so the onset envelope does not need
 * finer time steps; halving the frame count halves the cost of this, the most expensive stage.
 */
const FLUX_HOP_SECONDS = 0.0232

/** Hop (samples) between flux frames for a sample rate. */
export function fluxHop(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * FLUX_HOP_SECONDS))
}

/** Power-of-two frame size closest to ~46 ms (1024 at 22.05 kHz). */
function fluxFrameSize(sampleRate: number): number {
  return Math.pow(2, Math.max(6, Math.round(Math.log2(sampleRate * 0.0464))))
}

/** Replace v[j] by max(0, v[j] - mean(v[j-r .. j+r])) using a running sum (O(n)). */
export function subtractLocalMean(v: Float32Array, radius: number): void {
  const n = v.length
  if (n === 0) return
  const src = Float32Array.from(v)
  let sum = 0
  let count = 0
  // Prime the window with [0, radius].
  for (let i = 0; i <= Math.min(radius, n - 1); i++) {
    sum += src[i]
    count++
  }
  for (let j = 0; j < n; j++) {
    const d = src[j] - sum / count
    v[j] = d > 0 ? d : 0
    const add = j + radius + 1
    const drop = j - radius
    if (add < n) {
      sum += src[add]
      count++
    }
    if (drop >= 0) {
      sum -= src[drop]
      count--
    }
  }
}

export function spectralOnsets(x: Float32Array, sampleRate: number): SpectralOnsets {
  const hop = fluxHop(sampleRate)
  const N = fluxFrameSize(sampleRate)
  const fft = new RealFft(N)
  const window = hannWindow(N)
  const power = new Float32Array(fft.bins)

  // Log-frequency filterbank: bins below K0 (~340 Hz) stay separate (they are already ~1-2
  // semitones wide); above, bins are summed into semitone-wide bands. This mirrors pitch
  // perception, stops the many treble bins from dominating the flux, and means far fewer logs.
  const K0 = Math.max(4, Math.round(344 / (sampleRate / N)))
  const bankOf = new Uint16Array(fft.bins)
  for (let k = 1; k < fft.bins; k++) bankOf[k] = k <= K0 ? k : K0 + Math.floor(12 * Math.log2(k / K0))
  const nBank = bankOf[fft.bins - 1] + 1
  const bank = new Float64Array(nBank)
  const prevLog = new Float64Array(nBank)

  const nFrames = x.length === 0 ? 0 : Math.floor((x.length - 1) / hop) + 1
  const flux = new Float32Array(nFrames)
  const bands = new Float32Array(nFrames * NUM_BANDS)

  // Map each FFT bin to its timbre band once.
  const binBand = new Uint8Array(fft.bins)
  for (let k = 0; k < fft.bins; k++) {
    const f = (k * sampleRate) / N
    let b = 0
    while (b < BAND_EDGES.length && f >= BAND_EDGES[b]) b++
    binBand[k] = b
  }

  // Magnitudes are normalised so a full-scale sine reads ~1 (Hann window sum = N/2, and the
  // energy splits over +/- frequency, hence the factor 4/N). The log gain 1000 makes the
  // compression roughly logarithmic for anything above -60 dBFS.
  const norm = 4 / N
  const norm2 = norm * norm
  const gain = 1000
  for (let j = 0; j < nFrames; j++) {
    fft.powerAt(x, j * hop, window, power)
    bank.fill(0)
    const bo = j * NUM_BANDS
    for (let k = 1; k < fft.bins; k++) {
      const p = power[k]
      bands[bo + binBand[k]] += p * norm2
      bank[bankOf[k]] += Math.sqrt(p) * norm
    }
    let f = 0
    for (let b = 1; b < nBank; b++) {
      const l = Math.log(1 + gain * bank[b])
      const d = l - prevLog[b]
      if (d > 0) f += d
      prevLog[b] = l
    }
    flux[j] = j === 0 ? 0 : f / nBank
  }

  const rate = sampleRate / hop
  subtractLocalMean(flux, Math.round(rate * 0.25))
  return { flux: { data: flux, rate }, bands }
}

/** Kick-band cutoff (Hz), see the header comment. */
const LOW_CUTOFF = 400

export function lowBandEnvelope(x: Float32Array, sampleRate: number): LowBandEnvelope {
  const hop = Math.max(1, Math.round(sampleRate * 0.0029))
  const coeffs = linkwitzRiley('lowpass', LOW_CUTOFF, sampleRate)
  const filter = new BiquadChain(coeffs)
  const n = Math.ceil(x.length / hop)
  const energy = new Float32Array(n)
  const hopsPerChunk = 256
  const buf = new Float32Array(hop * hopsPerChunk)
  for (let h0 = 0; h0 < n; h0 += hopsPerChunk) {
    const s0 = h0 * hop
    const len = Math.min(buf.length, x.length - s0)
    filter.process(x.subarray(s0, s0 + len), len, buf)
    for (let i = 0, h = h0; i < len; h++) {
      const end = Math.min(len, i + hop)
      let e = 0
      for (; i < end; i++) e += buf[i] * buf[i]
      energy[h] = e
    }
  }
  // Kicks have their fundamental around 45-70 Hz; measure the filter's delay there.
  return { energy: { data: energy, rate: sampleRate / hop }, delay: groupDelay(coeffs, 60, sampleRate) }
}
