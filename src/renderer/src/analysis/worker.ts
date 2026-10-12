// Web Worker entry point: runs analyzeAudio off the UI thread.
// See protocol.ts for the message shapes.

import { analyzeAudio } from './analyze'
import type { AnalysisRequest, AnalysisResponse } from './protocol'

// The renderer's tsconfig uses the DOM lib, not the WebWorker lib, so describe the bits of
// the worker global scope we use.
interface WorkerScope {
  onmessage: ((e: MessageEvent<AnalysisRequest>) => void) | null
  postMessage(message: AnalysisResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  const { id, mono, sampleRate, bpmLow } = e.data
  try {
    const result = analyzeAudio(mono, sampleRate, { bpmLow })
    scope.postMessage({ id, result }, [result.waveform.buffer])
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
