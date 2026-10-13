// UI-facing state for both decks and the mixer, kept in a Zustand store.
//
// React components subscribe to the slices they display and re-render when those change.
// Things that change every frame (playhead position, levels) are deliberately NOT in
// here: they're read straight from the audio engine inside requestAnimationFrame loops,
// so we don't re-render React 60 times a second.

import { create } from 'zustand'
import type { BeatGrid, HotCue } from '@shared/types'
import type { LoopInfo } from '../audio/deckProtocol'
import type { FxId } from '../audio/effects'
import type { CrossfaderCurve } from '../audio/engine'

export type PadMode = 'hotcue' | 'beatjump' | 'padfx' | 'sampler'

export interface FxSlotState {
  type: FxId
  enabled: boolean
  depth: number
  beats: number
}

export interface EqState {
  high: number
  mid: number
  low: number
}

export interface DeckState {
  trackId: number | null
  loading: boolean
  analyzing: boolean
  error: string | null
  duration: number
  playing: boolean
  cuePoint: number
  hotCues: (HotCue | null)[]
  grid: BeatGrid | null
  key: number | null
  tempo: number // fraction: 0.02 = +2 %
  tempoRange: number
  keyLock: boolean
  sync: boolean
  master: boolean
  quantize: boolean
  slip: boolean
  vinyl: boolean
  loop: LoopInfo | null
  padMode: PadMode
  trim: number // dB
  eq: EqState // knob positions 0..1
  kills: { high: boolean; mid: boolean; low: boolean }
  filter: number // 0..1, 0.5 = off
  fader: number // 0..1
  cue: boolean // headphone cue
  fx: FxSlotState[]
  gridEdit: boolean
  ended: boolean
  /** Which end stays put when the loop is halved/doubled. */
  loopAnchor: 'start' | 'end'
  /** Live tap-tempo readout while the user is tapping. */
  tapBpm: number | null
  tapCount: number
}

export interface MixerState {
  crossfader: number
  crossfaderCurve: CrossfaderCurve
  master: number
  hpMix: number
  hpLevel: number
  samplerVolume: number
  recording: boolean
  recordStartedAt: number
  lastRecording: string | null
}

export function initialDeck(tempoRange: number): DeckState {
  return {
    trackId: null,
    loading: false,
    analyzing: false,
    error: null,
    duration: 0,
    playing: false,
    cuePoint: 0,
    hotCues: new Array(8).fill(null),
    grid: null,
    key: null,
    tempo: 0,
    tempoRange,
    keyLock: false,
    sync: false,
    master: false,
    quantize: true,
    slip: false,
    vinyl: true,
    loop: null,
    padMode: 'hotcue',
    trim: 0,
    eq: { high: 0.5, mid: 0.5, low: 0.5 },
    kills: { high: false, mid: false, low: false },
    filter: 0.5,
    fader: 1,
    cue: false,
    fx: [
      { type: 'echo', enabled: false, depth: 0.5, beats: 0.5 },
      { type: 'reverb', enabled: false, depth: 0.5, beats: 1 },
      { type: 'sweep', enabled: false, depth: 0.5, beats: 4 }
    ],
    gridEdit: false,
    loopAnchor: 'start',
    tapBpm: null,
    tapCount: 0,
    ended: false
  }
}

interface DeckStore {
  decks: [DeckState, DeckState]
  mixer: MixerState
  /** Values remembered by "click the label" toggles so a second click restores them. */
  saved: Record<string, number>
}

export const useDecks = create<DeckStore>(() => ({
  decks: [initialDeck(0.25), initialDeck(0.25)],
  mixer: {
    crossfader: 0.5,
    crossfaderCurve: 'smooth',
    master: 0.8,
    hpMix: 0.25,
    hpLevel: 0.7,
    samplerVolume: 0.7,
    recording: false,
    recordStartedAt: 0,
    lastRecording: null
  },
  saved: {}
}))

export function deck(d: number): DeckState {
  return useDecks.getState().decks[d]
}

export function patchDeck(d: number, patch: Partial<DeckState>): void {
  useDecks.setState((s) => {
    const decks = [...s.decks] as [DeckState, DeckState]
    decks[d] = { ...decks[d], ...patch }
    return { decks }
  })
}

export function patchMixer(patch: Partial<MixerState>): void {
  useDecks.setState((s) => ({ mixer: { ...s.mixer, ...patch } }))
}
