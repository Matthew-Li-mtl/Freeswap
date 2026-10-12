// Messages exchanged between the main thread (DeckPlayer) and the deck AudioWorklet.
// All times are in seconds of *track* time.

export type DeckCommand =
  | { t: 'load'; left: Float32Array; right: Float32Array }
  | { t: 'unload' }
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'seek'; pos: number; quantize?: boolean }
  | { t: 'tempo'; rate: number }
  | { t: 'bend'; amount: number }
  | { t: 'phaseShift'; seconds: number }
  | { t: 'scratch'; on: boolean }
  | { t: 'scratchMove'; delta: number }
  | { t: 'keyLock'; on: boolean }
  | { t: 'quantize'; on: boolean }
  | { t: 'grid'; anchor: number; beatLen: number }
  | { t: 'noGrid' }
  | { t: 'loopIn' }
  | { t: 'loopOut' }
  | { t: 'reloop' }
  | { t: 'loopExit' }
  | { t: 'autoLoop'; beats: number }
  | { t: 'loopScale'; factor: number }
  | { t: 'loopSet'; start: number; end: number; active: boolean }
  | { t: 'beatJump'; beats: number }
  | { t: 'roll'; beats: number | null }
  | { t: 'slip'; on: boolean }
  | { t: 'brake'; on: boolean; seconds: number }

export interface LoopInfo {
  start: number
  end: number | null // null while only the IN point is set
  active: boolean
}

export type DeckEvent =
  | { t: 'pos'; pos: number; time: number; rate: number; playing: boolean }
  | { t: 'loop'; loop: LoopInfo | null }
  | { t: 'ended' }
  | { t: 'loaded'; duration: number }
