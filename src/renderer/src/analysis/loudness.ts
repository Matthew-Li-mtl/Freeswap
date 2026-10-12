// Integrated loudness after ITU-R BS.1770 (the "LUFS" used by streaming services and EBU R128).
//
// Peak level says little about how loud music *sounds*; heavily compressed masters sound far
// louder than dynamic ones at the same peak. BS.1770 approximates perceived loudness by:
//   1. K-weighting: a high-shelf (+4 dB above ~1.7 kHz, modelling the acoustic effect of the
//      head) followed by a high-pass at ~38 Hz (we hear deep bass as quieter).
//   2. Mean square energy over 400 ms blocks, overlapping by 75 % (a new block every 100 ms).
//      Block loudness = -0.691 + 10*log10(mean square). The -0.691 constant makes a 0 dBFS
//      1 kHz sine read -3.01 LUFS on one channel.
//   3. Gating, so silence and quiet passages don't drag the average down:
//      - absolute gate: drop blocks below -70 LUFS;
//      - relative gate: drop blocks more than 10 LU below the average of what remains.
//   4. Integrated loudness = loudness of the mean energy of the surviving blocks.
//
// The filter coefficients in the standard are given for 48 kHz only. Like libebur128 we
// re-derive them for any sample rate from the analogue prototype (centre frequency, Q, gain)
// with the bilinear transform; at 48 kHz this reproduces the standard's numbers exactly.
// (The generic RBJ shelf formula is close but not identical: it reads a 1 kHz tone ~0.25 dB
// low, because its shelf has a slightly different mid-band shape.)

import { BiquadChain, type BiquadCoeffs } from './dsp'

const SHELF_HZ = 1681.974450955533
const SHELF_DB = 3.999843853973347
const SHELF_Q = 0.7071752369554196
const HIGHPASS_HZ = 38.13547087602444
const HIGHPASS_Q = 0.5003270373238773

/**
 * The two K-weighting biquads (high shelf, then high-pass) for a sample rate, derived as in
 * libebur128. K = tan(pi * f0 / fs) is the pre-warped analogue frequency of the bilinear
 * transform; Vh is the shelf's high-frequency gain and Vb its mid-band gain.
 */
export function kWeighting(sampleRate: number): BiquadCoeffs[] {
  let K = Math.tan((Math.PI * SHELF_HZ) / sampleRate)
  const Vh = Math.pow(10, SHELF_DB / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / SHELF_Q + K * K
  const shelf: BiquadCoeffs = {
    b0: (Vh + (Vb * K) / SHELF_Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / SHELF_Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / SHELF_Q + K * K) / a0
  }
  K = Math.tan((Math.PI * HIGHPASS_HZ) / sampleRate)
  a0 = 1 + K / HIGHPASS_Q + K * K
  const highPass: BiquadCoeffs = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / HIGHPASS_Q + K * K) / a0
  }
  return [shelf, highPass]
}

/** Integrated loudness in LUFS of a single channel, or null if everything is gated out. */
export function integratedLoudness(x: Float32Array, sampleRate: number): number | null {
  const filter = new BiquadChain(kWeighting(sampleRate))
  // Mean square of each 100 ms step; a 400 ms gating block is the mean of 4 consecutive steps.
  const step = Math.max(1, Math.round(sampleRate * 0.1))
  const nSteps = Math.floor(x.length / step)
  if (nSteps < 4) return null
  const stepMs = new Float64Array(nSteps)
  const buf = new Float32Array(step)
  for (let s = 0; s < nSteps; s++) {
    filter.process(x.subarray(s * step, (s + 1) * step), step, buf)
    let e = 0
    for (let i = 0; i < step; i++) e += buf[i] * buf[i]
    stepMs[s] = e / step
  }

  const nBlocks = nSteps - 3
  const blockMs = new Float64Array(nBlocks)
  for (let b = 0; b < nBlocks; b++) {
    blockMs[b] = (stepMs[b] + stepMs[b + 1] + stepMs[b + 2] + stepMs[b + 3]) / 4
  }

  const toLufs = (ms: number): number => -0.691 + 10 * Math.log10(ms)
  const absGateMs = Math.pow(10, (-70 + 0.691) / 10)
  let sum = 0
  let count = 0
  for (let b = 0; b < nBlocks; b++) {
    if (blockMs[b] > absGateMs) {
      sum += blockMs[b]
      count++
    }
  }
  if (count === 0) return null
  const relGateMs = Math.pow(10, (toLufs(sum / count) - 10 + 0.691) / 10)
  sum = 0
  count = 0
  for (let b = 0; b < nBlocks; b++) {
    if (blockMs[b] > absGateMs && blockMs[b] > relGateMs) {
      sum += blockMs[b]
      count++
    }
  }
  return count === 0 ? null : toLufs(sum / count)
}

/** Reference level the auto-gain aims for. */
export const TARGET_LUFS = -10

/** Trim (dB) that brings a track measured at `lufs` to the target, limited to +/-12 dB. */
export function gainForLoudness(lufs: number): number {
  return Math.max(-12, Math.min(12, TARGET_LUFS - lufs))
}
