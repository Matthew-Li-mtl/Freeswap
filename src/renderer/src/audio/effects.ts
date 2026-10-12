// Channel effects. Each effect is a little sub-graph of Web Audio nodes:
//
//            ┌── dry ─────────────────────┐
//   input ───┤                            ├──> output
//            └── send ──> [effect] ──> wet┘
//
// "Depth" (the knob) sets how much effect you hear and its main parameter.
// Time-based effects follow the deck's tempo: their length is set in beats, so an
// "echo 1/2" repeats every half beat whatever the BPM is.
//
// "Tail" effects (echo, reverb) keep ringing after you switch them off: we close the
// send so no new sound enters, but leave the wet path open so the repeats die away
// naturally instead of being chopped (that's how hardware FX behave too).

import type { BeatClock } from './deckPlayer'

export type FxId =
  'none' | 'echo' | 'pingpong' | 'reverb' | 'flanger' | 'phaser' | 'sweep' | 'gate' | 'crush' | 'noise' | 'drive'

export interface FxInfo {
  id: FxId
  name: string
  /** Default length in beats, or null if the effect isn't tempo-synced. */
  beats: number | null
}

export const FX_LIST: FxInfo[] = [
  { id: 'none', name: '—', beats: null },
  { id: 'echo', name: 'Echo', beats: 0.5 },
  { id: 'pingpong', name: 'Ping Pong', beats: 0.75 },
  { id: 'reverb', name: 'Reverb', beats: null },
  { id: 'flanger', name: 'Flanger', beats: 16 },
  { id: 'phaser', name: 'Phaser', beats: 8 },
  { id: 'sweep', name: 'Filter LFO', beats: 4 },
  { id: 'gate', name: 'Gate', beats: 0.25 },
  { id: 'crush', name: 'Bitcrush', beats: null },
  { id: 'noise', name: 'Noise', beats: null },
  { id: 'drive', name: 'Drive', beats: null }
]

export const BEAT_DIVISIONS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16, 32]

export function formatBeats(b: number): string {
  if (b >= 1) return String(b)
  if (Math.abs(b - 0.75) < 1e-6) return '3/4'
  return `1/${Math.round(1 / b)}`
}

const RAMP = 0.015

export abstract class Effect {
  readonly input: GainNode
  readonly output: GainNode
  protected readonly dry: GainNode
  protected readonly send: GainNode
  protected readonly wet: GainNode
  protected enabled = false
  protected depth = 0.5
  protected beats = 1
  protected tails = false
  private lastBeatSec = 0

  constructor(
    protected ctx: AudioContext,
    protected clock: BeatClock
  ) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.dry = ctx.createGain()
    this.send = ctx.createGain()
    this.wet = ctx.createGain()
    this.send.gain.value = 0
    this.wet.gain.value = 0
    this.input.connect(this.dry).connect(this.output)
    this.input.connect(this.send)
    this.wet.connect(this.output)
  }

  /** dry/wet levels while enabled, for the current depth. */
  protected abstract levels(): { dry: number; wet: number }
  /** Push depth/beats/tempo into the nodes. */
  protected abstract update(): void

  setEnabled(on: boolean): void {
    this.enabled = on
    this.refresh()
  }
  setDepth(v: number): void {
    this.depth = v
    this.refresh()
  }
  setBeats(b: number): void {
    this.beats = b
    this.refresh()
  }

  /** Called ~40x per second; re-syncs to tempo changes and drives scheduled effects. */
  tick(_now: number): void {
    const bs = this.beatSec()
    if (Math.abs(bs - this.lastBeatSec) > 1e-4) {
      this.lastBeatSec = bs
      this.update()
    }
  }

  /** Length of one beat in seconds (falls back to 120 BPM without a grid). */
  protected beatSec(): number {
    return this.clock.beatSeconds() || 0.5
  }

  protected ramp(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, this.ctx.currentTime, RAMP)
  }

  protected refresh(): void {
    const lv = this.levels()
    this.ramp(this.dry.gain, this.enabled ? lv.dry : 1)
    this.ramp(this.send.gain, this.enabled ? 1 : 0)
    this.ramp(this.wet.gain, this.enabled || this.tails ? lv.wet : 0)
    this.update()
  }

  dispose(): void {
    this.input.disconnect()
    this.output.disconnect()
  }
}

// ---------------------------------------------------------------------------

/** Echo: a delay line whose output is fed back into itself, each repeat a bit darker. */
class Echo extends Effect {
  private delay: DelayNode
  private fb: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.tails = true
    this.delay = ctx.createDelay(8)
    this.fb = ctx.createGain()
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 5000
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 150
    this.send.connect(this.delay)
    this.delay.connect(tone).connect(hp).connect(this.fb).connect(this.delay)
    this.delay.connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1, wet: Math.min(1, this.depth * 1.2) }
  }
  protected update(): void {
    this.ramp(this.delay.delayTime, Math.min(7.9, this.beats * this.beatSec()))
    this.ramp(this.fb.gain, 0.25 + this.depth * 0.5)
  }
}

/** Ping pong: two delays bouncing the echoes between left and right. */
class PingPong extends Effect {
  private dL: DelayNode
  private dR: DelayNode
  private fb: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.tails = true
    this.dL = ctx.createDelay(8)
    this.dR = ctx.createDelay(8)
    this.fb = ctx.createGain()
    const merger = ctx.createChannelMerger(2)
    this.send.connect(this.dL)
    this.dL.connect(merger, 0, 0)
    this.dL.connect(this.dR)
    this.dR.connect(merger, 0, 1)
    this.dR.connect(this.fb).connect(this.dL)
    merger.connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1, wet: Math.min(1, this.depth * 1.2) }
  }
  protected update(): void {
    const t = Math.min(7.9, this.beats * this.beatSec())
    this.ramp(this.dL.delayTime, t)
    this.ramp(this.dR.delayTime, t)
    this.ramp(this.fb.gain, 0.2 + this.depth * 0.5)
  }
}

/** Reverb: convolution with a synthetic "room" impulse response (decaying noise). */
class Reverb extends Effect {
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.tails = true
    const conv = ctx.createConvolver()
    conv.buffer = makeImpulse(ctx, 3.2, 2.6)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 250
    this.send.connect(hp).connect(conv).connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1 - this.depth * 0.35, wet: this.depth * 1.4 }
  }
  protected update(): void {}
}

/** Flanger: mixes the signal with a copy delayed by a slowly sweeping 1-6 ms. */
class Flanger extends Effect {
  private lfo: OscillatorNode
  private delay: DelayNode
  private fb: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.delay = ctx.createDelay(0.05)
    this.delay.delayTime.value = 0.0035
    this.fb = ctx.createGain()
    this.lfo = ctx.createOscillator()
    const amt = ctx.createGain()
    amt.gain.value = 0.0025
    this.lfo.connect(amt).connect(this.delay.delayTime)
    this.lfo.start()
    this.send.connect(this.delay)
    this.delay.connect(this.fb).connect(this.delay)
    this.delay.connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 0.75, wet: 0.35 + this.depth * 0.45 }
  }
  protected update(): void {
    this.ramp(this.lfo.frequency, 1 / (this.beats * this.beatSec()))
    this.ramp(this.fb.gain, 0.2 + this.depth * 0.6)
  }
  dispose(): void {
    this.lfo.stop()
    super.dispose()
  }
}

/** Phaser: a chain of all-pass filters whose frequency sweeps, creating moving notches. */
class Phaser extends Effect {
  private lfo: OscillatorNode
  private amt: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.lfo = ctx.createOscillator()
    this.amt = ctx.createGain()
    this.lfo.connect(this.amt)
    let node: AudioNode = this.send
    for (let i = 0; i < 6; i++) {
      const ap = ctx.createBiquadFilter()
      ap.type = 'allpass'
      ap.frequency.value = 900
      ap.Q.value = 0.6
      this.amt.connect(ap.detune) // sweep in cents => exponential frequency sweep
      node.connect(ap)
      node = ap
    }
    node.connect(this.wet)
    this.lfo.start()
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1 - this.depth * 0.5, wet: this.depth * 0.5 + 0.1 }
  }
  protected update(): void {
    this.ramp(this.lfo.frequency, 1 / (this.beats * this.beatSec()))
    this.ramp(this.amt.gain, 1200 + this.depth * 1800)
  }
  dispose(): void {
    this.lfo.stop()
    super.dispose()
  }
}

/** Filter LFO: a resonant band-pass that sweeps up and down in time with the beat. */
class Sweep extends Effect {
  private lfo: OscillatorNode
  private amt: GainNode
  private filter: BiquadFilterNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'bandpass'
    this.filter.frequency.value = 1000
    this.filter.Q.value = 2.5
    this.lfo = ctx.createOscillator()
    this.amt = ctx.createGain()
    this.lfo.connect(this.amt).connect(this.filter.detune)
    this.lfo.start()
    const makeup = ctx.createGain()
    makeup.gain.value = 2.2
    this.send.connect(this.filter).connect(makeup).connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1 - this.depth, wet: this.depth }
  }
  protected update(): void {
    this.ramp(this.lfo.frequency, 1 / (this.beats * this.beatSec()))
    this.ramp(this.amt.gain, 2400)
  }
  dispose(): void {
    this.lfo.stop()
    super.dispose()
  }
}

/**
 * Gate ("trans"): chops the sound on and off in time with the beat grid.
 * Instead of an oscillator (which wouldn't line up with the beats) we *schedule*
 * gain changes a little ahead of time using the deck's beat clock. tick() runs every
 * 25 ms and plans the next 120 ms — the "two clocks" scheduling pattern.
 */
class Gate extends Effect {
  private vca: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.vca = ctx.createGain()
    this.send.connect(this.vca).connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 0, wet: 1 }
  }
  protected update(): void {}
  tick(now: number): void {
    const g = this.vca.gain
    g.cancelScheduledValues(now)
    if (!this.enabled) {
      g.setTargetAtTime(1, now, 0.005)
      return
    }
    const low = 1 - this.depth
    const step = this.beats // one on+off cycle per `beats`
    const bs = this.beatSec()
    const b0 = this.clock.beatAt(now) ?? now / bs
    const end = now + 0.12
    // Walk half-steps (on, off, on, off...) from the one we're in to the lookahead end.
    const even = (k: number): boolean => ((k % 2) + 2) % 2 === 0
    let k = Math.floor(b0 / (step / 2))
    g.setTargetAtTime(even(k) ? 1 : low, now, 0.002)
    for (;;) {
      k++
      const t = now + (k * (step / 2) - b0) * bs
      if (t > end) break
      g.setTargetAtTime(even(k) ? 1 : low, t, 0.002)
    }
  }
}

/** Bitcrusher: fewer bits and a lower sample rate for a lo-fi, digital grit. */
class Crush extends Effect {
  private node: AudioWorkletNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.node = new AudioWorkletNode(ctx, 'bitcrusher-processor', { outputChannelCount: [2] })
    this.send.connect(this.node).connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 0, wet: 1 }
  }
  protected update(): void {
    this.node.port.postMessage({ bits: 16 - this.depth * 13, hold: 1 + this.depth * 20 })
  }
}

/** Noise: adds a rising, high-passed white-noise "whoosh" on top of the music. */
class Noise extends Effect {
  private src: AudioBufferSourceNode
  private hp: BiquadFilterNode
  private level: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    const buf = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    }
    this.src = ctx.createBufferSource()
    this.src.buffer = buf
    this.src.loop = true
    this.hp = ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.Q.value = 2
    this.level = ctx.createGain()
    this.src.connect(this.hp).connect(this.level).connect(this.wet)
    this.src.start()
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 1, wet: 1 }
  }
  protected update(): void {
    this.ramp(this.hp.frequency, 300 * Math.pow(40, this.depth))
    this.ramp(this.level.gain, this.enabled ? 0.04 + this.depth * 0.2 : 0)
  }
  dispose(): void {
    this.src.stop()
    super.dispose()
  }
}

/** Drive: soft-clipping saturation (tanh curve), like overdriving an analog stage. */
class Drive extends Effect {
  private pre: GainNode
  private post: GainNode
  constructor(ctx: AudioContext, clock: BeatClock) {
    super(ctx, clock)
    this.pre = ctx.createGain()
    this.post = ctx.createGain()
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(2048)
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 3)
    shaper.curve = curve
    shaper.oversample = '4x' // reduces aliasing from the distortion's new harmonics
    this.send.connect(this.pre).connect(shaper).connect(this.post).connect(this.wet)
  }
  protected levels(): { dry: number; wet: number } {
    return { dry: 0, wet: 1 }
  }
  protected update(): void {
    this.ramp(this.pre.gain, 0.35 + this.depth * 3)
    this.ramp(this.post.gain, 1 / (1 + this.depth * 1.6))
  }
}

export function createEffect(id: FxId, ctx: AudioContext, clock: BeatClock): Effect | null {
  switch (id) {
    case 'echo':
      return new Echo(ctx, clock)
    case 'pingpong':
      return new PingPong(ctx, clock)
    case 'reverb':
      return new Reverb(ctx, clock)
    case 'flanger':
      return new Flanger(ctx, clock)
    case 'phaser':
      return new Phaser(ctx, clock)
    case 'sweep':
      return new Sweep(ctx, clock)
    case 'gate':
      return new Gate(ctx, clock)
    case 'crush':
      return new Crush(ctx, clock)
    case 'noise':
      return new Noise(ctx, clock)
    case 'drive':
      return new Drive(ctx, clock)
    default:
      return null
  }
}

/** A stereo impulse response: noise with an exponential decay, a classic reverb trick. */
function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) {
      const t = i / len
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 64 ? i / 64 : 1)
    }
  }
  return buf
}

/**
 * A slot in a channel's effect chain. Its input/output never change, so the chain
 * stays wired while the effect inside is swapped.
 */
export class FxSlot {
  readonly input: GainNode
  readonly output: GainNode
  private effect: Effect | null = null
  type: FxId = 'none'
  private enabled = false
  private depth = 0.5
  private beats = 1

  constructor(
    private ctx: AudioContext,
    private clock: BeatClock
  ) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.input.connect(this.output)
  }

  setType(id: FxId, beats?: number): void {
    if (id === this.type) return
    this.input.disconnect()
    this.effect?.dispose()
    this.effect = createEffect(id, this.ctx, this.clock)
    this.type = id
    if (this.effect) {
      this.input.connect(this.effect.input)
      this.effect.output.connect(this.output)
      this.beats = beats ?? FX_LIST.find((f) => f.id === id)?.beats ?? 1
      this.effect.setBeats(this.beats)
      this.effect.setDepth(this.depth)
      this.effect.setEnabled(this.enabled)
    } else {
      this.input.connect(this.output)
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.effect?.setEnabled(on)
  }
  setDepth(v: number): void {
    this.depth = v
    this.effect?.setDepth(v)
  }
  setBeats(b: number): void {
    this.beats = b
    this.effect?.setBeats(b)
  }
  tick(now: number): void {
    this.effect?.tick(now)
  }
}
