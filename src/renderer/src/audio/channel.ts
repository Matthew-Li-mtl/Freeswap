// One mixer channel: the signal path a deck's audio takes on its way to the master.
//
//  deck player ─> trim ─> 3-band EQ ─> filter ─> FX 1 ─> FX 2 ─> FX 3 ─> pad FX ─┬─> fader ─> crossfader ─> master
//                                                                               └─> cue (headphones) send
//
// The headphone cue is taken *before* the channel fader ("pre-fader listen"): that is
// what lets a DJ hear the next track in the headphones while it's silent to the crowd.

import { DeckPlayer } from './deckPlayer'
import { IsolatorEQ, SweepFilter, eqKnobToGain, type Band } from './eq'
import { FxSlot } from './effects'

export class Channel {
  readonly player: DeckPlayer
  readonly fx: FxSlot[]
  readonly padFx: FxSlot
  readonly meter: AnalyserNode
  private trim: GainNode
  private eq: IsolatorEQ
  private filter: SweepFilter
  private fader: GainNode
  readonly xfade: GainNode
  readonly cueSend: GainNode

  constructor(
    private ctx: AudioContext,
    master: AudioNode,
    cueBus: AudioNode
  ) {
    this.player = new DeckPlayer(ctx)
    this.trim = ctx.createGain()
    this.eq = new IsolatorEQ(ctx)
    this.filter = new SweepFilter(ctx)
    this.fx = [0, 1, 2].map(() => new FxSlot(ctx, this.player))
    this.padFx = new FxSlot(ctx, this.player)
    this.fader = ctx.createGain()
    this.xfade = ctx.createGain()
    this.cueSend = ctx.createGain()
    this.cueSend.gain.value = 0
    this.meter = ctx.createAnalyser()
    this.meter.fftSize = 1024

    this.player.node.connect(this.trim)
    this.trim.connect(this.eq.input)
    this.eq.output.connect(this.filter.input)
    let node: AudioNode = this.filter.output
    for (const slot of [...this.fx, this.padFx]) {
      node.connect(slot.input)
      node = slot.output
    }
    node.connect(this.meter)
    node.connect(this.cueSend).connect(cueBus)
    node.connect(this.fader).connect(this.xfade).connect(master)
  }

  private set(param: AudioParam, v: number, tc = 0.01): void {
    param.setTargetAtTime(v, this.ctx.currentTime, tc)
  }

  /** dB, -12..+12 */
  setTrim(db: number): void {
    this.set(this.trim.gain, Math.pow(10, db / 20))
  }

  setEq(band: Band, knob: number, killed: boolean): void {
    this.eq.set(band, killed ? 0 : eqKnobToGain(knob), this.ctx)
  }

  setFilter(knob: number): void {
    this.filter.set(knob, this.ctx)
  }

  /** Fader position 0..1. Squared so it feels like an audio-taper fader (-12 dB at half). */
  setFader(v: number): void {
    this.set(this.fader.gain, v * v, 0.005)
  }

  setCue(on: boolean): void {
    this.set(this.cueSend.gain, on ? 1 : 0)
  }

  tick(now: number): void {
    for (const s of this.fx) s.tick(now)
    this.padFx.tick(now)
  }
}
