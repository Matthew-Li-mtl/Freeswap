// Three-band "isolator" EQ, the kind DJ mixers use.
//
// A normal studio EQ boosts/cuts around a frequency but can never remove a band
// completely. A DJ isolator instead SPLITS the signal into low / mid / high bands with
// crossover filters, gives each band its own volume, then adds them back together.
// Turning a band fully down removes it entirely ("kill"), e.g. kill the lows to drop
// the bassline of the incoming track while mixing.
//
// The splits use Linkwitz-Riley 4th-order filters (two identical 2nd-order Butterworth
// filters in series). Their special property: low + high outputs add back up to a flat
// frequency response, so with all knobs at 12 o'clock the EQ is (almost) transparent.

const LOW_SPLIT = 250 // Hz
const HIGH_SPLIT = 3500 // Hz
const Q_BUTTERWORTH = Math.SQRT1_2

export type Band = 'low' | 'mid' | 'high'

/** Knob position 0..1 (0.5 = unity) to linear gain: -inf at 0, 0 dB at 0.5, +6 dB at 1. */
export function eqKnobToGain(v: number): number {
  if (v <= 0.001) return 0
  if (v < 0.5) {
    // Lower half: -40 dB .. 0 dB on a curve, then a hard kill at the very bottom.
    const db = -40 * Math.pow(1 - v / 0.5, 1.6)
    return Math.pow(10, db / 20)
  }
  const db = 6 * ((v - 0.5) / 0.5)
  return Math.pow(10, db / 20)
}

export class IsolatorEQ {
  readonly input: GainNode
  readonly output: GainNode
  private gains: Record<Band, GainNode>

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    const lr4 = (type: BiquadFilterType, freq: number): [BiquadFilterNode, BiquadFilterNode] => {
      const a = ctx.createBiquadFilter()
      const b = ctx.createBiquadFilter()
      for (const f of [a, b]) {
        f.type = type
        f.frequency.value = freq
        f.Q.value = Q_BUTTERWORTH
      }
      a.connect(b)
      return [a, b]
    }
    this.gains = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() }

    // Low band: below LOW_SPLIT
    const [lowA, lowB] = lr4('lowpass', LOW_SPLIT)
    // Mid band: above LOW_SPLIT and below HIGH_SPLIT
    const [midHpA, midHpB] = lr4('highpass', LOW_SPLIT)
    const [midLpA, midLpB] = lr4('lowpass', HIGH_SPLIT)
    midHpB.connect(midLpA)
    // High band: above HIGH_SPLIT
    const [highA, highB] = lr4('highpass', HIGH_SPLIT)

    this.input.connect(lowA)
    this.input.connect(midHpA)
    this.input.connect(highA)
    lowB.connect(this.gains.low)
    midLpB.connect(this.gains.mid)
    highB.connect(this.gains.high)
    this.gains.low.connect(this.output)
    this.gains.mid.connect(this.output)
    this.gains.high.connect(this.output)
  }

  /** gain: linear multiplier (already includes kills). */
  set(band: Band, gain: number, ctx: BaseAudioContext): void {
    this.gains[band].gain.setTargetAtTime(gain, ctx.currentTime, 0.008)
  }
}

/**
 * One-knob filter (like a mixer's "color" filter):
 *  knob 0.5 = off, turning left sweeps a low-pass down (muffled),
 *  turning right sweeps a high-pass up (thin). Small dead zone around the centre.
 */
export class SweepFilter {
  readonly input: BiquadFilterNode
  readonly output: BiquadFilterNode
  private lp: BiquadFilterNode
  private hp: BiquadFilterNode

  constructor(ctx: BaseAudioContext) {
    this.lp = ctx.createBiquadFilter()
    this.lp.type = 'lowpass'
    this.lp.frequency.value = 22000
    this.lp.Q.value = 0.9
    this.hp = ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.frequency.value = 10
    this.hp.Q.value = 0.9
    this.lp.connect(this.hp)
    this.input = this.lp
    this.output = this.hp
  }

  set(v: number, ctx: BaseAudioContext): void {
    const t = ctx.currentTime
    const dead = 0.03
    // Exponential sweeps sound even because we hear pitch logarithmically.
    if (v < 0.5 - dead) {
      const x = (0.5 - dead - v) / (0.5 - dead) // 0..1
      this.lp.frequency.setTargetAtTime(20000 * Math.pow(60 / 20000, x), t, 0.01)
      this.lp.Q.setTargetAtTime(0.9 + x * 2.5, t, 0.01)
      this.hp.frequency.setTargetAtTime(10, t, 0.01)
    } else if (v > 0.5 + dead) {
      const x = (v - 0.5 - dead) / (0.5 - dead)
      this.hp.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, x), t, 0.01)
      this.hp.Q.setTargetAtTime(0.9 + x * 2.5, t, 0.01)
      this.lp.frequency.setTargetAtTime(22000, t, 0.01)
    } else {
      this.lp.frequency.setTargetAtTime(22000, t, 0.01)
      this.hp.frequency.setTargetAtTime(10, t, 0.01)
      this.lp.Q.setTargetAtTime(0.9, t, 0.01)
      this.hp.Q.setTargetAtTime(0.9, t, 0.01)
    }
  }
}
