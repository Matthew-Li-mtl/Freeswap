import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WAVEFORM_RATE } from '../../../../shared/types'
import { analyzeAudio } from '../analyze'
import type { AnalysisRequest, AnalysisResponse } from '../protocol'
import { drumTrack } from './synth'

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

  it('analyses a 6-minute 44.1 kHz track in reasonable time', () => {
    const sr = 44100
    const tr = drumTrack({ bpm: 128, sampleRate: sr, duration: 360, offset: 0.61 })
    const t0 = performance.now()
    const r = analyzeAudio(tr.signal, sr, { bpmLow: 75 })
    const ms = performance.now() - t0
    console.log(`analyzeAudio, 6 min @ 44.1 kHz: ${ms.toFixed(0)} ms`)
    expect(r.bpm).toBe(128)
    expect(ms).toBeLessThan(15000) // generous for slow CI machines; ~2-2.5 s on a laptop
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

  it('posts an error message when analysis throws', () => {
    scope.postMessage.mockClear()
    scope.onmessage?.({ data: { id: 8, mono: null as unknown as Float32Array, sampleRate: 22050, bpmLow: 75 } })
    const [msg] = scope.postMessage.mock.calls[0] as [AnalysisResponse]
    expect(msg.id).toBe(8)
    expect(typeof msg.error).toBe('string')
  })
})
