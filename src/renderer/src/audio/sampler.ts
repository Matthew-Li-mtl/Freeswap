// The sampler: 16 one-shot sound slots (deck 1's pads trigger 1-8, deck 2's 9-16).
// The built-in sounds are *synthesized* when the app starts (rendered offline with Web
// Audio nodes), so we ship no third-party audio files and have no licensing concerns.

export const SAMPLER_SLOTS = 16

export interface SamplerSlotInfo {
  name: string
  loaded: boolean
}

export class Sampler {
  readonly output: GainNode
  private buffers: (AudioBuffer | null)[] = new Array(SAMPLER_SLOTS).fill(null)
  private names: string[] = new Array(SAMPLER_SLOTS).fill('')
  private playing: (AudioBufferSourceNode | null)[] = new Array(SAMPLER_SLOTS).fill(null)

  constructor(private ctx: AudioContext) {
    this.output = ctx.createGain()
  }

  async loadBuiltIns(): Promise<void> {
    const sr = this.ctx.sampleRate
    const sounds: [string, (c: OfflineAudioContext) => void, number][] = [
      ['Air Horn', airHorn, 1.6],
      ['Siren', siren, 2.5],
      ['Riser', riser, 4],
      ['Kick', kick, 0.6],
      ['Clap', clap, 0.5],
      ['Laser', laser, 0.5],
      ['Impact', impact, 2.5],
      ['Rewind', rewind, 1.2],
      ['Snare', snare, 0.4],
      ['Hi-Hat', hat, 0.25],
      ['Crash', crash, 2.5],
      ['Sub Drop', subDrop, 2],
      ['Bleep', bleep, 0.4],
      ['Downlifter', downlifter, 3],
      ['Cowbell', cowbell, 0.5],
      ['Zap', zap, 0.35]
    ]
    await Promise.all(
      sounds.map(async ([name, build, seconds], i) => {
        const off = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr)
        build(off)
        this.buffers[i] = await off.startRendering()
        this.names[i] = name
      })
    )
  }

  info(): SamplerSlotInfo[] {
    return this.names.map((name, i) => ({ name, loaded: this.buffers[i] != null }))
  }

  setSlot(slot: number, buffer: AudioBuffer, name: string): void {
    this.buffers[slot] = buffer
    this.names[slot] = name
  }

  trigger(slot: number): void {
    const buf = this.buffers[slot]
    if (!buf) return
    this.stop(slot)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.output)
    src.onended = () => {
      if (this.playing[slot] === src) this.playing[slot] = null
    }
    src.start()
    this.playing[slot] = src
  }

  stop(slot: number): void {
    const src = this.playing[slot]
    if (src) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
      this.playing[slot] = null
    }
  }

  isPlaying(slot: number): boolean {
    return this.playing[slot] != null
  }
}

// ---------------- synthesized sounds ----------------

function env(c: BaseAudioContext, attack: number, hold: number, release: number, peak = 1): GainNode {
  const g = c.createGain()
  g.gain.setValueAtTime(0, 0)
  g.gain.linearRampToValueAtTime(peak, attack)
  g.gain.setValueAtTime(peak, attack + hold)
  g.gain.exponentialRampToValueAtTime(0.0001, attack + hold + release)
  return g
}

function noise(c: BaseAudioContext, seconds: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const s = c.createBufferSource()
  s.buffer = buf
  return s
}

function airHorn(c: OfflineAudioContext): void {
  const out = env(c, 0.02, 1.1, 0.4, 0.22)
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3200
  out.connect(lp).connect(c.destination)
  const vib = c.createOscillator()
  vib.frequency.value = 6
  const vibAmt = c.createGain()
  vibAmt.gain.value = 12
  vib.connect(vibAmt)
  for (const f of [415, 523, 622]) {
    const o = c.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    vibAmt.connect(o.detune)
    // Three short blasts then a long one.
    const g = c.createGain()
    for (const [s, e] of [
      [0, 0.12],
      [0.16, 0.28],
      [0.32, 0.44],
      [0.5, 1.5]
    ]) {
      g.gain.setValueAtTime(1, s)
      g.gain.setValueAtTime(0, e)
    }
    o.connect(g).connect(out)
    o.start()
  }
  vib.start()
}

function siren(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.type = 'triangle'
  o.frequency.value = 900
  const lfo = c.createOscillator()
  lfo.frequency.value = 1.6
  const amt = c.createGain()
  amt.gain.value = 1200 // cents
  lfo.connect(amt).connect(o.detune)
  o.connect(env(c, 0.05, 2, 0.4, 0.35)).connect(c.destination)
  o.start()
  lfo.start()
}

function riser(c: OfflineAudioContext): void {
  const n = noise(c, 4)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 3
  bp.frequency.setValueAtTime(200, 0)
  bp.frequency.exponentialRampToValueAtTime(9000, 3.8)
  const g = c.createGain()
  g.gain.setValueAtTime(0.05, 0)
  g.gain.linearRampToValueAtTime(0.7, 3.8)
  g.gain.linearRampToValueAtTime(0, 4)
  n.connect(bp).connect(g).connect(c.destination)
  n.start()
}

function kick(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.frequency.setValueAtTime(160, 0)
  o.frequency.exponentialRampToValueAtTime(45, 0.12)
  o.connect(env(c, 0.002, 0.05, 0.45, 0.9)).connect(c.destination)
  o.start()
}

function clap(c: OfflineAudioContext): void {
  const n = noise(c, 0.5)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1400
  bp.Q.value = 1.2
  const g = c.createGain()
  for (const t of [0, 0.012, 0.024]) {
    g.gain.setValueAtTime(0.9, t)
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.01)
  }
  g.gain.setValueAtTime(0.7, 0.036)
  g.gain.exponentialRampToValueAtTime(0.0001, 0.4)
  n.connect(bp).connect(g).connect(c.destination)
  n.start()
}

function laser(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.type = 'square'
  o.frequency.setValueAtTime(2400, 0)
  o.frequency.exponentialRampToValueAtTime(120, 0.35)
  o.connect(env(c, 0.002, 0.05, 0.4, 0.18)).connect(c.destination)
  o.start()
}

function impact(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.frequency.setValueAtTime(90, 0)
  o.frequency.exponentialRampToValueAtTime(30, 2)
  o.connect(env(c, 0.003, 0.1, 2.2, 0.9)).connect(c.destination)
  o.start()
  const n = noise(c, 2.5)
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(6000, 0)
  lp.frequency.exponentialRampToValueAtTime(200, 1.5)
  n.connect(lp)
    .connect(env(c, 0.002, 0.02, 1.8, 0.5))
    .connect(c.destination)
  n.start()
}

function rewind(c: OfflineAudioContext): void {
  const n = noise(c, 1.2)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 6
  bp.frequency.setValueAtTime(3000, 0)
  bp.frequency.exponentialRampToValueAtTime(300, 1.1)
  const trem = c.createGain()
  const lfo = c.createOscillator()
  lfo.frequency.setValueAtTime(30, 0)
  lfo.frequency.linearRampToValueAtTime(8, 1.1)
  lfo.connect(trem.gain)
  n.connect(bp)
    .connect(trem)
    .connect(env(c, 0.01, 0.9, 0.3, 1.2))
    .connect(c.destination)
  n.start()
  lfo.start()
}

function snare(c: OfflineAudioContext): void {
  const n = noise(c, 0.4)
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 1200
  n.connect(hp)
    .connect(env(c, 0.001, 0.01, 0.22, 0.6))
    .connect(c.destination)
  n.start()
  const o = c.createOscillator()
  o.frequency.setValueAtTime(220, 0)
  o.frequency.exponentialRampToValueAtTime(160, 0.1)
  o.connect(env(c, 0.001, 0.01, 0.12, 0.5)).connect(c.destination)
  o.start()
}

function hat(c: OfflineAudioContext): void {
  const n = noise(c, 0.25)
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 7000
  n.connect(hp)
    .connect(env(c, 0.001, 0.005, 0.08, 0.5))
    .connect(c.destination)
  n.start()
}

function crash(c: OfflineAudioContext): void {
  const n = noise(c, 2.5)
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 4000
  n.connect(hp)
    .connect(env(c, 0.002, 0.05, 2.3, 0.45))
    .connect(c.destination)
  n.start()
}

function subDrop(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.frequency.setValueAtTime(80, 0)
  o.frequency.exponentialRampToValueAtTime(28, 1.8)
  o.connect(env(c, 0.01, 0.4, 1.5, 0.9)).connect(c.destination)
  o.start()
}

function bleep(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.type = 'sine'
  o.frequency.value = 1760
  o.connect(env(c, 0.002, 0.12, 0.2, 0.3)).connect(c.destination)
  o.start()
}

function downlifter(c: OfflineAudioContext): void {
  const n = noise(c, 3)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 2
  bp.frequency.setValueAtTime(8000, 0)
  bp.frequency.exponentialRampToValueAtTime(150, 2.9)
  n.connect(bp)
    .connect(env(c, 0.01, 0.2, 2.7, 0.7))
    .connect(c.destination)
  n.start()
}

function cowbell(c: OfflineAudioContext): void {
  const out = env(c, 0.001, 0.02, 0.4, 0.25)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 800
  out.connect(bp).connect(c.destination)
  for (const f of [540, 800]) {
    const o = c.createOscillator()
    o.type = 'square'
    o.frequency.value = f
    o.connect(out)
    o.start()
  }
}

function zap(c: OfflineAudioContext): void {
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(80, 0)
  o.frequency.exponentialRampToValueAtTime(3000, 0.3)
  o.connect(env(c, 0.002, 0.2, 0.1, 0.15)).connect(c.destination)
  o.start()
}
