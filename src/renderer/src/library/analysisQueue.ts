// Runs track analysis (BPM, beat grid, key, loudness, waveform) in a Web Worker so the
// heavy maths never freezes the UI or the audio.
//
// Background jobs analyse newly imported tracks one at a time. When you load an
// unanalysed track onto a deck it jumps the queue and reuses the audio the deck
// already decoded.

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

const ANALYSIS_RATE = 22050

class AnalysisQueue {
  private worker: Worker | null = null
  private queue: Job[] = []
  private busy = false
  private nextId = 1
  private replies = new Map<number, (r: WorkerReply) => void>()
  private listeners = new Set<(t: Track) => void>()

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const cb = this.replies.get(e.data.id)
        this.replies.delete(e.data.id)
        cb?.(e.data)
      }
    }
    return this.worker
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
    this.updateCount()
    void this.pump()
  }

  /** Analyse right away (front of the queue), optionally with audio already decoded. */
  analyzeNow(trackId: number, buffer?: AudioBuffer): Promise<Track | null> {
    return new Promise((resolve) => {
      this.queue = this.queue.filter((j) => j.trackId !== trackId)
      this.queue.unshift({ trackId, buffer, resolve })
      this.updateCount()
      void this.pump()
    })
  }

  private updateCount(): void {
    useLibrary.setState({ analysisQueue: this.queue.length + (this.busy ? 1 : 0) })
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        this.updateCount()
        let result: Track | null = null
        try {
          result = await this.run(job)
        } catch (err) {
          console.warn('Analysis failed for track', job.trackId, err)
        }
        job.resolve(result)
      }
    } finally {
      this.busy = false
      this.updateCount()
    }
  }

  private async run(job: Job): Promise<Track | null> {
    const track = getTrack(job.trackId)
    if (!track || !track.available) return null
    let mono: Float32Array
    let rate: number
    if (job.buffer) {
      mono = mixdown(job.buffer)
      rate = job.buffer.sampleRate
    } else {
      // An OfflineAudioContext decodes *and resamples* to its own rate: 22 kHz is
      // plenty for analysis and uses half the memory of 44.1/48 kHz.
      const off = new OfflineAudioContext(1, 1, ANALYSIS_RATE)
      const buf = await decodeTrack(track, off)
      mono = mixdown(buf)
      rate = buf.sampleRate
    }
    const id = this.nextId++
    const reply = await new Promise<WorkerReply>((resolve) => {
      this.replies.set(id, resolve)
      this.getWorker().postMessage({ id, mono, sampleRate: rate, bpmLow: settings().bpmRangeLow }, [mono.buffer])
    })
    if (!reply.result) throw new Error(reply.error ?? 'analysis failed')
    const updated = await api.library.saveAnalysis(track.id, reply.result)
    setWaveform(track.id, reply.result.waveform)
    upsertTracks([updated])
    for (const l of this.listeners) l(updated)
    return updated
  }
}

export const analysisQueue = new AnalysisQueue()
