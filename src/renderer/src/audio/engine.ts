// The audio engine: owns the AudioContext(s) and the whole mixer graph.
//
//  channel 1 ─┐                                     ┌─> speakers (master device)
//  channel 2 ─┼─> master bus ─> master vol ─> limiter ┼─> recorder
//  sampler  ──┘                                     └─> headphone mix (as "master" side)
//
//  cue sends ─> cue bus ─> headphone mix ─> headphone level ─> 2nd AudioContext ─> headphone device
//
// Why two AudioContexts? An AudioContext plays to exactly one output device. To send the
// cue mix to a *different* device (headphones on a USB interface, for example) we pipe
// it through a MediaStream into a second context bound to that device.

import deckProcessorUrl from './worklets/deck-processor.ts?worker&url'
import utilityProcessorsUrl from './worklets/utility-processors.ts?worker&url'
import { Channel } from './channel'
import { Sampler } from './sampler'

export type CrossfaderCurve = 'smooth' | 'sharp'

export class AudioEngine {
  readonly ctx: AudioContext
  channels!: [Channel, Channel]
  sampler!: Sampler
  readonly masterMeterL: AnalyserNode
  readonly masterMeterR: AnalyserNode
  private masterBus: GainNode
  private masterGain: GainNode
  private limiter: DynamicsCompressorNode
  private cueBus: GainNode
  private hpCueGain: GainNode
  private hpMasterGain: GainNode
  private hpLevel: GainNode
  private hpStream: MediaStreamAudioDestinationNode
  private hpCtx: AudioContext | null = null
  private recorder: AudioWorkletNode | null = null
  private xfCurve: CrossfaderCurve = 'smooth'
  private ticker = 0
  onRecordChunk: ((chunk: ArrayBuffer) => void) | null = null

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    const ctx = this.ctx
    this.masterBus = ctx.createGain()
    this.masterGain = ctx.createGain()
    // A fast, high-ratio compressor at -1 dB acts as a safety limiter so the output
    // never clips harshly when two loud tracks overlap.
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.001
    this.limiter.release.value = 0.1
    this.masterBus.connect(this.masterGain).connect(this.limiter).connect(ctx.destination)

    const split = ctx.createChannelSplitter(2)
    this.masterMeterL = ctx.createAnalyser()
    this.masterMeterR = ctx.createAnalyser()
    this.masterMeterL.fftSize = this.masterMeterR.fftSize = 1024
    this.limiter.connect(split)
    split.connect(this.masterMeterL, 0)
    split.connect(this.masterMeterR, 1)

    this.cueBus = ctx.createGain()
    this.hpCueGain = ctx.createGain()
    this.hpMasterGain = ctx.createGain()
    this.hpLevel = ctx.createGain()
    this.hpStream = ctx.createMediaStreamDestination()
    this.cueBus.connect(this.hpCueGain).connect(this.hpLevel)
    this.limiter.connect(this.hpMasterGain).connect(this.hpLevel)
    this.hpLevel.connect(this.hpStream)
  }

  async init(): Promise<void> {
    await this.ctx.audioWorklet.addModule(deckProcessorUrl)
    await this.ctx.audioWorklet.addModule(utilityProcessorsUrl)
    this.channels = [
      new Channel(this.ctx, this.masterBus, this.cueBus),
      new Channel(this.ctx, this.masterBus, this.cueBus)
    ]
    this.sampler = new Sampler(this.ctx)
    this.sampler.output.connect(this.masterBus)
    await this.sampler.loadBuiltIns()

    this.recorder = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit'
    })
    this.recorder.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onRecordChunk?.(e.data)
    this.limiter.connect(this.recorder)

    this.setCrossfader(0.5)
    // Effects that follow the beat are scheduled a little ahead of time; re-plan often.
    this.ticker = window.setInterval(() => {
      const now = this.ctx.currentTime
      for (const ch of this.channels) ch.tick(now)
    }, 25)
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  dispose(): void {
    clearInterval(this.ticker)
    void this.ctx.close()
    void this.hpCtx?.close()
  }

  // -------------------- mixer controls --------------------

  /** 0 = full deck 1, 1 = full deck 2. */
  setCrossfader(pos: number, curve: CrossfaderCurve = this.xfCurve): void {
    this.xfCurve = curve
    let a: number
    let b: number
    if (curve === 'smooth') {
      // Constant-power curve: a² + b² = 1 so loudness stays even through the blend.
      a = Math.cos((pos * Math.PI) / 2)
      b = Math.sin((pos * Math.PI) / 2)
    } else {
      // "Scratch" curve: both decks at full volume except at the very edges.
      a = Math.min(1, (1 - pos) / 0.06)
      b = Math.min(1, pos / 0.06)
    }
    const t = this.ctx.currentTime
    this.channels[0].xfade.gain.setTargetAtTime(a, t, 0.004)
    this.channels[1].xfade.gain.setTargetAtTime(b, t, 0.004)
  }

  /** Master knob 0..1: 0.8 = 0 dB, 1 = +6 dB, 0 = silent. */
  setMaster(v: number): void {
    const gain = v <= 0.001 ? 0 : Math.pow(10, ((v - 0.8) * 30) / 20)
    this.masterGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01)
  }

  /** 0 = only cue channels in the headphones, 1 = only the master mix. */
  setHeadphoneMix(v: number): void {
    const t = this.ctx.currentTime
    this.hpCueGain.gain.setTargetAtTime(Math.cos((v * Math.PI) / 2), t, 0.01)
    this.hpMasterGain.gain.setTargetAtTime(Math.sin((v * Math.PI) / 2), t, 0.01)
  }

  setHeadphoneLevel(v: number): void {
    this.hpLevel.gain.setTargetAtTime(v * v * 1.5, this.ctx.currentTime, 0.01)
  }

  setSamplerVolume(v: number): void {
    this.sampler.output.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01)
  }

  // -------------------- output devices --------------------

  static async listOutputs(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audiooutput')
  }

  async setOutputs(masterId: string, headphoneId: string): Promise<void> {
    const sink = (id: string): string => (id === 'default' ? '' : id)
    try {
      await this.ctx.setSinkId(sink(masterId))
    } catch (err) {
      console.warn('Could not switch master output', err)
    }
    if (this.hpCtx) {
      await this.hpCtx.close()
      this.hpCtx = null
    }
    if (headphoneId) {
      const hp = new AudioContext({ latencyHint: 'interactive' })
      try {
        await hp.setSinkId(sink(headphoneId))
      } catch (err) {
        console.warn('Could not open headphone output', err)
      }
      hp.createMediaStreamSource(this.hpStream.stream).connect(hp.destination)
      if (hp.state !== 'running') await hp.resume()
      this.hpCtx = hp
    }
  }

  // -------------------- recording --------------------

  setRecording(on: boolean): void {
    this.recorder?.port.postMessage({ recording: on })
  }
}

let instance: AudioEngine | null = null

export async function createEngine(): Promise<AudioEngine> {
  if (instance) return instance
  instance = new AudioEngine()
  await instance.init()
  return instance
}

export function getEngine(): AudioEngine {
  if (!instance) throw new Error('Audio engine not started')
  return instance
}
