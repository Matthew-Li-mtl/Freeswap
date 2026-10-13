// Runs track analysis (BPM, beat grid, key, loudness, waveform) in Web Workers so the
// heavy maths never freezes the UI or the audio.
//
// Several tracks are analysed in parallel, one per worker, with the number of workers
// based on the CPU's core count (leaving one core for the UI and audio). When you load an
// unanalysed track onto a deck, it jumps the queue and reuses the audio the deck already
// decoded.

import type { AnalysisResult, Track } from '@shared/types'
import { api } from '../platform'
import { decodeTrack, mixdown } from '../audio/decode'
import { getTrack, upsertTracks, useLibrary } from '../state/library'
import { settings } from '../state/settings'
import { setWaveform } from './waveforms'

interface Job {
  trackId: number
  buffer?: AudioBuffer
  resolve: (t: Track | null) => void
}

type WorkerReply = { id: number; result?: AnalysisResult; error?: string }

// Decode at 44.1 kHz (the rate most files already have, so the browser doesn't have to
// resample, which turned out to be slower than decoding itself). The worker then halves
// the rate with its own fast filter.
const ANALYSIS_RATE = 44100
const MAX_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

class AnalysisQueue {
  private idle: Worker[] = []
  private workerCount = 0
  private queue: Job[] = []
  private running = 0
  private nextId = 1
  private replies = new Map<number, (r: WorkerReply) => void>()
  private listeners = new Set<(t: Track) => void>()

  /** Borrow an idle worker, creating one if we're under the limit. */
  private acquire(): Worker {
    const w = this.idle.pop()
    if (w) return w
    this.workerCount++
    const worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const cb = this.replies.get(e.data.id)
      this.replies.delete(e.data.id)
      cb?.(e.data)
    }
    return worker
  }

  /** Called whenever a track finishes analysis. */
  onAnalyzed(cb: (t: Track) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  enqueue(ids: number[]): void {
    for (const id of ids) {
      if (this.queue.some((j) => j.trackId === id)) continue
      this.queue.push({ trackId: id, resolve: () => undefined })
    }
    this.pump()
  }

  /** Analyse right away (front of the queue), optionally with audio already decoded. */
  analyzeNow(trackId: number, buffer?: AudioBuffer): Promise<Track | null> {
    return new Promise((resolve) => {
      this.queue = this.queue.filter((j) => j.trackId !== trackId)
      this.queue.unshift({ trackId, buffer, resolve })
      // A deck is waiting: allow one extra job beyond the normal limit.
      this.pump(1)
    })
  }

  private updateCount(): void {
    useLibrary.setState({ analysisQueue: this.queue.length + this.running })
  }

  private pump(extra = 0): void {
    while (this.queue.length && this.running < MAX_WORKERS + extra) {
      const job = this.queue.shift()!
      this.running++
      void this.run(job)
        .catch((err) => {
          console.warn('Analysis failed for track', job.trackId, err)
          return null
        })
        .then((t) => {
          job.resolve(t)
          this.running--
          this.updateCount()
          this.pump()
        })
    }
    this.updateCount()
  }

  private async run(job: Job): Promise<Track | null> {
    const track = getTrack(job.trackId)
    if (!track || !track.available) return null
    const t0 = performance.now()
    let mono: Float32Array
    let rate: number
    if (job.buffer) {
      mono = mixdown(job.buffer)
      rate = job.buffer.sampleRate
    } else {
      // An OfflineAudioContext decodes to its own sample rate (see ANALYSIS_RATE).
      const off = new OfflineAudioContext(1, 1, ANALYSIS_RATE)
      const buf = await decodeTrack(track, off)
      mono = mixdown(buf)
      rate = buf.sampleRate
    }
    const t1 = performance.now()
    const id = this.nextId++
    const worker = this.acquire()
    let reply: WorkerReply
    try {
      reply = await new Promise<WorkerReply>((resolve) => {
        this.replies.set(id, resolve)
        worker.postMessage(
          { id, mono, sampleRate: rate, bpmLow: settings().bpmRangeLow, bpmHint: track.tagBpm ?? undefined },
          [mono.buffer]
        )
      })
    } finally {
      this.idle.push(worker)
    }
    if (!reply.result) throw new Error(reply.error ?? 'analysis failed')
    const result = reply.result
    // Fall back to the file's own tags when the analyser couldn't decide.
    if (result.key == null && track.tagKey != null) result.key = track.tagKey
    if (result.bpm == null && result.grid == null && track.tagBpm != null) result.bpm = track.tagBpm
    const t2 = performance.now()
    console.debug(
      `[analysis] "${track.title}": decode ${Math.round(t1 - t0)} ms, analyse ${Math.round(t2 - t1)} ms` +
        ` (${this.workerCount} worker${this.workerCount === 1 ? '' : 's'})`
    )
    const updated = await api.library.saveAnalysis(track.id, result)
    setWaveform(track.id, result.waveform)
    upsertTracks([updated])
    for (const l of this.listeners) l(updated)
    return updated
  }
}

export const analysisQueue = new AnalysisQueue()
