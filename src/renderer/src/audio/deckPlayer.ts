// Main-thread handle for one deck's AudioWorklet (see worklets/deck-processor.ts).
//
// The worklet is the source of truth for the playhead. It reports its position a few
// hundred times a second, stamped with the audio clock time it applies to. Between
// reports we *extrapolate*: position = reported + (now - reportTime) * rate.
// That gives smooth, exact positions for the UI without flooding the message port.

import type { BeatGrid } from '@shared/types'
import type { DeckCommand, DeckEvent, LoopInfo } from './deckProtocol'

export interface BeatClock {
  /** Seconds per beat at the deck's current playback speed (0 when unknown). */
  beatSeconds(): number
  /** Fractional beat number playing at audio-clock time `t`, or null without a grid. */
  beatAt(t: number): number | null
}

export class DeckPlayer implements BeatClock {
  readonly node: AudioWorkletNode
  duration = 0
  loop: LoopInfo | null = null
  private last = { pos: 0, time: 0, rate: 0, playing: false }
  private grid: BeatGrid | null = null
  private tempoRate = 1
  private listeners = new Set<(e: DeckEvent) => void>()

  constructor(private ctx: AudioContext) {
    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    })
    this.node.port.onmessage = (e: MessageEvent<DeckEvent>) => {
      const ev = e.data
      if (ev.t === 'pos') this.last = { pos: ev.pos, time: ev.time, rate: ev.rate, playing: ev.playing }
      else if (ev.t === 'loaded') this.duration = ev.duration
      else if (ev.t === 'loop') this.loop = ev.loop
      for (const l of this.listeners) l(ev)
    }
  }

  on(cb: (e: DeckEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  send(cmd: DeckCommand, transfer?: Transferable[]): void {
    this.node.port.postMessage(cmd, transfer ?? [])
  }

  load(buffer: AudioBuffer): void {
    // Copy the channel data so we can hand (transfer) it to the audio thread
    // without copying again; the AudioBuffer itself is then garbage collected.
    const left = new Float32Array(buffer.getChannelData(0))
    const right = buffer.numberOfChannels > 1 ? new Float32Array(buffer.getChannelData(1)) : new Float32Array(left)
    this.duration = buffer.duration
    this.last = { pos: 0, time: this.ctx.currentTime, rate: 0, playing: false }
    this.send({ t: 'load', left, right }, [left.buffer, right.buffer])
  }

  setGrid(grid: BeatGrid | null): void {
    this.grid = grid
    if (grid) this.send({ t: 'grid', anchor: grid.anchor, beatLen: 60 / grid.bpm })
    else this.send({ t: 'noGrid' })
  }

  setTempo(rate: number): void {
    this.tempoRate = rate
    this.send({ t: 'tempo', rate })
  }

  get playing(): boolean {
    return this.last.playing
  }

  /** Position (s) at audio-clock time t, extrapolated from the last report. */
  posAt(t: number): number {
    const p = this.last.pos + (t - this.last.time) * this.last.rate
    return Math.max(0, Math.min(this.duration, p))
  }

  /** Position the audio thread is rendering right now. Use for logic. */
  posNow(): number {
    return this.posAt(this.ctx.currentTime)
  }

  /**
   * Position you can *hear* right now. Audio leaves the speakers a little after it is
   * rendered (output latency); getOutputTimestamp tells us which audio-clock time is
   * at the speaker at a given performance.now(). Use this for visuals.
   */
  posHeard(): number {
    const ts = this.ctx.getOutputTimestamp()
    if (ts.contextTime == null || ts.performanceTime == null) return this.posNow()
    const heard = ts.contextTime + (performance.now() - ts.performanceTime) / 1000
    return this.posAt(heard)
  }

  beatSeconds(): number {
    if (!this.grid) return 0
    return 60 / this.grid.bpm / Math.max(0.01, this.tempoRate)
  }

  beatAt(t: number): number | null {
    if (!this.grid) return null
    return (this.posAt(t) - this.grid.anchor) / (60 / this.grid.bpm)
  }
}
