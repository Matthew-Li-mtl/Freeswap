// Turning a track file into raw audio samples (PCM).
//
// fetch() reads the file through our private fsmedia:// protocol, then the browser's
// built-in decoder (decodeAudioData) handles MP3, AAC/M4A, FLAC, WAV, Ogg and Opus.
// Anything it can't decode (AIFF, WMA, ALAC...) is converted to FLAC by ffmpeg in the
// main process first; we just ask for the "?transcode" URL.

import type { Track } from '@shared/types'
import { api } from '../platform'

const ALWAYS_TRANSCODE = /\.(aif|aiff|wma|alac)$/i

export async function decodeTrack(track: Track, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const direct = !ALWAYS_TRANSCODE.test(track.path)
  if (direct) {
    try {
      return await decodeUrl(api.trackUrl(track.id), ctx)
    } catch {
      /* fall through to transcoding */
    }
  }
  return decodeUrl(api.trackUrl(track.id, true), ctx)
}

async function decodeUrl(url: string, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not read file (${res.status})`)
  const bytes = await res.arrayBuffer()
  return ctx.decodeAudioData(bytes)
}

/** Average all channels into one (analysis doesn't need stereo). */
export function mixdown(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length)
  const n = buf.numberOfChannels
  for (let c = 0; c < n; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) out[i] += d[i] / n
  }
  return out
}
