import { describe, expect, it } from 'vitest'
import { WAVEFORM_RATE } from '../../../../shared/types'
import { computeWaveform } from '../waveform'

function sine(freq: number, sr: number, seconds: number, amp: number): Float32Array {
  const x = new Float32Array(Math.round(sr * seconds))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return x
}

/** Mean of one byte lane (0 low, 1 mid, 2 high, 3 peak) over the middle half of the columns. */
function lane(w: Uint8Array, offset: number): number {
  const cols = w.length / 4
  let s = 0
  let n = 0
  for (let c = Math.floor(cols / 4); c < Math.floor((3 * cols) / 4); c++) {
    s += w[c * 4 + offset]
    n++
  }
  return s / n
}

describe('computeWaveform', () => {
  it('has ceil(duration * 150) columns of 4 bytes', () => {
    expect(computeWaveform(new Float32Array(22050 * 10), 22050, 10).length).toBe(1500 * 4)
    const n = 22050 * 3 + 7
    const expected = Math.ceil((n / 22050) * WAVEFORM_RATE) * 4
    expect(computeWaveform(new Float32Array(n), 22050, n / 22050).length).toBe(expected)
    expect(computeWaveform(new Float32Array(0), 22050, 0).length).toBe(0)
  })

  it('stays aligned with time over a long signal (exact fractional column boundaries)', () => {
    const sr = 44100
    const seconds = 600
    const x = new Float32Array(sr * seconds)
    const t = 543.21
    x[Math.floor(t * sr)] = 0.5
    const w = computeWaveform(x, sr, seconds)
    let best = 0
    for (let c = 0; c < w.length / 4; c++) if (w[c * 4 + 3] > w[best * 4 + 3]) best = c
    expect(best).toBe(Math.floor(t * WAVEFORM_RATE))
    expect(w[best * 4 + 3]).toBe(128)
  })

  it('splits low, mid and high bands', () => {
    const sr = 22050
    const low = computeWaveform(sine(60, sr, 2, 0.5), sr, 2)
    expect(lane(low, 0)).toBeGreaterThan(120)
    expect(lane(low, 2)).toBeLessThan(2)
    expect(Math.max(...low.filter((_, i) => i % 4 === 3))).toBeGreaterThanOrEqual(127) // ~0.5 * 255

    const mid = computeWaveform(sine(900, sr, 2, 0.5), sr, 2)
    expect(lane(mid, 1)).toBeGreaterThan(115)
    expect(lane(mid, 0)).toBeLessThan(5)
    expect(lane(mid, 2)).toBeLessThan(10)

    const high = computeWaveform(sine(6000, sr, 2, 0.5), sr, 2)
    expect(lane(high, 2)).toBeGreaterThan(120)
    expect(lane(high, 0)).toBeLessThan(2)
  })

  it('clips at full scale', () => {
    const w = computeWaveform(sine(1000, 22050, 1, 2), 22050, 1)
    expect(lane(w, 3)).toBe(255)
  })
})
