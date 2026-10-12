// Musical key helpers.
// A key is stored as a single number: 0-11 = C..B major, 12-23 = C..B minor.
// Camelot ("wheel") notation numbers keys so that neighbours on the wheel mix
// harmonically: same number, +/-1, or switching A (minor) <-> B (major).

import type { KeyNotation } from './types'

const SHARP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// Camelot number for each pitch class, for major (B) and minor (A) keys.
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

export function isMinor(key: number): boolean {
  return key >= 12
}

export function pitchClass(key: number): number {
  return key % 12
}

export function musicalName(key: number): string {
  return SHARP_NAMES[pitchClass(key)] + (isMinor(key) ? 'm' : '')
}

export function camelotName(key: number): string {
  const pc = pitchClass(key)
  return isMinor(key) ? `${CAMELOT_MINOR[pc]}A` : `${CAMELOT_MAJOR[pc]}B`
}

export function formatKey(key: number | null | undefined, notation: KeyNotation): string {
  if (key == null) return ''
  return notation === 'camelot' ? camelotName(key) : musicalName(key)
}

/** Parse "Am", "F#", "Ebm", "8A", "12B" etc. Returns null when unrecognised. */
export function parseKey(text: string): number | null {
  const t = text.trim()
  const cam = /^(\d{1,2})\s*([AaBb])$/.exec(t)
  if (cam) {
    const n = Number(cam[1])
    if (n < 1 || n > 12) return null
    const minor = cam[2].toUpperCase() === 'A'
    const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR
    const pc = table.indexOf(n)
    return minor ? pc + 12 : pc
  }
  const mus = /^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?$/.exec(t)
  if (!mus) return null
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let pc = base[mus[1].toUpperCase()]
  if (mus[2] === '#' || mus[2] === '♯') pc += 1
  if (mus[2] === 'b' || mus[2] === '♭') pc -= 1
  pc = (pc + 12) % 12
  const minor = mus[3] != null && mus[3].startsWith('m') && !mus[3].startsWith('maj')
  return minor ? pc + 12 : pc
}

/** All 24 keys in Camelot wheel order, handy for dropdowns. */
export function allKeys(): number[] {
  const out: number[] = []
  for (let n = 1; n <= 12; n++) {
    out.push(CAMELOT_MINOR.indexOf(n) + 12)
    out.push(CAMELOT_MAJOR.indexOf(n))
  }
  return out
}
