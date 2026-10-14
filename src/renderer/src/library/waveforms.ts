// In-memory cache of waveform data (see AnalysisResult.waveform) keyed by track id.
//
// The cache is bounded so a big batch analysis doesn't keep hundreds of waveforms in
// memory, but waveforms of tracks loaded on a deck are never evicted: an earlier version
// evicted them during batch analysis, leaving the deck stuck on "Analysing…".

import { api } from '../platform'
import { useDecks } from '../state/decks'

const MAX_CACHED = 40
const cache = new Map<number, Uint8Array>()
const pending = new Map<number, Promise<Uint8Array | null>>()
const lastMiss = new Map<number, number>()
const listeners = new Set<(id: number) => void>()

export function getWaveform(id: number): Uint8Array | undefined {
  return cache.get(id)
}

export function loadWaveform(id: number): Promise<Uint8Array | null> {
  const hit = cache.get(id)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(id)
  if (!p) {
    p = api.library.getWaveform(id).then((data) => {
      pending.delete(id)
      if (data) setWaveform(id, data)
      else lastMiss.set(id, performance.now())
      return data
    })
    pending.set(id, p)
  }
  return p
}

/**
 * For drawing code: returns the waveform if cached, otherwise starts fetching it (at most
 * once a second per track, so a not-yet-analysed track doesn't cause a request per frame).
 */
export function waveformOrFetch(id: number): Uint8Array | undefined {
  const hit = cache.get(id)
  if (hit) return hit
  const missed = lastMiss.get(id)
  if (!pending.has(id) && (missed == null || performance.now() - missed > 1000)) void loadWaveform(id)
  return undefined
}

export function setWaveform(id: number, data: Uint8Array): void {
  cache.delete(id) // re-insert so it becomes the most recently used entry
  cache.set(id, data)
  lastMiss.delete(id)
  if (cache.size > MAX_CACHED) {
    const onDecks = new Set(useDecks.getState().decks.map((d) => d.trackId))
    // Map keeps insertion order, so the first keys are the least recently set.
    for (const key of cache.keys()) {
      if (cache.size <= MAX_CACHED) break
      if (!onDecks.has(key)) cache.delete(key)
    }
  }
  for (const l of listeners) l(id)
}

export function onWaveform(cb: (id: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
