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

export interface MusicTrackOptions {
  sampleRate: number
  bpm: number
  duration: number
  /** Time of the first drum hit, which is beat 1 of a phrase. Must be >= intro. */
  offset: number
  /** Seconds of beatless ambient pad before the drums come in (default 0). */
  intro?: number
  /** Hi-hat pattern (default '8ths'). */
  hats?: '8ths' | '16ths' | 'triplets'
  /** Beat ranges [from, to) (counted from the first drum hit) played half-time: kick on 1, snare on 3. */
  halfTime?: [number, number][]
  /** Drive for tanh saturation, e.g. 8 = heavy distortion (default: none). */
  drive?: number
  /** Broadband noise amplitude (default 0.02). */
  noise?: number
  /** Chord pad level (default 0.05) and whether pads play in every phrase (default: every other). */
  padLevel?: number
  padsAlways?: boolean
  seed?: number
}

/** One cycle of a bright tone (harmonics 1-6 at 1/h), for cheap wavetable oscillators. */
const TABLE_SIZE = 4096
const toneTable = (() => {
  const t = new Float32Array(TABLE_SIZE + 1)
  for (let i = 0; i <= TABLE_SIZE; i++) {
    for (let h = 1; h <= 6; h++) t[i] += Math.sin((2 * Math.PI * h * i) / TABLE_SIZE) / h
  }
  return t
})()

/** Add a wavetable tone of `freq` Hz to dst[s0..s1) with a soft envelope. */
function addTone(dst: Float32Array, sr: number, s0: number, s1: number, freq: number, amp: number): void {
  const inc = (freq / sr) * TABLE_SIZE
  let ph = 0
  const end = Math.min(dst.length, s1)
  for (let s = Math.max(0, s0); s < end; s++) {
    const env = Math.min(1, (s - s0) / (0.01 * sr), (end - s) / (0.01 * sr))
    const i = ph | 0
    dst[s] += amp * env * (toneTable[i] + (toneTable[i + 1] - toneTable[i]) * (ph - i))
    ph += inc
    if (ph >= TABLE_SIZE) ph -= TABLE_SIZE
  }
}

/**
 * A more music-like test track: kick, snare, hats, bass line and chord pads (Am F C G, one chord
 * per bar), broadband noise, phrase structure (pads drop out every other 8-bar phrase), and
 * optional ambient intro, half-time sections and saturation.
 */
export function musicTrack(o: MusicTrackOptions): DrumTrack {
  const sr = o.sampleRate
  const T = 60 / o.bpm
  const n = Math.round(o.duration * sr)
  const x = new Float32Array(n)
  const rand = rng(o.seed ?? 3)
  const k = shapedKick(sr, 'sweep', rand)
  const snare = new Float32Array(Math.round(sr * 0.2))
  for (let i = 0; i < snare.length; i++) {
    const t = i / sr
    snare[i] = 0.35 * Math.exp(-t / 0.05) * ((rand() * 2 - 1) * 0.8 + 0.5 * Math.sin(2 * Math.PI * 190 * t))
  }
  const hatSample = hat(sr, 0.15, rand)
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [60, 64, 67],
    [55, 59, 62]
  ]
  const bass = [33, 41, 36, 43]
  const intro = o.intro ?? 0

  // Ambient intro: slow-attack pads, no drums.
  for (let t = 0, c = 0; t < intro; t += 4 * T, c++) {
    const s0 = Math.round(t * sr)
    const s1 = Math.round(Math.min(intro, t + 4 * T) * sr)
    for (const m of chords[c % 4]) addTone(x, sr, s0, s1, midiToHz(m), 0.04)
  }

  const isHalf = (b: number): boolean => (o.halfTime ?? []).some(([a, z]) => b >= a && b < z)
  for (let b = 0; ; b++) {
    const t = o.offset + b * T
    if (t >= o.duration) break
    const s = t * sr
    const inBar = b % 4
    if (isHalf(b)) {
      if (inBar === 0) addAt(x, k, s)
      if (inBar === 2) addAt(x, snare, s)
    } else {
      addAt(x, k, s)
      if (inBar === 1 || inBar === 3) addAt(x, snare, s)
    }
    const hats = o.hats ?? '8ths'
    const subdivisions = hats === '16ths' ? 4 : hats === 'triplets' ? 3 : 2
    for (let d = 0; d < subdivisions; d++) addAt(x, hatSample, s + (d * T * sr) / subdivisions)
    if (inBar === 0) {
      const bar = Math.floor(b / 4)
      const s0 = Math.round(s)
      const s1 = Math.round((t + 4 * T) * sr)
      addTone(x, sr, s0, s1, midiToHz(bass[bar % 4]), 0.15)
      if (o.padsAlways || Math.floor(b / 32) % 2 === 1) {
        for (const m of chords[bar % 4]) addTone(x, sr, s0, s1, midiToHz(m), o.padLevel ?? 0.05)
      }
    }
  }

  const noise = o.noise ?? 0.02
  for (let i = 0; i < n; i++) {
    let v = x[i] + noise * (rand() * 2 - 1)
    if (o.drive) v = Math.tanh(o.drive * v) / Math.tanh(o.drive)
    x[i] = v
  }
  const anchor = ((o.offset % (32 * T)) + 32 * T) % (32 * T)
  return { signal: x, anchor }
}

/** Smallest |a - b| modulo m. */
export function circDiff(a: number, b: number, m: number): number {
  const d = (((a - b) % m) + m) % m
  return Math.min(d, m - d)
}
