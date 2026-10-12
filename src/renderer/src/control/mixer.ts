// Master-section controls (crossfader, master volume, headphones, sampler, recording)
// and the "click a control's label to kill/reset it" behaviour.

import { api } from '../platform'
import { getEngine, type CrossfaderCurve } from '../audio/engine'
import { deck, patchMixer, useDecks } from '../state/decks'
import { toast } from '../state/ui'
import { setFader, setFilter, setFxDepth, setTempo, setTrim, toggleFx, toggleKill } from './deck'

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const mixer = () => useDecks.getState().mixer

export function setCrossfader(v: number): void {
  const crossfader = clamp01(v)
  patchMixer({ crossfader })
  getEngine().setCrossfader(crossfader)
}

export function setCrossfaderCurve(curve: CrossfaderCurve): void {
  patchMixer({ crossfaderCurve: curve })
  getEngine().setCrossfader(mixer().crossfader, curve)
}

export function setMasterVolume(v: number): void {
  const master = clamp01(v)
  patchMixer({ master })
  getEngine().setMaster(master)
}

export function setHeadphoneMix(v: number): void {
  const hpMix = clamp01(v)
  patchMixer({ hpMix })
  getEngine().setHeadphoneMix(hpMix)
}

export function setHeadphoneLevel(v: number): void {
  const hpLevel = clamp01(v)
  patchMixer({ hpLevel })
  getEngine().setHeadphoneLevel(hpLevel)
}

export function setSamplerVolume(v: number): void {
  const samplerVolume = clamp01(v)
  patchMixer({ samplerVolume })
  getEngine().setSamplerVolume(samplerVolume)
}

export function applyMixerToEngine(): void {
  const m = mixer()
  const e = getEngine()
  e.setCrossfader(m.crossfader, m.crossfaderCurve)
  e.setMaster(m.master)
  e.setHeadphoneMix(m.hpMix)
  e.setHeadphoneLevel(m.hpLevel)
  e.setSamplerVolume(m.samplerVolume)
}

// ---------------------------------------------------------------------------
// Label toggles. Clicking a control's name flips it between its current value and
// its "neutral" value (EQ bands use a proper kill instead). A second click restores.

function toggleTo(key: string, current: number, neutral: number, apply: (v: number) => void): void {
  const saved = useDecks.getState().saved
  if (Math.abs(current - neutral) > 1e-6) {
    useDecks.setState({ saved: { ...saved, [key]: current } })
    apply(neutral)
  } else if (saved[key] != null) {
    apply(saved[key])
  }
}

export type LabelControl =
  | { kind: 'eq'; deck: number; band: 'high' | 'mid' | 'low' }
  | { kind: 'trim' | 'filter' | 'fader' | 'tempo'; deck: number }
  | { kind: 'fx'; deck: number; slot: number }
  | { kind: 'master' | 'hpMix' | 'hpLevel' | 'sampler' | 'crossfader' }

export function toggleLabel(c: LabelControl): void {
  const m = mixer()
  switch (c.kind) {
    case 'eq':
      return toggleKill(c.deck, c.band)
    case 'trim':
      return toggleTo(`trim${c.deck}`, deck(c.deck).trim, 0, (v) => setTrim(c.deck, v))
    case 'filter':
      return toggleTo(`filter${c.deck}`, deck(c.deck).filter, 0.5, (v) => setFilter(c.deck, v))
    case 'fader':
      return toggleTo(`fader${c.deck}`, deck(c.deck).fader, 0, (v) => setFader(c.deck, v))
    case 'tempo':
      return toggleTo(`tempo${c.deck}`, deck(c.deck).tempo, 0, (v) => setTempo(c.deck, v))
    case 'fx':
      return toggleFx(c.deck, c.slot)
    case 'master':
      return toggleTo('master', m.master, 0, setMasterVolume)
    case 'hpMix':
      return toggleTo('hpMix', m.hpMix, 0, setHeadphoneMix)
    case 'hpLevel':
      return toggleTo('hpLevel', m.hpLevel, 0, setHeadphoneLevel)
    case 'sampler':
      return toggleTo('sampler', m.samplerVolume, 0, setSamplerVolume)
    case 'crossfader':
      return toggleTo('crossfader', m.crossfader, 0.5, setCrossfader)
  }
}

export { setFxDepth }

// ---------------------------------------------------------------------------

export async function toggleRecording(): Promise<void> {
  const e = getEngine()
  if (!mixer().recording) {
    try {
      await api.recording.start(e.ctx.sampleRate, 2)
    } catch (err) {
      toast(`Couldn't start recording: ${(err as Error).message}`, 'error')
      return
    }
    e.onRecordChunk = (chunk) => api.recording.write(chunk)
    e.setRecording(true)
    patchMixer({ recording: true, recordStartedAt: Date.now() })
  } else {
    e.setRecording(false)
    patchMixer({ recording: false })
    // Give the audio thread a moment to flush its last chunk.
    await new Promise((r) => setTimeout(r, 150))
    const path = await api.recording.stop()
    e.onRecordChunk = null
    patchMixer({ lastRecording: path })
    toast(`Mix saved: ${path}`)
  }
}
