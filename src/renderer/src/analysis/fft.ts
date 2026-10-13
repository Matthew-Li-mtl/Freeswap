// Fast Fourier Transform.
//
// The FFT computes the Discrete Fourier Transform X[k] = sum_n x[n] e^(-2*pi*i*k*n/N) in
// O(N log N) instead of O(N^2). We use the classic iterative radix-2 Cooley-Tukey form:
//   1. reorder the input into "bit-reversed" index order, then
//   2. run log2(N) passes of "butterflies", each combining pairs of half-size DFTs.
// Bit-reversal tables and twiddle factors (the e^(-2*pi*i*k/N) constants) only depend on N,
// so they are computed once per size and cached.
//
// Audio is real-valued, and a real signal's spectrum is conjugate-symmetric, so half the work
// of a complex FFT would be wasted. `RealFft` uses the standard packing trick: treat the N real
// samples as N/2 complex numbers (even samples = real part, odd samples = imaginary part), run
// one N/2-point complex FFT, then "untangle" the result into the N/2+1 unique bins.

interface Plan {
  n: number
  rev: Uint32Array
  cos: Float64Array // cos(2*pi*k/n), k < n/2
  sin: Float64Array // sin(2*pi*k/n), k < n/2
}

const plans = new Map<number, Plan>()

function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0
}

function getPlan(n: number): Plan {
  let plan = plans.get(n)
  if (plan) return plan
  if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`)
  const bits = Math.round(Math.log2(n))
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const half = n >> 1
  const cos = new Float64Array(Math.max(1, half))
  const sin = new Float64Array(Math.max(1, half))
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n)
    sin[k] = Math.sin((2 * Math.PI * k) / n)
  }
  plan = { n, rev, cos, sin }
  plans.set(n, plan)
  return plan
}

/**
 * In-place complex FFT of (re, im), both of power-of-two length.
 * Forward uses e^(-i...) and is unscaled; inverse uses e^(+i...) and divides by N.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  if (im.length !== n) throw new Error('re and im must have the same length')
  if (n <= 1) return
  const { rev, cos, sin } = getPlan(n)

  // Step 1: bit-reversal permutation (swap each pair once).
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }

  // Step 2: butterflies. A radix-2 pass merges pairs of DFTs of length h into DFTs of length 2h:
  //   X[k]     = E[k] + W^k * O[k]
  //   X[k + h] = E[k] - W^k * O[k]
  // where E/O are the DFTs of the even/odd halves and W = e^(-2*pi*i/(2h)).
  // We do two such passes at a time ("radix 2^2"): each group of 4 values is loaded once,
  // pushed through both passes in local variables, and stored once. The arithmetic is the same
  // as two separate passes, but memory traffic (the real bottleneck in JS) is halved.
  const sign = inverse ? 1 : -1
  let m = 1 // length of the sub-DFTs completed so far
  if (n >= 4) {
    // The first two passes only use the twiddles 1 and -i (or +i for the inverse), so they
    // become one multiplication-free 4-point DFT per group of 4.
    for (let a = 0; a < n; a += 4) {
      const r0 = re[a] + re[a + 1]
      const i0 = im[a] + im[a + 1]
      const r1 = re[a] - re[a + 1]
      const i1 = im[a] - im[a + 1]
      const r2 = re[a + 2] + re[a + 3]
      const i2 = im[a + 2] + im[a + 3]
      // (x2 - x3) * (sign * i)
      const r3 = -sign * (im[a + 2] - im[a + 3])
      const i3 = sign * (re[a + 2] - re[a + 3])
      re[a] = r0 + r2
      im[a] = i0 + i2
      re[a + 2] = r0 - r2
      im[a + 2] = i0 - i2
      re[a + 1] = r1 + r3
      im[a + 1] = i1 + i3
      re[a + 3] = r1 - r3
      im[a + 3] = i1 - i3
    }
    m = 4
  }
  // Paired passes: sub-DFTs of length m -> 2m -> 4m. Values sit at s, s+m, s+2m, s+3m.
  //   pass 1 (twiddle w1 = W_2m^k):   b0,b1 = a0 +/- w1*a1     b2,b3 = a2 +/- w1*a3
  //   pass 2 (twiddle w2 = W_4m^k):   y0,y2 = b0 +/- w2*b2     y1,y3 = b1 +/- (-i)*w2*b3
  // (the second butterfly's twiddle is W_4m^(k+m) = W_4m^k * W_4m^m = w2 * -i).
  for (; 4 * m <= n; m *= 4) {
    const step = n / (4 * m) // twiddle table stride for W_4m
    for (let k = 0; k < m; k++) {
      const w1r = cos[2 * k * step]
      const w1i = sign * sin[2 * k * step]
      const w2r = cos[k * step]
      const w2i = sign * sin[k * step]
      for (let i0 = k; i0 < n; i0 += 4 * m) {
        const i1 = i0 + m
        const i2 = i1 + m
        const i3 = i2 + m
        let xr = re[i1] * w1r - im[i1] * w1i
        let xi = re[i1] * w1i + im[i1] * w1r
        const b0r = re[i0] + xr
        const b0i = im[i0] + xi
        const b1r = re[i0] - xr
        const b1i = im[i0] - xi
        xr = re[i3] * w1r - im[i3] * w1i
        xi = re[i3] * w1i + im[i3] * w1r
        const b2r = re[i2] + xr
        const b2i = im[i2] + xi
        const b3r = re[i2] - xr
        const b3i = im[i2] - xi
        const c2r = b2r * w2r - b2i * w2i
        const c2i = b2r * w2i + b2i * w2r
        const dr = b3r * w2r - b3i * w2i
        const di = b3r * w2i + b3i * w2r
        const c3r = -sign * di // (dr + i*di) * (sign * i)
        const c3i = sign * dr
        re[i0] = b0r + c2r
        im[i0] = b0i + c2i
        re[i2] = b0r - c2r
        im[i2] = b0i - c2i
        re[i1] = b1r + c3r
        im[i1] = b1i + c3i
        re[i3] = b1r - c3r
        im[i3] = b1i - c3i
      }
    }
  }
  // An odd number of passes leaves one ordinary radix-2 pass (or the only pass when n = 2).
  if (m < n) {
    const step = n / (2 * m)
    for (let k = 0; k < m; k++) {
      const wr = cos[k * step]
      const wi = sign * sin[k * step]
      for (let a = k; a < n; a += 2 * m) {
        const b = a + m
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/** Periodic Hann window, the usual choice for STFT analysis (low spectral leakage). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/**
 * FFT of a real frame of length N (power of two, >= 4). Owns its scratch buffers so calling it
 * once per frame allocates nothing.
 */
export class RealFft {
  readonly size: number
  /** Number of unique output bins: N/2 + 1 (DC .. Nyquist). */
  readonly bins: number
  /** Real/imaginary parts of the last transform, length `bins`. */
  readonly outRe: Float64Array
  readonly outIm: Float64Array
  private zr: Float64Array
  private zi: Float64Array
  private cos: Float64Array
  private sin: Float64Array

  constructor(n: number) {
    if (!isPowerOfTwo(n) || n < 4) throw new Error(`RealFft size must be a power of two >= 4, got ${n}`)
    this.size = n
    this.bins = n / 2 + 1
    this.outRe = new Float64Array(this.bins)
    this.outIm = new Float64Array(this.bins)
    this.zr = new Float64Array(n / 2)
    this.zi = new Float64Array(n / 2)
    // Twiddles for the untangling step: W^k = e^(-2*pi*i*k/N) for k = 0..N/2.
    this.cos = new Float64Array(this.bins)
    this.sin = new Float64Array(this.bins)
    for (let k = 0; k < this.bins; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n)
      this.sin[k] = Math.sin((2 * Math.PI * k) / n)
    }
  }

  /** Transform `frame` (length N); the result lands in outRe/outIm. */
  forward(frame: Float64Array | Float32Array): void {
    const m = this.size / 2
    const { zr, zi, outRe, outIm, cos, sin } = this
    // Pack: z[n] = x[2n] + i*x[2n+1]
    for (let i = 0; i < m; i++) {
      zr[i] = frame[2 * i]
      zi[i] = frame[2 * i + 1]
    }
    fft(zr, zi)
    // Untangle. With Z = FFT(z) and M = N/2:
    //   Xe[k] = (Z[k] + conj(Z[M-k])) / 2        (spectrum of the even samples)
    //   Xo[k] = (Z[k] - conj(Z[M-k])) / (2i)     (spectrum of the odd samples)
    //   X[k]  = Xe[k] + W^k * Xo[k]
    for (let k = 0; k <= m; k++) {
      const ka = k === m ? 0 : k
      const kb = k === 0 ? 0 : m - k
      const ar = zr[ka]
      const ai = zi[ka]
      const br = zr[kb]
      const bi = zi[kb]
      const er = 0.5 * (ar + br)
      const ei = 0.5 * (ai - bi)
      const or = 0.5 * (ai + bi)
      const oi = -0.5 * (ar - br)
      const wr = cos[k]
      const wi = -sin[k]
      outRe[k] = er + wr * or - wi * oi
      outIm[k] = ei + wr * oi + wi * or
    }
  }

  /** Magnitude spectrum |X[k]| of `frame`, written into `out` (length >= N/2 + 1). */
  magnitude(frame: Float64Array | Float32Array, out: Float32Array | Float64Array): void {
    this.power(frame, out)
    for (let k = 0; k < this.bins; k++) out[k] = Math.sqrt(out[k])
  }

  /** Power spectrum |X[k]|^2 of `frame`, written into `out` (length >= N/2 + 1). */
  power(frame: Float64Array | Float32Array, out: Float32Array | Float64Array): void {
    const m = this.size / 2
    const { zr, zi } = this
    for (let i = 0; i < m; i++) {
      zr[i] = frame[2 * i]
      zi[i] = frame[2 * i + 1]
    }
    this.untanglePower(out)
  }

  /**
   * Power spectrum of the Hann-windowed (or any window) frame of `signal` centred on sample
   * `center`, zero-padded past the ends. Windowing, packing and transforming happen in one go,
   * so no intermediate frame buffer is needed. This is the STFT inner loop.
   */
  powerAt(signal: Float32Array, center: number, window: Float64Array, out: Float32Array | Float64Array): void {
    const m = this.size / 2
    const { zr, zi } = this
    const start = center - m
    if (start >= 0 && start + this.size <= signal.length) {
      for (let i = 0, j = start; i < m; i++, j += 2) {
        zr[i] = signal[j] * window[2 * i]
        zi[i] = signal[j + 1] * window[2 * i + 1]
      }
    } else {
      const n = signal.length
      for (let i = 0; i < m; i++) {
        const j = start + 2 * i
        zr[i] = j >= 0 && j < n ? signal[j] * window[2 * i] : 0
        zi[i] = j + 1 >= 0 && j + 1 < n ? signal[j + 1] * window[2 * i + 1] : 0
      }
    }
    this.untanglePower(out)
  }

  /** FFT of the packed input in zr/zi, then untangle straight into |X[k]|^2. */
  private untanglePower(out: Float32Array | Float64Array): void {
    const m = this.size / 2
    const { zr, zi, cos, sin } = this
    fft(zr, zi)
    // DC and Nyquist are real: X[0] = Z0r + Z0i, X[N/2] = Z0r - Z0i.
    const dc = zr[0] + zi[0]
    const ny = zr[0] - zi[0]
    out[0] = dc * dc
    out[m] = ny * ny
    for (let k = 1; k < m; k++) {
      const kb = m - k
      const ar = zr[k]
      const ai = zi[k]
      const br = zr[kb]
      const bi = zi[kb]
      const er = ar + br // 2 * Xe
      const ei = ai - bi
      const or = ai + bi // 2 * Xo
      const oi = br - ar
      const wr = cos[k]
      const wi = -sin[k]
      const xr = 0.5 * (er + wr * or - wi * oi)
      const xi = 0.5 * (ei + wr * oi + wi * or)
      out[k] = xr * xr + xi * xi
    }
  }
}

/**
 * Copy a windowed frame centred on sample `center` into `frame`, zero-padding past either end
 * of the signal. Centring frames (instead of starting them at `center`) makes "frame j" describe
 * time j*hop/sampleRate, which keeps every envelope in this module easy to align.
 */
export function fillFrame(signal: Float32Array, center: number, window: Float64Array, frame: Float64Array): void {
  const n = window.length
  const start = center - (n >> 1)
  if (start >= 0 && start + n <= signal.length) {
    for (let i = 0; i < n; i++) frame[i] = signal[start + i] * window[i]
    return
  }
  for (let i = 0; i < n; i++) {
    const s = start + i
    frame[i] = s >= 0 && s < signal.length ? signal[s] * window[i] : 0
  }
}
