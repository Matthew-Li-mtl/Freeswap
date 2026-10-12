import { describe, expect, it } from 'vitest'
import { RealFft, fft, hannWindow } from '../fft'
import { rng } from './synth'

function naiveDft(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n
      outRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a)
      outIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a)
    }
  }
  return [outRe, outIm]
}

describe('fft', () => {
  it('matches a naive DFT for several sizes', () => {
    const r = rng(1)
    for (const n of [2, 4, 8, 16, 64, 256]) {
      const re = new Float64Array(n).map(() => r() * 2 - 1)
      const im = new Float64Array(n).map(() => r() * 2 - 1)
      const [er, ei] = naiveDft(re, im)
      fft(re, im)
      for (let k = 0; k < n; k++) {
        expect(re[k]).toBeCloseTo(er[k], 9)
        expect(im[k]).toBeCloseTo(ei[k], 9)
      }
    }
  })

  it('inverse undoes forward', () => {
    const r = rng(2)
    const re = new Float64Array(1024).map(() => r())
    const im = new Float64Array(1024).map(() => r())
    const re0 = Float64Array.from(re)
    const im0 = Float64Array.from(im)
    fft(re, im)
    fft(re, im, true)
    for (let i = 0; i < 1024; i++) {
      expect(re[i]).toBeCloseTo(re0[i], 10)
      expect(im[i]).toBeCloseTo(im0[i], 10)
    }
  })

  it('RealFft equals the complex FFT of a real signal', () => {
    const r = rng(3)
    for (const n of [4, 16, 512, 4096]) {
      const x = new Float64Array(n).map(() => r() * 2 - 1)
      const re = Float64Array.from(x)
      const im = new Float64Array(n)
      fft(re, im)
      const rf = new RealFft(n)
      rf.forward(x)
      for (let k = 0; k <= n / 2; k++) {
        expect(rf.outRe[k]).toBeCloseTo(re[k], 8)
        expect(rf.outIm[k]).toBeCloseTo(im[k], 8)
      }
    }
  })

  it('finds a windowed sine in the right bin with the expected magnitude', () => {
    const n = 1024
    const w = hannWindow(n)
    const frame = new Float64Array(n)
    for (let i = 0; i < n; i++) frame[i] = w[i] * Math.sin((2 * Math.PI * 50 * i) / n)
    const mag = new Float32Array(n / 2 + 1)
    new RealFft(n).magnitude(frame, mag)
    let best = 0
    for (let k = 1; k < mag.length; k++) if (mag[k] > mag[best]) best = k
    expect(best).toBe(50)
    // Hann window sum is n/2; a unit sine puts half its amplitude in the positive bin.
    expect(mag[50]).toBeCloseTo(n / 4, 6)
  })
})
