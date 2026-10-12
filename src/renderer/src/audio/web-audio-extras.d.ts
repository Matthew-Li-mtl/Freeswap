// Web Audio features Chromium supports that TypeScript's DOM typings don't include yet.

interface AudioContext {
  /** Route this context's output to a specific audio device ('' = system default). */
  setSinkId(sinkId: string | { type: 'none' }): Promise<void>
  readonly sinkId: string | { type: 'none' }
}
