// Messages exchanged between the main thread and the analysis worker (worker.ts).
//
// Usage from the main thread:
//   const worker = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' })
//   const req: AnalysisRequest = { id, mono, sampleRate, bpmLow, bpmHint }
//   worker.postMessage(req, [mono.buffer])   // transfer instead of copying the samples
//   worker.onmessage = (e: MessageEvent<AnalysisResponse>) => { ... }

import type { AnalysisResult } from '../../../shared/types'

export interface AnalysisRequest {
  /** Caller-chosen id, echoed back in the response. */
  id: number
  /** Mono (L+R)/2 samples, -1..1. */
  mono: Float32Array
  sampleRate: number
  /** Tempo range lower bound: tempi are folded into [bpmLow, 2 * bpmLow). */
  bpmLow: number
  /** Optional BPM from the file's tags (e.g. ID3 TBPM); null/undefined when absent. */
  bpmHint?: number | null
}

export type AnalysisResponse =
  { id: number; result: AnalysisResult; error?: undefined } | { id: number; error: string; result?: undefined }
