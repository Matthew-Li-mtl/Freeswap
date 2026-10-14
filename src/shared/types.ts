// Data shapes shared by the main process (database, files) and the renderer (UI, audio).
// Everything here must be plain, structured-clone-able data so it can cross IPC.

export type TrackSource = 'local' | 'youtube' | 'spotify'

/**
 * A constant-tempo beat grid.
 * Beat k (any integer, may be negative) sits at `anchor + k * 60 / bpm` seconds.
 * Beat 0 (the anchor) is the first beat of a phrase, so beat k starts a bar when
 * k % 4 === 0 and starts a phrase when k % 32 === 0 (8 bars of 4 beats).
 */
export interface BeatGrid {
  bpm: number
  anchor: number
}

export interface HotCue {
  slot: number // 0..7
  time: number // seconds
  color: string
}

export interface Track {
  id: number
  title: string
  artist: string
  album: string
  genre: string
  year: number | null
  comment: string
  duration: number // seconds, 0 until known
  bpm: number | null
  /** 0-11 = C..B major, 12-23 = C..B minor. See shared/musicKey.ts */
  key: number | null
  grid: BeatGrid | null
  analyzed: boolean
  /** BPM / key stored in the file's tags by other software, if any. */
  tagBpm: number | null
  tagKey: number | null
  /** Suggested trim (dB) that brings the track to the reference loudness. */
  gainDb: number | null
  cuePoint: number | null
  hotCues: HotCue[]
  source: TrackSource
  sourceUrl: string | null
  path: string
  available: boolean
  fileSize: number
  addedAt: number // epoch ms
  hasArtwork: boolean
}

export interface Folder {
  id: number
  parentId: number | null
  name: string
  position: number
}

export interface LibrarySnapshot {
  tracks: Track[]
  folders: Folder[]
  /** folderId -> ordered list of track ids */
  membership: Record<number, number[]>
}

/** Fields the UI is allowed to edit on a track. */
export interface TrackPatch {
  title?: string
  artist?: string
  album?: string
  genre?: string
  comment?: string
  bpm?: number | null
  key?: number | null
  grid?: BeatGrid | null
  cuePoint?: number | null
  hotCues?: HotCue[]
}

export interface AnalysisResult {
  duration: number
  bpm: number | null
  key: number | null
  grid: BeatGrid | null
  gainDb: number | null
  /** WAVEFORM_RATE columns per second, 4 bytes each: low, mid, high, peak (0-255). */
  waveform: Uint8Array
}

/** Tempo fader ranges (±fraction). 1 = ±100 %, i.e. from stopped to double speed. */
export const TEMPO_RANGES = [0.06, 0.1, 0.16, 0.25, 0.5, 1]

export const WAVEFORM_RATE = 150
export const ANALYSIS_VERSION = 2

export type KeyNotation = 'musical' | 'camelot'

export interface Settings {
  masterDeviceId: string
  headphoneDeviceId: string // '' = headphones disabled
  keyNotation: KeyNotation
  defaultTempoRange: number // one of TEMPO_RANGES
  autoGain: boolean
  bpmRangeLow: number // detected tempos are folded into [low, low*2)
  downloadFolder: string
  recordingFolder: string
  lockPlayingDeck: boolean
  waveformZoom: number // seconds visible in the zoomed waveform
  keymap: Record<string, string[]> | null // action id -> key combos; null = defaults
  browserHeight: number
  /** Sampler slot (0-15) -> library track id, for user-assigned samples. */
  samplerSlots: Record<string, number>
}

export const DEFAULT_SETTINGS: Omit<Settings, 'downloadFolder' | 'recordingFolder'> = {
  masterDeviceId: 'default',
  headphoneDeviceId: '',
  keyNotation: 'musical',
  defaultTempoRange: 0.25,
  autoGain: true,
  bpmRangeLow: 75,
  lockPlayingDeck: true,
  waveformZoom: 8,
  keymap: null,
  browserHeight: 300,
  samplerSlots: {}
}

export interface ImportResult {
  tracks: Track[]
  /** In-app folders the import created or filled at the top level (for highlighting). */
  folders: number[]
}

export interface ImportProgress {
  done: number
  total: number
  current: string
}

export interface DownloadJob {
  id: string
  url: string
  status: 'queued' | 'downloading' | 'importing' | 'done' | 'error'
  progress: number // 0..1
  title: string
  error?: string
}
