import { describe, expect, it } from 'vitest'
import { analyzeAudio } from '../analyze'
import { foldBpm, snapBpm } from '../tempo'
import {
  type KickShape,
  type MusicTrackOptions,
  chordTrack,
  circDiff,
  drumTrack,
  loopTrack,
  musicTrack,
  rng
} from './synth'

/** Signed beat-phase error in ms (positive = marker late). */
function phaseErrorMs(anchor: number, truth: number, bpm: number): number {
  const T = 60 / bpm
  const d = (((anchor - truth) % T) + 1.5 * T) % T
  return (d - 0.5 * T) * 1000
}

describe('foldBpm / snapBpm', () => {
  it('folds tempi into [low, 2 * low)', () => {
    expect(foldBpm(174, 75)).toBe(87)
    expect(foldBpm(64, 75)).toBe(128)
    expect(foldBpm(150, 75)).toBe(75)
    expect(foldBpm(174, 88)).toBe(174)
  })

  it('snaps near-integers and rounds the rest to 0.01', () => {
    expect(snapBpm(127.97)).toBe(128)
    expect(snapBpm(128.039)).toBe(128)
    expect(snapBpm(128.05)).toBe(128.05)
    expect(snapBpm(92.4987)).toBe(92.5)
  })
})

interface GridCase {
  name: string
  bpm: number
  bpmLow: number
  expectBpm: number
  sampleRate: number
  offset: number
  startBeat: number
}

// Synthetic four-on-the-floor tracks: kick on every beat (louder/longer on bar starts), off-beat
// hats, a bass note per bar and a pad + louder hats in every other 8-bar phrase.
// `startBeat` > 0 starts the audio in the middle of a bar/phrase, so downbeat and phrase have to
// come from the music rather than from "the first beat is beat 1".
const cases: GridCase[] = [
  { name: '128 BPM, 44.1 kHz', bpm: 128, bpmLow: 75, expectBpm: 128, sampleRate: 44100, offset: 0.37, startBeat: 0 },
  { name: '174 BPM folded to 87', bpm: 174, bpmLow: 75, expectBpm: 87, sampleRate: 22050, offset: 0.2, startBeat: 0 },
  {
    name: '174 BPM with range 88-176',
    bpm: 174,
    bpmLow: 88,
    expectBpm: 174,
    sampleRate: 22050,
    offset: 0.2,
    startBeat: 0
  },
  {
    name: '92.5 BPM, starts mid-phrase',
    bpm: 92.5,
    bpmLow: 75,
    expectBpm: 92.5,
    sampleRate: 22050,
    offset: 1.1,
    startBeat: 8
  },
  {
    name: '124 BPM, starts on beat 3',
    bpm: 124,
    bpmLow: 75,
    expectBpm: 124,
    sampleRate: 22050,
    offset: 0.05,
    startBeat: 2
  },
  {
    name: '140 BPM, 48 kHz, starts in bar 6',
    bpm: 140,
    bpmLow: 75,
    expectBpm: 140,
    sampleRate: 48000,
    offset: 0.5,
    startBeat: 20
  }
]

describe('beat grid on synthetic tracks', () => {
  for (const c of cases) {
    it(c.name, () => {
      const tr = drumTrack({
        bpm: c.bpm,
        sampleRate: c.sampleRate,
        duration: 90,
        offset: c.offset,
        startBeat: c.startBeat
      })
      const r = analyzeAudio(tr.signal, c.sampleRate, { bpmLow: c.bpmLow })
      expect(r.bpm).not.toBeNull()
      expect(Math.abs((r.bpm as number) - c.expectBpm)).toBeLessThanOrEqual(0.02)
      const grid = r.grid
      expect(grid).not.toBeNull()
      if (!grid) return
      expect(grid.bpm).toBe(r.bpm)
      const T = 60 / c.bpm
      // Beat markers on the kick attacks.
      expect(Math.abs(phaseErrorMs(grid.anchor, tr.anchor, c.bpm))).toBeLessThan(5)
      // The anchor is a phrase start (beat "1" of an 8-bar phrase)...
      expect(circDiff(grid.anchor, tr.anchor, 32 * T)).toBeLessThan(0.005)
      // ...and normalised into the first phrase.
      expect(grid.anchor).toBeGreaterThanOrEqual(0)
      expect(grid.anchor).toBeLessThan(32 * (60 / grid.bpm))
    })
  }
})

describe('beat markers sit on the kick attack for different kick designs', () => {
  const shapes: KickShape[] = ['sweep', 'sweepClick', 'sine50', 'sine50attack5', 'sine45cos']
  for (const kick of shapes) {
    it(kick, () => {
      // A plain loop with no phrase structure: downbeat/phrase must come from "music starts here".
      const x = loopTrack({
        sampleRate: 22050,
        bpm: 124,
        offset: 0.35,
        bars: 32,
        chords: [
          [57, 60, 64],
          [57, 60, 65],
          [60, 64, 67],
          [59, 62, 67]
        ],
        bass: [33, 41, 36, 43],
        kick
      })
      const r = analyzeAudio(x, 22050, { bpmLow: 75 })
      expect(r.bpm).toBe(124)
      const grid = r.grid
      expect(grid).not.toBeNull()
      if (!grid) return
      expect(Math.abs(phaseErrorMs(grid.anchor, 0.35, 124))).toBeLessThan(3)
      expect(circDiff(grid.anchor, 0.35, 32 * (60 / 124))).toBeLessThan(0.005)
    })
  }
})

describe('no rhythm, no grid', () => {
  it('returns no grid for silence', () => {
    const r = analyzeAudio(new Float32Array(22050 * 20), 22050, { bpmLow: 75 })
    expect(r.bpm).toBeNull()
    expect(r.grid).toBeNull()
  })

  it('returns no grid for noise', () => {
    const rand = rng(11)
    const x = new Float32Array(22050 * 40).map(() => (rand() * 2 - 1) * 0.3)
    expect(analyzeAudio(x, 22050, { bpmLow: 75 }).grid).toBeNull()
  })

  it('returns no grid for slow sustained chords (periodic, but not a beat)', () => {
    const am = [57, 60, 64]
    const f = [53, 57, 60]
    const c = [60, 64, 67]
    const g = [55, 59, 62]
    // Chord changes every 4, 2 and 2.3 s are perfectly periodic, so they also fit grids at
    // multiples of their rate (e.g. 120 BPM), but they are not a beat.
    for (const [chords, secondsPerChord, repeats] of [
      [[am, f], 4, 5],
      [[am, f], 2, 10],
      [[am, f, c, g], 2.3, 5]
    ] as [number[][], number, number][]) {
      const x = chordTrack({ sampleRate: 22050, chords, secondsPerChord, repeats })
      expect(analyzeAudio(x, 22050, { bpmLow: 75 }).grid, `${secondsPerChord} s chords`).toBeNull()
    }
  })
})

interface RobustCase {
  name: string
  track: Omit<MusicTrackOptions, 'sampleRate'>
  bpmLow?: number
  /** Allowed beat-phase error (default 5 ms). */
  phaseTolMs?: number
}

// "Hard" material: the grid must still be found. Each track has kick, snare, hats, bass and
// pads; see musicTrack in synth.ts.
const robustCases: RobustCase[] = [
  { name: '60 s ambient intro, then drums', track: { bpm: 124, duration: 150, offset: 60.3, intro: 60 } },
  {
    name: 'heavily saturated drums + bass, broadband noise',
    track: { bpm: 140, duration: 90, offset: 0.2, drive: 10, noise: 0.15 }
  },
  {
    name: 'extreme saturation (drive 30) and loud noise',
    track: { bpm: 128, duration: 90, offset: 0.3, drive: 30, noise: 0.3 }
  },
  { name: 'half-time section in the middle', track: { bpm: 140, duration: 90, offset: 0.2, halfTime: [[64, 160]] } },
  {
    name: 'triplet hi-hats (trap style)',
    track: { bpm: 150, duration: 90, offset: 0.2, hats: 'triplets' },
    bpmLow: 100
  },
  {
    name: 'hyperpop-like: 158 BPM, triplet hats, half-time halves, saturation, noise',
    track: {
      bpm: 158,
      duration: 120,
      offset: 0.1,
      hats: 'triplets',
      halfTime: [
        [0, 64],
        [128, 192]
      ],
      drive: 12,
      noise: 0.1
    },
    bpmLow: 100
  },
  {
    name: 'loud saturated synth chords over half-time drums',
    track: {
      bpm: 160,
      duration: 120,
      offset: 0.3,
      drive: 20,
      padsAlways: true,
      padLevel: 0.3,
      noise: 0.1,
      halfTime: [[0, 1000]],
      hats: 'triplets'
    },
    bpmLow: 100,
    // Saturating kick + loud pads together smears the attack; a few ms of slack.
    phaseTolMs: 8
  },
  {
    name: 'quiet drums under loud pads',
    track: { bpm: 128, duration: 120, offset: 0.3, padsAlways: true, padLevel: 0.6, noise: 0.05 }
  }
]

describe('beat grid on hard material', () => {
  for (const c of robustCases) {
    it(c.name, () => {
      const tr = musicTrack({ sampleRate: 22050, ...c.track })
      const r = analyzeAudio(tr.signal, 22050, { bpmLow: c.bpmLow ?? 75 })
      expect(r.bpm).toBe(c.track.bpm)
      const grid = r.grid
      expect(grid).not.toBeNull()
      if (!grid) return
      expect(Math.abs(phaseErrorMs(grid.anchor, tr.anchor, c.track.bpm))).toBeLessThan(c.phaseTolMs ?? 5)
      expect(circDiff(grid.anchor, tr.anchor, 32 * (60 / c.track.bpm))).toBeLessThan(0.01)
    })
  }
})

describe('BPM hint (from file tags)', () => {
  /** Identical short clicks every `every` seconds: a pulse that fits several tempi equally. */
  function clicks(seconds: number, every: number): Float32Array {
    const sr = 22050
    const x = new Float32Array(sr * seconds)
    for (let t = 0.1; t < seconds; t += every) {
      const s0 = Math.round(t * sr)
      for (let i = 0; i < 200 && s0 + i < x.length; i++) x[s0 + i] += 0.5 * Math.exp(-i / 40) * Math.sin(i * 0.3)
    }
    return x
  }

  it('settles ambiguous tempi (clicks every 0.25 s fit both 120 and 80 BPM)', () => {
    const x = clicks(60, 0.25)
    expect(analyzeAudio(x, 22050, { bpmLow: 75 }).bpm).toBe(120)
    expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: 80 }).bpm).toBe(80)
    expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: 160 }).bpm).toBe(80) // any octave
  })

  it('ignores a hint the audio clearly contradicts', () => {
    const x = drumTrack({ bpm: 128, sampleRate: 22050, duration: 60, offset: 0.3 }).signal
    for (const hint of [97, 96, 140]) expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: hint }).bpm).toBe(128)
    expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: 64 }).bpm).toBe(128)
  })

  it('keeps the tag value exactly when the audio agrees', () => {
    const x = musicTrack({ sampleRate: 22050, bpm: 92.5, duration: 60, offset: 0.3 }).signal
    expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: 92.5 }).bpm).toBe(92.5)
    expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: 185 }).bpm).toBe(92.5)
  })

  it('still produces a grid at the hinted tempo when no beat is detected', () => {
    const pad = chordTrack({
      sampleRate: 22050,
      chords: [
        [57, 60, 64],
        [53, 57, 60]
      ],
      secondsPerChord: 4,
      repeats: 6
    })
    expect(analyzeAudio(pad, 22050, { bpmLow: 75 }).grid).toBeNull()
    const r = analyzeAudio(pad, 22050, { bpmLow: 75, bpmHint: 124 })
    expect(r.bpm).toBe(124)
    expect(r.grid?.bpm).toBe(124)
  })

  it('returns no grid for silence even with a hint, and ignores invalid hints', () => {
    expect(analyzeAudio(new Float32Array(22050 * 20), 22050, { bpmLow: 75, bpmHint: 128 }).grid).toBeNull()
    const x = drumTrack({ bpm: 128, sampleRate: 22050, duration: 40, offset: 0.3 }).signal
    for (const hint of [0, -5, NaN, Infinity, 1000, null]) {
      expect(analyzeAudio(x, 22050, { bpmLow: 75, bpmHint: hint }).bpm).toBe(128)
    }
  })
})
