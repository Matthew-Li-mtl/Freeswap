import { describe, expect, it } from 'vitest'
import { Biquad, BiquadChain, decimate2, groupDelay, highShelf, linkwitzRiley, lowpass } from '../dsp'

function sine(freq: number, sr: number, seconds: number, amp = 1): Float32Array {
  const x = new Float32Array(Math.round(sr * seconds))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return x
}

/** Peak |x| over the middle half (away from start-up and truncation transients). */
function steadyPeak(x: Float32Array): number {
  let m = 0
  for (let i = x.length >> 2; i < (3 * x.length) >> 2; i++) m = Math.max(m, Math.abs(x[i]))
  return m
}

describe('biquad filters', () => {
  it('low-pass passes low and blocks high frequencies', () => {
    const sr = 22050
    const lo = sine(50, sr, 1)
    new Biquad(lowpass(500, sr)).process(lo)
    expect(steadyPeak(lo)).toBeCloseTo(1, 2)
    const hi = sine(5000, sr, 1)
    new BiquadChain(linkwitzRiley('lowpass', 500, sr)).process(hi)
    expect(steadyPeak(hi)).toBeLessThan(0.001) // 4th order: ~-80 dB at 10x the cutoff
  })

  it('Linkwitz-Riley crossover is -6 dB at the cutoff', () => {
    const sr = 22050
    const x = sine(1000, sr, 1)
    new BiquadChain(linkwitzRiley('highpass', 1000, sr)).process(x)
    expect(steadyPeak(x)).toBeCloseTo(0.5, 2)
  })

  it('high shelf applies its gain at high frequencies only', () => {
    const sr = 48000
    const c = highShelf(1500, sr, 6)
    const hi = sine(15000, sr, 0.5)
    new Biquad(c).process(hi)
    expect(20 * Math.log10(steadyPeak(hi))).toBeCloseTo(6, 0)
    const lo = sine(50, sr, 0.5)
    new Biquad(c).process(lo)
    expect(20 * Math.log10(steadyPeak(lo))).toBeCloseTo(0, 1)
  })

  it('reports the group delay of a low-pass (about sqrt(2)/(2 pi fc) per Butterworth section)', () => {
    const sr = 22050
    const d = groupDelay([lowpass(150, sr)], 1, sr)
    expect(d).toBeCloseTo(Math.SQRT2 / (2 * Math.PI * 150), 4)
  })

  it('chunked processing equals one-shot processing', () => {
    const sr = 22050
    const x = sine(440, sr, 0.2)
    const a = Float32Array.from(x)
    new Biquad(lowpass(1000, sr)).process(a)
    const b = Float32Array.from(x)
    const f = new Biquad(lowpass(1000, sr))
    for (let i = 0; i < b.length; i += 1000) f.process(b.subarray(i, Math.min(b.length, i + 1000)))
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6)
  })
})

describe('decimate2', () => {
  it('halves the length (rounding up)', () => {
    expect(decimate2(new Float32Array(1001)).length).toBe(501)
    expect(decimate2(new Float32Array(1000)).length).toBe(500)
  })

  it('keeps in-band content and removes what would alias', () => {
    const sr = 44100
    const pass = decimate2(sine(1000, sr, 1))
    expect(steadyPeak(pass)).toBeCloseTo(1, 2)
    const stop = decimate2(sine(15000, sr, 1)) // above the new Nyquist of 11025 Hz
    expect(20 * Math.log10(steadyPeak(stop))).toBeLessThan(-60)
  })

  it('adds no delay: output m is aligned with input 2m', () => {
    const x = new Float32Array(2000)
    x[1000] = 1
    const y = decimate2(x)
    let best = 0
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[best])) best = i
    expect(best).toBe(500)
    expect(y[500]).toBeCloseTo(0.5, 6)
  })
})
