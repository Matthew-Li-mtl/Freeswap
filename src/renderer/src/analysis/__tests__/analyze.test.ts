import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WAVEFORM_RATE } from '../../../../shared/types'
import { analyzeAudio } from '../analyze'
import type { AnalysisRequest, AnalysisResponse } from '../protocol'
import { drumTrack, musicTrack } from './synth'

describe('analyzeAudio', () => {
  it('returns all fields with the original duration after decimation', () => {
    const sr = 44100
    const tr = drumTrack({ bpm: 126, sampleRate: sr, duration: 45, offset: 0.25 })
    const x = tr.signal.subarray(0, tr.signal.length - 3) // odd length
    const r = analyzeAudio(x, sr, { bpmLow: 75 })
    expect(r.duration).toBeCloseTo(x.length / sr, 12)
    expect(r.waveform.length).toBe(Math.ceil(r.duration * WAVEFORM_RATE) * 4)
    expect(r.bpm).toBe(126)
    expect(r.gainDb).not.toBeNull()
    expect(r.key).not.toBeNull()
  })

  it('reports everything as unknown for silence', () => {
    const r = analyzeAudio(new Float32Array(48000 * 10), 48000, { bpmLow: 75 })
    expect(r).toMatchObject({ bpm: null, grid: null, key: null, gainDb: null })
    expect(r.waveform.every((v) => v === 0)).toBe(true)
  })

  it('suggests a gain toward -10 LUFS (stereo-equivalent)', () => {
    const sr = 22050
    const x = new Float32Array(sr * 10)
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / sr)
    // Mono -23 LUFS + 3 dB stereo compensation = -20 -> +10 dB to reach -10.
    expect(analyzeAudio(x, sr, { bpmLow: 75 }).gainDb).toBeCloseTo(10, 1)
  })

  it('analyses a 6-minute 22.05 kHz track quickly', () => {
    const sr = 22050
    const tr = musicTrack({ sampleRate: sr, bpm: 128, duration: 360, offset: 0.4 })
    analyzeAudio(tr.signal.subarray(0, sr * 20), sr, { bpmLow: 75 }) // warm up the JIT
    const t0 = performance.now()
    const r = analyzeAudio(tr.signal, sr, { bpmLow: 75 })
    const ms = performance.now() - t0
    console.log(`analyzeAudio, 6 min @ 22.05 kHz: ${ms.toFixed(0)} ms`)
    expect(r.bpm).toBe(128)
    expect(r.key).toBe(21) // A minor
    expect(ms).toBeLessThan(5000) // generous for slow CI machines; ~0.6 s on a laptop
  }, 60000)
})

describe('worker', () => {
  type Handler = (e: { data: AnalysisRequest }) => void
  const scope: { onmessage: Handler | null; postMessage: ReturnType<typeof vi.fn> } = {
    onmessage: null,
    postMessage: vi.fn()
  }

  beforeAll(async () => {
    vi.stubGlobal('self', scope)
    await import('../worker')
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('posts the result and transfers the waveform buffer', () => {
    const mono = new Float32Array(22050 * 3)
    scope.onmessage?.({ data: { id: 7, mono, sampleRate: 22050, bpmLow: 75 } })
    const [msg, transfer] = scope.postMessage.mock.calls[0] as [AnalysisResponse, ArrayBuffer[]]
    expect(msg.id).toBe(7)
    expect(msg.result?.waveform.length).toBe(Math.ceil(3 * WAVEFORM_RATE) * 4)
    expect(transfer[0]).toBe(msg.result?.waveform.buffer)
  })

  it('forwards the BPM hint', () => {
    // Clicks every 0.25 s fit 120 and 80 BPM equally; the hint decides.
    const sr = 22050
    const mono = new Float32Array(sr * 30)
    for (let t = 0.1; t < 29.9; t += 0.25) {
      const s0 = Math.round(t * sr)
      for (let i = 0; i < 200; i++) mono[s0 + i] += 0.5 * Math.exp(-i / 40) * Math.sin(i * 0.3)
    }
    scope.postMessage.mockClear()
    scope.onmessage?.({ data: { id: 9, mono, sampleRate: sr, bpmLow: 75, bpmHint: 80 } })
    const [msg] = scope.postMessage.mock.calls[0] as [AnalysisResponse]
    expect(msg.result?.bpm).toBe(80)
  })

  it('posts an error message when analysis throws', () => {
    scope.postMessage.mockClear()
    scope.onmessage?.({ data: { id: 8, mono: null as unknown as Float32Array, sampleRate: 22050, bpmLow: 75 } })
    const [msg] = scope.postMessage.mock.calls[0] as [AnalysisResponse]
    expect(msg.id).toBe(8)
    expect(typeof msg.error).toBe('string')
  })
})
