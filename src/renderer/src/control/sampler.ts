// User samples: drop any library track onto a pad in SAMPLER mode to use it as a sample.

import { getEngine } from '../audio/engine'
import { decodeTrack } from '../audio/decode'
import { getTrack } from '../state/library'
import { settings, updateSettings } from '../state/settings'
import { toast, useUi } from '../state/ui'

const MAX_SECONDS = 30 // samples are one-shots; keep memory use small

export async function assignSample(slot: number, trackId: number, persist = true): Promise<void> {
  const track = getTrack(trackId)
  if (!track || !track.available) return
  const ctx = getEngine().ctx
  try {
    const full = await decodeTrack(track, ctx)
    const len = Math.min(full.length, Math.floor(MAX_SECONDS * full.sampleRate))
    const buf = ctx.createBuffer(full.numberOfChannels, len, full.sampleRate)
    for (let c = 0; c < full.numberOfChannels; c++) buf.copyToChannel(full.getChannelData(c).subarray(0, len), c)
    getEngine().sampler.setSlot(slot, buf, track.title)
    useUi.setState((u) => ({ samplerVersion: u.samplerVersion + 1 }))
    if (persist) await updateSettings({ samplerSlots: { ...settings().samplerSlots, [slot]: trackId } })
  } catch (err) {
    toast(`Couldn't use "${track.title}" as a sample: ${(err as Error).message}`, 'error')
  }
}

/** Re-load user samples saved in settings (called at start-up). */
export async function restoreSamples(): Promise<void> {
  const slots = settings().samplerSlots ?? {}
  for (const [slot, id] of Object.entries(slots)) await assignSample(Number(slot), id, false)
}
