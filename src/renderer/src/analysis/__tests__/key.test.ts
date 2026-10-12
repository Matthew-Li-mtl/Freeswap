import { describe, expect, it } from 'vitest'
import { musicalName, parseKey } from '../../../../shared/musicKey'
import { analyzeAudio } from '../analyze'
import { analyzeChroma, estimateKey } from '../key'
import { chordTrack, loopTrack, rng } from './synth'

const key = (name: string): number => parseKey(name) as number
const name = (k: number | null): string => (k == null ? 'null' : musicalName(k))

// Chord progressions (midi note triads). The first entries are "functional" progressions whose
// key is clear from note statistics alone; the second group are modal minor loops whose notes
// are identical to the relative major's, so they need the loop-start cue from the beat grid.
const functional: [string, number[][]][] = [
  [
    'Am',
    [
      [57, 60, 64],
      [62, 65, 69],
      [64, 68, 71],
      [57, 60, 64]
    ]
  ], // i iv V i
  [
    'E',
    [
      [64, 68, 71],
      [69, 73, 76],
      [71, 75, 78],
      [64, 68, 71]
    ]
  ], // I IV V I
  [
    'C',
    [
      [60, 64, 67],
      [65, 69, 72],
      [67, 71, 74],
      [60, 64, 67]
    ]
  ],
  [
    'Fm',
    [
      [65, 68, 72],
      [61, 65, 68],
      [63, 67, 70],
      [65, 68, 72]
    ]
  ], // i VI VII i
  [
    'Cm',
    [
      [60, 63, 67],
      [56, 60, 63],
      [58, 62, 65],
      [60, 63, 67]
    ]
  ],
  [
    'G',
    [
      [55, 59, 62],
      [62, 66, 69],
      [64, 67, 71],
      [60, 64, 67]
    ]
  ], // I V vi IV
  [
    'D',
    [
      [62, 66, 69],
      [67, 71, 74],
      [69, 73, 76],
      [62, 66, 69]
    ]
  ]
]
const modal: [string, number[][]][] = [
  [
    'Am',
    [
      [57, 60, 64],
      [53, 57, 60],
      [60, 64, 67],
      [55, 59, 62]
    ]
  ], // i VI III VII
  [
    'Dm',
    [
      [62, 65, 69],
      [58, 62, 65],
      [65, 69, 72],
      [60, 64, 67]
    ]
  ],
  [
    'Em',
    [
      [64, 67, 71],
      [60, 64, 67],
      [67, 71, 74],
      [62, 66, 69]
    ]
  ], // vi IV I V from vi
  [
    'F#m',
    [
      [66, 69, 73],
      [62, 66, 69],
      [69, 73, 76],
      [64, 68, 71]
    ]
  ],
  [
    'Bbm',
    [
      [58, 61, 65],
      [54, 58, 61],
      [61, 65, 68],
      [56, 60, 63]
    ]
  ]
]

describe('key detection', () => {
  it('estimates tuning offsets', () => {
    for (const cents of [0, 30, -40]) {
      const x = chordTrack({
        sampleRate: 22050,
        chords: functional[0][1],
        secondsPerChord: 2,
        repeats: 2,
        detune: cents
      })
      expect(analyzeChroma(x, 22050).tuning).toBeCloseTo(cents / 100, 1)
    }
  })

  it('finds the key of functional progressions from note statistics alone', () => {
    for (const [want, chords] of functional) {
      for (const detune of [0, 35]) {
        const x = chordTrack({ sampleRate: 22050, chords, secondsPerChord: 2, repeats: 2, detune })
        expect(name(estimateKey(analyzeChroma(x, 22050))), `${want}, detune ${detune}`).toBe(want)
      }
    }
  }, 30000)

  it('uses loop starts from the beat grid to resolve relative major/minor', () => {
    // One chord per bar at 120 BPM (2 s), loops start at t = 0.
    const grid = { bpm: 120, anchor: 0 }
    for (const [want, chords] of [...functional, ...modal]) {
      const x = chordTrack({ sampleRate: 22050, chords, secondsPerChord: 2, repeats: 2 })
      expect(name(estimateKey(analyzeChroma(x, 22050), grid)), want).toBe(want)
    }
  }, 30000)

  it('works end to end on loops with drums, sine bass and detuning (44.1 kHz)', () => {
    const cases: [string, number[][], number[]][] = [
      [
        'Am',
        [
          [57, 60, 64],
          [57, 60, 65],
          [60, 64, 67],
          [59, 62, 67]
        ],
        [33, 41, 36, 43]
      ], // Am F C G
      [
        'E',
        [
          [64, 68, 71],
          [59, 63, 66],
          [61, 64, 68],
          [57, 61, 64]
        ],
        [40, 35, 37, 45]
      ] // E B C#m A
    ]
    for (const [want, chords, bass] of cases) {
      for (const kick of ['sweep', 'sine50'] as const) {
        const x = loopTrack({ sampleRate: 44100, bpm: 128, offset: 0.35, bars: 32, chords, bass, kick })
        const r = analyzeAudio(x, 44100, { bpmLow: 75 })
        expect(name(r.key), `${want} with ${kick} kick`).toBe(want)
      }
    }
    const x = chordTrack({
      sampleRate: 44100,
      chords: modal[0][1],
      secondsPerChord: 2,
      repeats: 4,
      drums: true,
      detune: 20
    })
    expect(name(analyzeAudio(x, 44100, { bpmLow: 75 }).key)).toBe('Am')
  }, 60000)

  it('returns null for silence and noise', () => {
    expect(estimateKey(analyzeChroma(new Float32Array(22050 * 5), 22050))).toBeNull()
    const rand = rng(3)
    const noise = new Float32Array(22050 * 20).map(() => (rand() * 2 - 1) * 0.3)
    expect(estimateKey(analyzeChroma(noise, 22050))).toBeNull()
  })

  it('uses the shared key numbering (0-11 major, 12-23 minor)', () => {
    expect(key('C')).toBe(0)
    expect(key('Am')).toBe(21)
    const x = chordTrack({ sampleRate: 22050, chords: functional[0][1], secondsPerChord: 2, repeats: 2 })
    expect(estimateKey(analyzeChroma(x, 22050))).toBe(21)
  })
})
