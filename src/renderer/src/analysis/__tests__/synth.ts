// Synthetic test signals with known tempo, phase, bar/phrase structure and key.

/** Small deterministic PRNG (mulberry32) so tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Kick drum: 1 ms attack, pitch sweep 150 -> 55 Hz, exponential decay. Starts at sample 0. */
function kick(sr: number, decay: number, amp: number): Float32Array {
  const n = Math.round(sr * decay * 5)
  const out = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = 55 + 95 * Math.exp(-t / 0.02)
    phase += (2 * Math.PI * f) / sr
    const env = Math.min(1, t / 0.001) * Math.exp(-t / decay)
    out[i] = amp * env * Math.sin(phase)
  }
  return out
}

function hat(sr: number, amp: number, rand: () => number): Float32Array {
  const n = Math.round(sr * 0.06)
  const out = new Float32Array(n)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1
    out[i] = amp * (w - prev) * 0.5 * Math.exp(-i / sr / 0.012) // differenced noise = bright
    prev = w
  }
  return out
}

function addAt(dst: Float32Array, src: Float32Array, at: number): void {
  const start = Math.round(at)
  for (let i = 0; i < src.length; i++) {
    const j = start + i
    if (j >= 0 && j < dst.length) dst[j] += src[i]
  }
}

export interface DrumTrackOptions {
  bpm: number
  sampleRate: number
  duration: number
  /** Time (s) of the first generated beat. */
  offset: number
  /** Pattern index of the first generated beat; 0 = start of a phrase. */
  startBeat?: number
  seed?: number
}

export interface DrumTrack {
  signal: Float32Array
  /** True phrase-start beat time, normalised into [0, 32 beats). */
  anchor: number
}

/**
 * Four-on-the-floor pattern: kick on every beat (louder and longer on bar starts), off-beat
 * hats, a bass note per bar (changes every bar), and every other 8-bar phrase adds a chord pad
 * and doubles the hats, so phrase boundaries carry big changes.
 */
export function drumTrack(o: DrumTrackOptions): DrumTrack {
  const sr = o.sampleRate
  const T = 60 / o.bpm
  const startBeat = o.startBeat ?? 0
  const signal = new Float32Array(Math.round(o.duration * sr))
  const rand = rng(o.seed ?? 1)
  const kickAccent = kick(sr, 0.12, 0.9)
  const kickNormal = kick(sr, 0.07, 0.55)
  const hatQuiet = hat(sr, 0.12, rand)
  const hatLoud = hat(sr, 0.25, rand)
  const bassNotes = [45, 43, 41, 40] // A2 G2 F2 E2 (midi)
  const padChords = [
    [57, 60, 64],
    [55, 59, 62],
    [53, 57, 60],
    [52, 56, 59]
  ]

  for (let i = 0; ; i++) {
    const g = startBeat + i
    const t = o.offset + i * T
    if (t >= o.duration) break
    const phraseOn = Math.floor(g / 32) % 2 === 1
    addAt(signal, g % 4 === 0 ? kickAccent : kickNormal, t * sr)
    addAt(signal, phraseOn ? hatLoud : hatQuiet, (t + T / 2) * sr)
    if (g % 4 === 0) {
      // One bar of bass (and pad in "on" phrases), starting at this downbeat.
      const bar = Math.floor(g / 4) % 4
      const s0 = Math.round(t * sr)
      const s1 = Math.min(signal.length, Math.round((t + 4 * T) * sr))
      const fb = midiToHz(bassNotes[bar])
      const chord = padChords[bar].map(midiToHz)
      for (let s = s0; s < s1; s++) {
        const tt = (s - s0) / sr
        const env = Math.min(1, tt / 0.01) * Math.min(1, (s1 - s) / sr / 0.01)
        let v = 0.18 * env * Math.sin(2 * Math.PI * fb * tt)
        if (phraseOn) {
          for (const f of chord) for (let h = 1; h <= 4; h++) v += (0.03 / h) * env * Math.sin(2 * Math.PI * f * h * tt)
        }
        signal[s] += v
      }
    }
  }
  const anchor = (((o.offset - startBeat * T) % (32 * T)) + 32 * T) % (32 * T)
  return { signal, anchor }
}

export interface ChordTrackOptions {
  sampleRate: number
  /** Each chord as midi note numbers; the first note is also played as bass two octaves down. */
  chords: number[][]
  secondsPerChord: number
  repeats: number
  /** Global detuning in cents (tests tuning estimation). */
  detune?: number
  /** Add a four-on-the-floor kick at 120 BPM. */
  drums?: boolean
}

/** Sustained chords made of harmonic-rich tones (6 harmonics, 1/h amplitudes). */
export function chordTrack(o: ChordTrackOptions): Float32Array {
  const sr = o.sampleRate
  const seg = Math.round(o.secondsPerChord * sr)
  const total = seg * o.chords.length * o.repeats
  const out = new Float32Array(total)
  const ratio = Math.pow(2, (o.detune ?? 0) / 1200)
  for (let c = 0; c < o.chords.length * o.repeats; c++) {
    const notes = o.chords[c % o.chords.length]
    const freqs = [...notes.map(midiToHz), midiToHz(notes[0] - 24)].map((f) => f * ratio)
    const s0 = c * seg
    for (let i = 0; i < seg; i++) {
      const t = i / sr
      const env = Math.min(1, t / 0.02) * Math.min(1, (seg - i) / sr / 0.05) * (0.6 + 0.4 * Math.exp(-t / 0.5))
      let v = 0
      for (let n = 0; n < freqs.length; n++) {
        const f = freqs[n]
        const gain = n === freqs.length - 1 ? 0.12 : 0.06
        for (let h = 1; h <= 6 && f * h < sr / 2; h++) v += (gain / h) * Math.sin(2 * Math.PI * f * h * t)
      }
      out[s0 + i] = v * env
    }
  }
  if (o.drums) {
    const k = kick(sr, 0.08, 0.6)
    for (let t = 0; t < total / sr; t += 0.5) addAt(out, k, t * sr)
  }
  return out
}

export type KickShape = 'sweep' | 'sine50' | 'sine50attack5' | 'sweepClick' | 'sine45cos'

/**
 * Kick variants for testing beat-marker placement. The true onset is sample 0 in all cases.
 * - sweep:         pitch falls 200 -> 50 Hz (tau 30 ms), no attack ramp (typical EDM kick)
 * - sweepClick:    the same plus a 2 ms noise click
 * - sine50:        plain 50 Hz sine, starts at a zero crossing
 * - sine50attack5: plain 50 Hz with a 5 ms linear fade-in
 * - sine45cos:     45 Hz starting at the waveform's peak (cosine phase)
 */
export function shapedKick(sr: number, shape: KickShape, rand: () => number): Float32Array {
  const n = Math.round(sr * 0.4)
  const out = new Float32Array(n)
  let ph = shape === 'sine45cos' ? Math.PI / 2 : 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let f = 50
    let env = Math.exp(-t / 0.12)
    if (shape === 'sweep' || shape === 'sweepClick') f = 50 + 150 * Math.exp(-t / 0.03)
    if (shape === 'sine45cos') f = 45
    if (shape === 'sine50attack5') env *= Math.min(1, t / 0.005)
    ph += (2 * Math.PI * f) / sr
    out[i] = 0.8 * env * Math.sin(ph)
    if (shape === 'sweepClick' && i < sr * 0.002) out[i] += 0.3 * (rand() * 2 - 1)
  }
  return out
}

export interface LoopTrackOptions {
  sampleRate: number
  bpm: number
  /** Time of the first kick (= first chord, = phrase start). */
  offset: number
  bars: number
  /** One chord per bar, cycling: triads as midi notes, harmonics 1-4 at 1/h amplitude. */
  chords: number[][]
  /** Sine bass note (midi) per chord. */
  bass: number[]
  kick: KickShape
}

/** A chord loop over a four-on-the-floor kick, with no other structure (no phrase changes). */
export function loopTrack(o: LoopTrackOptions): Float32Array {
  const sr = o.sampleRate
  const T = 60 / o.bpm
  const x = new Float32Array(Math.round((o.offset + o.bars * 4 * T + 1) * sr))
  const k = shapedKick(sr, o.kick, rng(7))
  for (let b = 0; b < o.bars * 4; b++) addAt(x, k, (o.offset + b * T) * sr)
  for (let bar = 0; bar < o.bars; bar++) {
    const c = bar % o.chords.length
    const s0 = Math.round((o.offset + bar * 4 * T) * sr)
    const s1 = Math.round((o.offset + (bar + 1) * 4 * T) * sr)
    const fs = o.chords[c].map(midiToHz)
    const fb = midiToHz(o.bass[c])
    for (let s = s0; s < s1; s++) {
      const t = (s - s0) / sr
      const env = Math.min(1, t / 0.01) * Math.min(1, (s1 - s) / sr / 0.01)
      let v = 0.2 * Math.sin(2 * Math.PI * fb * t)
      for (const f of fs) for (let h = 1; h <= 4; h++) v += (0.05 / h) * Math.sin(2 * Math.PI * f * h * t)
      x[s] += v * env
    }
  }
  return x
}

/** Smallest |a - b| modulo m. */
export function circDiff(a: number, b: number, m: number): number {
  const d = (((a - b) % m) + m) % m
  return Math.min(d, m - d)
}
