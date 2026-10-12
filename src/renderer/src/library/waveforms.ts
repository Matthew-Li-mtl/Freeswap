// In-memory cache of waveform data (see AnalysisResult.waveform) keyed by track id.

import { api } from '../platform'

const cache = new Map<number, Uint8Array>()
const pending = new Map<number, Promise<Uint8Array | null>>()
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
      return data
    })
    pending.set(id, p)
  }
  return p
}

export function setWaveform(id: number, data: Uint8Array): void {
  cache.set(id, data)
  // Keep memory bounded: forget the oldest entries beyond 40 tracks.
  if (cache.size > 40) {
    const first = cache.keys().next().value
    if (first != null) cache.delete(first)
  }
  for (const l of listeners) l(id)
}

export function onWaveform(cb: (id: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
