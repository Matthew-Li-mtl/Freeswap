import { describe, expect, it } from 'vitest'
import { analyzeAudio } from '../analyze'
import { foldBpm, snapBpm } from '../tempo'
import { type KickShape, chordTrack, circDiff, drumTrack, loopTrack, rng } from './synth'

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
    const x = chordTrack({
      sampleRate: 22050,
      chords: [
        [57, 60, 64],
        [53, 57, 60]
      ],
      secondsPerChord: 4,
      repeats: 5
    })
    expect(analyzeAudio(x, 22050, { bpmLow: 75 }).grid).toBeNull()
  })
})
