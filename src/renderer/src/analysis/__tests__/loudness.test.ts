import { describe, expect, it } from 'vitest'
import { gainForLoudness, integratedLoudness, kWeighting } from '../loudness'

function sine(freq: number, sr: number, seconds: number, amp: number): Float32Array {
  const x = new Float32Array(Math.round(sr * seconds))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return x
}

describe('integratedLoudness', () => {
  it('reproduces the 48 kHz K-weighting coefficients from ITU-R BS.1770', () => {
    const [shelf, hp] = kWeighting(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10)
    expect([hp.b0, hp.b1, hp.b2]).toEqual([1, -2, 1])
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10)
  })

  it('reads a full-scale 1 kHz sine as about -3 LUFS (single channel)', () => {
    for (const sr of [48000, 44100, 22050]) {
      const l = integratedLoudness(sine(1000, sr, 5, 1), sr)
      expect(l).not.toBeNull()
      expect(l as number).toBeCloseTo(-3.01, 1)
    }
  })

  it('scales with level', () => {
    const l = integratedLoudness(sine(1000, 48000, 5, 0.1), 48000)
    expect(l as number).toBeCloseTo(-23.01, 1)
  })

  it('K-weighting: deep bass counts less, treble a bit more', () => {
    const bass = integratedLoudness(sine(30, 48000, 5, 1), 48000) as number
    const treble = integratedLoudness(sine(8000, 48000, 5, 1), 48000) as number
    expect(bass).toBeLessThan(-5)
    expect(treble).toBeGreaterThan(-3.01 + 3)
  })

  it('gates out silence and much quieter passages', () => {
    const sr = 22050
    const loud = sine(1000, sr, 10, 1)
    const withSilence = new Float32Array(loud.length * 2)
    withSilence.set(loud)
    // Blocks straddling the edge are partly silent but still pass the gates, so the result
    // dips slightly below the sine's own -3.01.
    expect(Math.abs((integratedLoudness(withSilence, sr) as number) + 3.01)).toBeLessThan(0.4)
    const withQuiet = Float32Array.from(withSilence)
    withQuiet.set(sine(1000, sr, 10, 0.03), loud.length) // -30 dB: below the relative gate
    expect(Math.abs((integratedLoudness(withQuiet, sr) as number) + 3.01)).toBeLessThan(0.4)
  })

  it('returns null for silence or very short input', () => {
    expect(integratedLoudness(new Float32Array(48000), 48000)).toBeNull()
    expect(integratedLoudness(sine(1000, 48000, 0.2, 1), 48000)).toBeNull()
  })
})

describe('gainForLoudness', () => {
  it('targets -10 LUFS and clamps to +/-12 dB', () => {
    expect(gainForLoudness(-14)).toBe(4)
    expect(gainForLoudness(-6)).toBe(-4)
    expect(gainForLoudness(-40)).toBe(12)
    expect(gainForLoudness(5)).toBe(-12)
  })
})
