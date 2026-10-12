// Track analysis entry point: waveform, loudness, key, tempo and beat grid in one pass.
//
// Everything except loudness runs at ~22-24 kHz: musically relevant information for these
// tasks lives well below 10 kHz, and halving the rate halves the cost of every later stage.
// Memory: besides the caller's buffer we keep one half-length decimated copy; every filter
// stage works chunk by chunk, and the spectral stages keep only small per-frame summaries.

import type { AnalysisResult } from '../../../shared/types'
import { decimate2 } from './dsp'
import { analyzeChroma, estimateKey } from './key'
import { gainForLoudness, integratedLoudness } from './loudness'
import { lowBandEnvelope, spectralOnsets } from './onset'
import { detectTempo } from './tempo'
import { computeWaveform } from './waveform'

export interface AnalyzeOptions {
  /** Detected tempi are folded into [bpmLow, 2 * bpmLow). */
  bpmLow: number
}

/**
 * BS.1770 counts every channel's energy, so a stereo master with identical left and right
 * reads 3 dB louder than its (L+R)/2 mono downmix. We measure the downmix and add this back,
 * so that the -10 LUFS target means the same as in other loudness tools for typical
 * (mostly correlated) stereo music.
 */
const STEREO_COMPENSATION_DB = 3.01

/**
 * Analyse a mono ((L+R)/2) signal.
 * @param mono       samples in -1..1
 * @param sampleRate Hz
 */
export function analyzeAudio(mono: Float32Array, sampleRate: number, opts: AnalyzeOptions): AnalysisResult {
  const duration = mono.length / sampleRate

  // Loudness at the original rate: K-weighting boosts the top octave, which decimation removes.
  const lufs = integratedLoudness(mono, sampleRate)
  const gainDb = lufs == null ? null : Math.round(gainForLoudness(lufs + STEREO_COMPENSATION_DB) * 100) / 100

  let x = mono
  let sr = sampleRate
  if (sr > 30000) {
    x = decimate2(mono)
    sr = sampleRate / 2
  }

  const waveform = computeWaveform(x, sr, duration)
  const { flux, bands } = spectralOnsets(x, sr)
  const low = lowBandEnvelope(x, sr)
  const chroma = analyzeChroma(x, sr)
  const bpmLow = opts.bpmLow > 0 ? opts.bpmLow : 75
  const tempo = detectTempo({ flux, bands, low, chroma: chroma.chroma, duration }, bpmLow)
  // Key detection uses the grid (if any) to find where chord loops start.
  const key = estimateKey(chroma, tempo ? tempo.grid : null)

  return {
    duration,
    bpm: tempo ? tempo.bpm : null,
    key,
    grid: tempo ? tempo.grid : null,
    gainDb,
    waveform
  }
}
