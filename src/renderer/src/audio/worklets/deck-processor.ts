// The deck player. This code runs on the browser's real-time audio thread, inside an
// AudioWorklet. Every ~2.7 ms (128 samples at 48 kHz) the browser calls process() and we
// must fill the output buffer, never blocking, allocating or waiting.
//
// It owns the decoded PCM of the loaded track and a floating-point "read head" (pos).
// Speed is just how far the read head moves per output sample:
//   rate 1.0  -> normal speed, 1.05 -> +5 %, -1 -> backwards (scratching), 0 -> stopped.
// Reading between two samples uses cubic interpolation, so any rate sounds smooth.
//
// When Key Lock is on we instead use WSOLA time-stretching (see produceHop) so the tempo
// changes but the pitch doesn't.

import type { DeckCommand, DeckEvent, LoopInfo } from '../deckProtocol'

const FADE = 256 // crossfade length (samples) used to hide every jump/discontinuity
const WS_L = 2048 // WSOLA frame length (~43 ms at 48 kHz)
const WS_H = WS_L / 2 // WSOLA hop: frames overlap by 50 %
const WS_SEARCH = 480 // how far (samples) WSOLA may shift a frame to find a good match
const WS_DECIM = 4 // correlate every 4th sample during the coarse search (speed)
const REPORT_EVERY = 3 // send our position to the main thread every N blocks

class DeckProcessor extends AudioWorkletProcessor {
  // ----- track data -----
  private L: Float32Array = new Float32Array(0)
  private R: Float32Array = new Float32Array(0)
  private len = 0

  // ----- transport -----
  private pos = 0 // read head, in samples (fractional)
  private playing = false
  private tempo = 1 // rate requested by the tempo slider / sync
  private bendTarget = 0 // temporary +/- rate from the jog wheel or nudge keys
  private bend = 0
  private rate = 0 // actual smoothed rate this sample
  private runGain = 0 // 0..1 envelope, avoids clicks on play/pause

  // ----- scratching -----
  private scratching = false
  private scratchOrigin = 0
  private scratchTarget = 0

  // ----- features -----
  private keyLock = false
  private quantize = true
  private anchor = 0 // beat grid anchor (samples)
  private beatLen = 0 // samples per beat; 0 = no grid
  private loopStart = -1
  private loopEnd = -1
  private loopActive = false
  private slip = false
  private slipPos = 0
  private rollActive = false
  private savedLoop: { s: number; e: number; a: boolean } | null = null
  private braking = false
  private brakeRate = 0
  private brakeDecel = 0

  // ----- crossfade from an "old head" after a jump -----
  private fadeRemain = 0
  private fadeKind: 'resample' | 'buffer' = 'resample'
  private fadePos = 0
  private fadeBufL = new Float32Array(WS_H)
  private fadeBufR = new Float32Array(WS_H)
  private fadeBufLen = 0
  private fadeIdx = 0

  // ----- WSOLA time-stretcher state -----
  private stretching = false
  private wsAccL = new Float32Array(WS_L)
  private wsAccR = new Float32Array(WS_L)
  private wsQL = new Float32Array(WS_H)
  private wsQR = new Float32Array(WS_H)
  private wsQLen = 0
  private wsQIdx = 0
  private wsPrev = -1
  private wsFirst = true
  private wsWin = new Float32Array(WS_L)
  private wsTemplate = new Float32Array(Math.ceil(WS_H / WS_DECIM))

  // ----- smoothing coefficients (one-pole filters) -----
  private aRate = 1 - Math.exp(-1 / (sampleRate * 0.004))
  private aScratch = 1 - Math.exp(-1 / (sampleRate * 0.002))
  private aBend = 1 - Math.exp(-1 / (sampleRate * 0.02))
  private aGain = 1 - Math.exp(-1 / (sampleRate * 0.003))

  private blockCount = 0

  constructor() {
    super()
    // Periodic Hann window: two copies offset by half a window sum to exactly 1.
    for (let i = 0; i < WS_L; i++) this.wsWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WS_L)
    this.port.onmessage = (e: MessageEvent<DeckCommand>) => this.handle(e.data)
  }

  private post(ev: DeckEvent): void {
    this.port.postMessage(ev)
  }

  // ======================= commands from the main thread =======================

  private handle(c: DeckCommand): void {
    const sr = sampleRate
    switch (c.t) {
      case 'load':
        this.L = c.left
        this.R = c.right
        this.len = c.left.length
        this.pos = 0
        this.slipPos = 0
        this.playing = false
        this.rate = 0
        this.runGain = 0
        this.loopStart = this.loopEnd = -1
        this.loopActive = false
        this.rollActive = false
        this.braking = false
        this.scratching = false
        this.resetStretch()
        this.post({ t: 'loaded', duration: this.len / sr })
        this.postLoop()
        break
      case 'unload':
        this.L = new Float32Array(0)
        this.R = new Float32Array(0)
        this.len = 0
        this.playing = false
        break
      case 'play':
        if (this.len && this.pos < this.len) this.playing = true
        break
      case 'pause':
        this.playing = false
        break
      case 'seek': {
        let target = c.pos * sr
        if (c.quantize && this.quantize && this.beatLen > 0 && this.playing) {
          // Keep the current beat phase: land on the target's beat + our offset from ours.
          const phase = this.pos - this.nearestBeat(this.pos)
          target = this.nearestBeat(target) + phase
        }
        this.jumpTo(Math.max(0, Math.min(this.len - 1, target)))
        if (!this.isDiverged()) this.slipPos = this.pos
        break
      }
      case 'tempo':
        this.tempo = c.rate
        break
      case 'bend':
        this.bendTarget = c.amount
        break
      case 'phaseShift':
        this.jumpTo(this.pos + c.seconds * sr)
        this.slipPos += c.seconds * sr
        break
      case 'scratch':
        if (c.on) {
          this.scratching = true
          this.scratchOrigin = this.pos
          this.scratchTarget = this.pos
        } else if (this.scratching) {
          this.scratching = false
          if (this.slip) this.jumpTo(this.slipPos)
        }
        break
      case 'scratchMove':
        if (this.scratching) this.scratchTarget = this.scratchOrigin + c.delta * sr
        break
      case 'keyLock':
        this.keyLock = c.on
        break
      case 'quantize':
        this.quantize = c.on
        break
      case 'grid':
        this.anchor = c.anchor * sr
        this.beatLen = c.beatLen * sr
        break
      case 'noGrid':
        this.beatLen = 0
        break
      case 'loopIn':
        this.loopStart = this.snap(this.pos)
        this.loopEnd = -1
        this.loopActive = false
        this.postLoop()
        break
      case 'loopOut': {
        if (this.loopStart < 0 || this.pos <= this.loopStart) break
        let end = this.snap(this.pos)
        if (end <= this.loopStart + 32) end = this.loopStart + (this.beatLen || sr * 0.5)
        this.loopEnd = end
        this.loopActive = true
        this.postLoop()
        break
      }
      case 'reloop':
        if (this.loopActive) this.exitLoop()
        else if (this.loopStart >= 0 && this.loopEnd > this.loopStart) {
          this.loopActive = true
          this.jumpTo(this.loopStart)
        }
        this.postLoop()
        break
      case 'loopExit':
        if (this.loopActive) this.exitLoop()
        this.postLoop()
        break
      case 'autoLoop': {
        if (this.loopActive) {
          this.exitLoop()
        } else {
          const len = c.beats * (this.beatLen || sr * 0.5)
          const start = this.quantize && this.beatLen > 0 ? this.floorBeat(this.pos) : this.pos
          this.loopStart = start
          this.loopEnd = start + len
          this.loopActive = true
          if (this.pos >= this.loopEnd) this.jumpTo(start)
        }
        this.postLoop()
        break
      }
      case 'loopScale': {
        if (this.loopStart < 0 || this.loopEnd <= this.loopStart) break
        const newLen = Math.max(32, (this.loopEnd - this.loopStart) * c.factor)
        this.loopEnd = this.loopStart + newLen
        if (this.loopActive && this.pos >= this.loopEnd) {
          this.jumpTo(this.loopStart + ((this.pos - this.loopStart) % newLen))
        }
        this.postLoop()
        break
      }
      case 'loopSet':
        this.loopStart = c.start * sr
        this.loopEnd = c.end * sr
        this.loopActive = c.active
        this.postLoop()
        break
      case 'beatJump': {
        const delta = c.beats * (this.beatLen || sr * 0.5)
        if (this.loopActive) {
          this.loopStart += delta
          this.loopEnd += delta
          this.postLoop()
        }
        this.jumpTo(Math.max(0, Math.min(this.len - 1, this.pos + delta)))
        this.slipPos += delta
        break
      }
      case 'roll':
        this.roll(c.beats)
        break
      case 'slip':
        this.slip = c.on
        if (!c.on) this.slipPos = this.pos
        break
      case 'brake':
        if (c.on && this.playing && !this.braking) {
          this.braking = true
          this.slipPos = this.pos
          this.brakeRate = Math.max(this.rate, 0.01)
          this.brakeDecel = this.brakeRate / Math.max(1, c.seconds * sr)
        } else if (!c.on && this.braking) {
          this.braking = false
          this.jumpTo(this.slipPos)
        }
        break
    }
  }

  private roll(beats: number | null): void {
    const sr = sampleRate
    if (beats != null) {
      const len = beats * (this.beatLen || sr * 0.5)
      if (!this.rollActive) {
        this.savedLoop = { s: this.loopStart, e: this.loopEnd, a: this.loopActive }
        this.rollActive = true
        this.slipPos = this.pos
      }
      const ref = this.slipPos
      const start = this.quantize && this.beatLen > 0 ? this.anchor + Math.floor((ref - this.anchor) / len) * len : ref
      this.loopStart = start
      this.loopEnd = start + len
      this.loopActive = true
      this.jumpTo(start + ((ref - start) % len))
    } else if (this.rollActive) {
      this.rollActive = false
      const s = this.savedLoop
      this.loopStart = s ? s.s : -1
      this.loopEnd = s ? s.e : -1
      this.loopActive = s ? s.a : false
      this.jumpTo(this.slipPos)
      this.postLoop()
    }
  }

  private exitLoop(): void {
    this.loopActive = false
    if (this.slip) this.jumpTo(this.slipPos)
  }

  private postLoop(): void {
    const sr = sampleRate
    const loop: LoopInfo | null =
      this.loopStart >= 0
        ? {
            start: this.loopStart / sr,
            end: this.loopEnd > this.loopStart ? this.loopEnd / sr : null,
            active: this.loopActive
          }
        : null
    this.post({ t: 'loop', loop })
  }

  private nearestBeat(p: number): number {
    return this.anchor + Math.round((p - this.anchor) / this.beatLen) * this.beatLen
  }

  private floorBeat(p: number): number {
    // Treat "just before the beat" (within 1/8 beat) as on the beat: humans press early too.
    return this.anchor + Math.floor((p - this.anchor) / this.beatLen + 0.125) * this.beatLen
  }

  private snap(p: number): number {
    return this.quantize && this.beatLen > 0 ? this.nearestBeat(p) : p
  }

  private isDiverged(): boolean {
    return this.rollActive || this.braking || (this.slip && (this.scratching || this.loopActive))
  }

  /** Move the read head, crossfading from the old position so there's no click. */
  private jumpTo(newPos: number): void {
    if (this.stretching && this.wsQLen - this.wsQIdx > 0) {
      // Fade out whatever the stretcher had already produced.
      const n = this.wsQLen - this.wsQIdx
      this.fadeBufL.set(this.wsQL.subarray(this.wsQIdx, this.wsQLen))
      this.fadeBufR.set(this.wsQR.subarray(this.wsQIdx, this.wsQLen))
      this.fadeBufLen = n
      this.fadeIdx = 0
      this.fadeKind = 'buffer'
    } else {
      this.fadeKind = 'resample'
      this.fadePos = this.pos
    }
    this.fadeRemain = FADE
    this.pos = newPos
    this.resetStretch()
  }

  private resetStretch(): void {
    this.wsAccL.fill(0)
    this.wsAccR.fill(0)
    this.wsQLen = 0
    this.wsQIdx = 0
    this.wsPrev = -1
    this.wsFirst = true
  }

  // ============================ audio rendering ============================

  /** Catmull-Rom cubic interpolation between samples. */
  private read(buf: Float32Array, p: number): number {
    const i = Math.floor(p)
    const f = p - i
    const len = this.len
    let xm1: number, x0: number, x1: number, x2: number
    if (i >= 1 && i + 2 < len) {
      xm1 = buf[i - 1]
      x0 = buf[i]
      x1 = buf[i + 1]
      x2 = buf[i + 2]
    } else {
      xm1 = i - 1 >= 0 && i - 1 < len ? buf[i - 1] : 0
      x0 = i >= 0 && i < len ? buf[i] : 0
      x1 = i + 1 >= 0 && i + 1 < len ? buf[i + 1] : 0
      x2 = i + 2 >= 0 && i + 2 < len ? buf[i + 2] : 0
    }
    const c1 = 0.5 * (x1 - xm1)
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
    return ((c3 * f + c2) * f + c1) * f + x0
  }

  private at(buf: Float32Array, i: number): number {
    return i >= 0 && i < this.len ? buf[i] : 0
  }

  /**
   * WSOLA (Waveform Similarity Overlap-Add) produces the next WS_H output samples.
   * Idea: chop the source into overlapping windowed frames and lay them down one hop
   * apart in the output. To play faster we take frames from further apart in the source
   * (hop * rate), but lay them down at the same spacing, so pitch is unchanged.
   * Each new frame may slide up to +/-WS_SEARCH samples so its waveform lines up with
   * the previous one; that's what avoids the phasey "chorus" sound of naive overlap-add.
   */
  private produceHop(): void {
    const L = this.L
    const R = this.R
    const nominal = Math.round(this.pos)
    let start = nominal
    if (!this.wsFirst) {
      // Template: how the previous frame would naturally continue in the source.
      const natural = this.wsPrev + WS_H
      const tpl = this.wsTemplate
      for (let k = 0, j = natural; k < tpl.length; k++, j += WS_DECIM) tpl[k] = this.at(L, j) + this.at(R, j)
      let best = nominal
      let bestScore = -Infinity
      const score = (c: number): number => {
        let dot = 0
        let energy = 1e-9
        for (let k = 0, j = c; k < tpl.length; k++, j += WS_DECIM) {
          const x = this.at(L, j) + this.at(R, j)
          dot += tpl[k] * x
          energy += x * x
        }
        return dot / Math.sqrt(energy)
      }
      for (let c = nominal - WS_SEARCH; c <= nominal + WS_SEARCH; c += WS_DECIM) {
        const s = score(c)
        if (s > bestScore) {
          bestScore = s
          best = c
        }
      }
      // Fine search around the coarse winner.
      const coarse = best
      for (let c = coarse - WS_DECIM + 1; c < coarse + WS_DECIM; c++) {
        if (c === coarse) continue
        const s = score(c)
        if (s > bestScore) {
          bestScore = s
          best = c
        }
      }
      start = best
    }
    const accL = this.wsAccL
    const accR = this.wsAccR
    const win = this.wsWin
    for (let j = 0; j < WS_L; j++) {
      // The very first frame after a reset gets a flat front half so audio starts at full level.
      const w = this.wsFirst && j < WS_H ? 1 : win[j]
      accL[j] += this.at(L, start + j) * w
      accR[j] += this.at(R, start + j) * w
    }
    this.wsQL.set(accL.subarray(0, WS_H))
    this.wsQR.set(accR.subarray(0, WS_H))
    accL.copyWithin(0, WS_H)
    accR.copyWithin(0, WS_H)
    accL.fill(0, WS_L - WS_H)
    accR.fill(0, WS_L - WS_H)
    this.wsQLen = WS_H
    this.wsQIdx = 0
    this.wsPrev = start
    this.wsFirst = false
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const oL = out[0]
    const oR = out[1] ?? out[0]
    const n = oL.length
    const posAtStart = this.pos

    if (this.len === 0) {
      oL.fill(0)
      if (oR !== oL) oR.fill(0)
      this.report(posAtStart)
      return true
    }

    // Decide per block whether to time-stretch (Key Lock) or simply resample.
    const wantStretch = this.keyLock && this.playing && !this.scratching && !this.braking
    if (wantStretch !== this.stretching) {
      if (this.stretching) {
        this.jumpTo(this.pos) // fade out the stretcher's leftovers
        this.stretching = false
      } else {
        this.fadeKind = 'resample'
        this.fadePos = this.pos
        this.fadeRemain = FADE
        this.resetStretch()
        this.stretching = true
      }
    }

    for (let i = 0; i < n; i++) {
      // ---- 1. how fast should the read head move this sample? ----
      let desired: number
      let a = this.aRate
      if (this.scratching) {
        // Follow the platter: close the gap to the target position within ~15 ms.
        desired = (this.scratchTarget - this.pos) / (sampleRate * 0.015)
        if (desired > 20) desired = 20
        else if (desired < -20) desired = -20
        a = this.aScratch
      } else if (this.braking) {
        this.brakeRate = Math.max(0, this.brakeRate - this.brakeDecel)
        desired = this.brakeRate
      } else {
        this.bend += (this.bendTarget - this.bend) * this.aBend
        desired = this.playing ? this.tempo + this.bend : 0
      }
      this.rate += (desired - this.rate) * a
      const audible = this.scratching || (this.braking ? this.brakeRate > 0 : this.playing)
      this.runGain += ((audible ? 1 : 0) - this.runGain) * this.aGain

      // ---- 2. read the audio ----
      let sL: number
      let sR: number
      if (this.stretching) {
        if (this.wsQIdx >= this.wsQLen) this.produceHop()
        sL = this.wsQL[this.wsQIdx]
        sR = this.wsQR[this.wsQIdx]
        this.wsQIdx++
      } else {
        sL = this.read(this.L, this.pos)
        sR = this.read(this.R, this.pos)
      }

      // ---- 3. crossfade from the previous read head after a jump ----
      if (this.fadeRemain > 0) {
        const g = this.fadeRemain / FADE
        let oldL = 0
        let oldR = 0
        if (this.fadeKind === 'resample') {
          oldL = this.read(this.L, this.fadePos)
          oldR = this.read(this.R, this.fadePos)
          this.fadePos += this.rate
        } else if (this.fadeIdx < this.fadeBufLen) {
          oldL = this.fadeBufL[this.fadeIdx]
          oldR = this.fadeBufR[this.fadeIdx]
          this.fadeIdx++
        }
        sL = sL * (1 - g) + oldL * g
        sR = sR * (1 - g) + oldR * g
        this.fadeRemain--
      }

      oL[i] = sL * this.runGain
      oR[i] = sR * this.runGain

      // ---- 4. advance ----
      this.pos += this.rate
      if (this.isDiverged()) {
        if (this.playing) this.slipPos += this.tempo
      } else {
        this.slipPos = this.pos
      }
      if (this.loopActive && this.loopEnd > this.loopStart && this.rate > 0 && this.pos >= this.loopEnd) {
        this.jumpTo(this.loopStart + ((this.pos - this.loopEnd) % (this.loopEnd - this.loopStart)))
      }
      if (this.pos >= this.len) {
        this.pos = this.len
        if (this.playing) {
          this.playing = false
          this.post({ t: 'ended' })
        }
      } else if (this.pos < 0) {
        this.pos = 0
      }
    }

    this.report(posAtStart)
    return true
  }

  private report(posAtStart: number): void {
    if (++this.blockCount % REPORT_EVERY !== 0) return
    this.post({
      t: 'pos',
      pos: posAtStart / sampleRate,
      time: currentTime,
      rate: this.rate,
      playing: this.playing
    })
  }
}

registerProcessor('deck-processor', DeckProcessor)
