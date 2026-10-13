// Track analysis entry point: waveform, loudness, key, tempo and beat grid in one pass.
//
// Two working sample rates:
//   base (~22-24 kHz): 44.1/48 kHz input is first halved. Used for loudness and for the
//     waveform's overall peak and treble band, which need the top octaves.
//   half (~11-12 kHz): the base signal halved again. Onsets, tempo, kick envelope, key and the
//     waveform's bass/mid bands only need content below ~5 kHz, and every stage is roughly
//     proportional to the number of samples, so this halves their cost. (Classic beat trackers
//     work at 8-11 kHz for the same reason.)
// Memory: besides the caller's buffer we keep at most a half-length and a quarter-length copy;
// the spectral stages keep only small per-frame summaries.

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
  /**
   * BPM from the file's tags (ID3 TBPM etc.), if any. Used to settle octave/3:2 ambiguity and,
   * when no beat can be detected, as the grid tempo. Ignored if it plainly contradicts the audio.
   */
  bpmHint?: number | null
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

  let x = mono
  let sr = sampleRate
  if (sr > 30000) {
    x = decimate2(mono)
    sr = sampleRate / 2
  }
  const half = decimate2(x, 'fast')
  const halfRate = sr / 2

  // Loudness at the base rate. (Content above ~11 kHz is dropped, which typically changes
  // the K-weighted level by well under 0.2 dB.)
  const lufs = integratedLoudness(x, sr)
  const gainDb = lufs == null ? null : Math.round(gainForLoudness(lufs + STEREO_COMPENSATION_DB) * 100) / 100

  const waveform = computeWaveform(x, sr, duration, half)
  const { flux, bands } = spectralOnsets(half, halfRate)
  const low = lowBandEnvelope(half, halfRate)
  const chroma = analyzeChroma(half, halfRate)
  const bpmLow = opts.bpmLow > 0 ? opts.bpmLow : 75
  const tempo = detectTempo({ flux, bands, low, chroma: chroma.chroma, duration }, { bpmLow, bpmHint: opts.bpmHint })
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
