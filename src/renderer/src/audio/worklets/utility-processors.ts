// Small AudioWorklet processors used by effects and the recorder.

/**
 * Bitcrusher: lowers the bit depth (fewer amplitude steps -> gritty noise) and the
 * sample rate (holds each sample for N samples -> metallic aliasing).
 * Parameters arrive as messages: { bits, hold }.
 */
class BitcrusherProcessor extends AudioWorkletProcessor {
  private bits = 16
  private hold = 1
  private counter = [0, 0]
  private held = [0, 0]

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ bits: number; hold: number }>) => {
      this.bits = e.data.bits
      this.hold = Math.max(1, Math.round(e.data.hold))
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const steps = Math.pow(2, this.bits - 1)
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input[ch] ?? input[0]
      const out = output[ch]
      if (!inp) {
        out.fill(0)
        continue
      }
      for (let i = 0; i < out.length; i++) {
        if (this.counter[ch]++ % this.hold === 0) {
          this.held[ch] = Math.round(inp[i] * steps) / steps
        }
        out[i] = this.held[ch]
      }
    }
    return true
  }
}

/**
 * Recorder tap: collects stereo input into ~0.1 s interleaved Float32 chunks and
 * posts them to the main thread, which forwards them to the WAV writer.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false
  private chunk = new Float32Array(4096 * 2)
  private fill = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ recording: boolean }>) => {
      this.recording = e.data.recording
      if (!this.recording) this.flush()
    }
  }

  private flush(): void {
    if (this.fill === 0) return
    const out = this.chunk.slice(0, this.fill)
    this.port.postMessage(out.buffer, [out.buffer])
    this.fill = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true
    const input = inputs[0]
    const l = input[0]
    if (!l) return true
    const r = input[1] ?? l
    for (let i = 0; i < l.length; i++) {
      this.chunk[this.fill++] = l[i]
      this.chunk[this.fill++] = r[i]
      if (this.fill >= this.chunk.length) this.flush()
    }
    return true
  }
}

registerProcessor('bitcrusher-processor', BitcrusherProcessor)
registerProcessor('recorder-processor', RecorderProcessor)
