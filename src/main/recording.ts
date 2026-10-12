// Writes the master output to a WAV file while recording.
// The renderer streams interleaved Float32 PCM chunks; we convert them to 16-bit
// integers (with a little dither) and append them. The WAV header stores the total
// data size, which we only know at the end, so it is patched when recording stops.

import { promises as fs } from 'node:fs'
import path from 'node:path'

export class WavRecorder {
  private file: fs.FileHandle | null = null
  private filePath = ''
  private bytes = 0
  private channels = 2
  private sampleRate = 48000
  private queue: Promise<void> = Promise.resolve()

  async start(folder: string, sampleRate: number, channels: number): Promise<string> {
    await this.stop()
    await fs.mkdir(folder, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    this.filePath = path.join(folder, `Freeswap mix ${stamp}.wav`)
    this.file = await fs.open(this.filePath, 'w')
    this.bytes = 0
    this.channels = channels
    this.sampleRate = sampleRate
    await this.file.write(header(sampleRate, channels, 0), 0, 44, 0)
    return this.filePath
  }

  write(chunk: ArrayBuffer): void {
    const file = this.file
    if (!file) return
    const f32 = new Float32Array(chunk)
    const out = Buffer.alloc(f32.length * 2)
    for (let i = 0; i < f32.length; i++) {
      // TPDF dither: two uniform randoms summed, about +/-1 LSB. This turns the
      // quantization error into soft, constant noise instead of harsh distortion.
      const dither = (Math.random() - Math.random()) / 32768
      const s = Math.max(-1, Math.min(1, f32[i] + dither))
      out.writeInt16LE(Math.round(s * 32767), i * 2)
    }
    const offset = 44 + this.bytes
    this.bytes += out.length
    this.queue = this.queue.then(async () => {
      await file.write(out, 0, out.length, offset)
    })
  }

  async stop(): Promise<string> {
    const file = this.file
    if (!file) return this.filePath
    this.file = null
    await this.queue
    await file.write(header(this.sampleRate, this.channels, this.bytes), 0, 44, 0)
    await file.close()
    return this.filePath
  }
}

function header(sampleRate: number, channels: number, dataBytes: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16) // fmt chunk size
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * channels * 2, 28) // byte rate
  b.writeUInt16LE(channels * 2, 32) // block align
  b.writeUInt16LE(16, 34) // bits per sample
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}
