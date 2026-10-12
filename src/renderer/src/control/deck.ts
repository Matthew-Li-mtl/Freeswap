// Deck behaviour: what happens when you press PLAY, CUE, a hot cue, SYNC, etc.
// These functions are the single entry point for the on-screen controls AND the
// keyboard, so both always behave identically. They update the UI store and send
// commands to the audio engine.

import type { BeatGrid, HotCue, Track } from '@shared/types'
import { api } from '../platform'
import { getEngine } from '../audio/engine'
import { decodeTrack } from '../audio/decode'
import { FX_LIST, type FxId } from '../audio/effects'
import { deck, patchDeck, useDecks, type DeckState, type PadMode } from '../state/decks'
import { getTrack, upsertTracks } from '../state/library'
import { settings } from '../state/settings'
import { toast } from '../state/ui'
import { analysisQueue } from '../library/analysisQueue'
import { loadWaveform } from '../library/waveforms'

export const HOT_CUE_COLORS = ['#ff4d6d', '#ff9f43', '#ffd84d', '#4cd97b', '#3ec7ff', '#6c7bff', '#b77bff', '#ff6ad5']

/** Beat-jump pad layout: left = backwards, right = forwards. */
export const BEAT_JUMPS = [-4, -1, 1, 4, -32, -16, 16, 32]

const player = (d: number) => getEngine().channels[d].player
const channel = (d: number) => getEngine().channels[d]
const loadTokens = [0, 0]
const cuePreview = [false, false]
const hotPreview: (number | null)[] = [null, null]

export function currentBpm(s: DeckState): number | null {
  return s.grid ? s.grid.bpm * (1 + s.tempo) : null
}

function beatLen(s: DeckState): number {
  return s.grid ? 60 / s.grid.bpm : 0.5
}

function snapToBeat(s: DeckState, t: number): number {
  if (!s.quantize || !s.grid) return t
  const b = beatLen(s)
  return s.grid.anchor + Math.round((t - s.grid.anchor) / b) * b
}

/** Earliest beat at or after 0 s; a sensible default cue point. */
function firstBeat(grid: BeatGrid): number {
  const b = 60 / grid.bpm
  return grid.anchor - Math.floor(grid.anchor / b) * b
}

/** Keep anchor inside [0, one phrase) — same grid, canonical form. */
function normalizeGrid(g: BeatGrid): BeatGrid {
  const phrase = (32 * 60) / g.bpm
  let anchor = g.anchor % phrase
  if (anchor < 0) anchor += phrase
  return { bpm: g.bpm, anchor }
}

// ============================== loading ==============================

export function initDecks(): void {
  for (const d of [0, 1]) {
    player(d).on((ev) => {
      if (ev.t === 'loop') patchDeck(d, { loop: ev.loop })
      else if (ev.t === 'ended') {
        patchDeck(d, { playing: false, ended: true })
        updateMaster()
      }
    })
  }
  // When analysis finishes for a loaded track, give the deck its grid and key.
  analysisQueue.onAnalyzed((t) => {
    for (const d of [0, 1]) {
      if (deck(d).trackId === t.id) applyAnalysis(d, t)
    }
  })
}

function applyAnalysis(d: number, t: Track): void {
  const s = deck(d)
  patchDeck(d, { grid: t.grid, key: t.key, analyzing: false })
  player(d).setGrid(t.grid)
  if (!s.playing && t.cuePoint == null && t.grid && s.cuePoint === 0) {
    const cue = firstBeat(t.grid)
    patchDeck(d, { cuePoint: cue })
    player(d).send({ t: 'seek', pos: cue })
  }
  if (settings().autoGain && t.gainDb != null && s.trim === 0) setTrim(d, t.gainDb)
  if (s.sync) applySync(d, true)
}

export async function loadTrack(d: number, trackId: number): Promise<void> {
  const track = getTrack(trackId)
  if (!track) return
  if (!track.available) {
    toast(`"${track.title}" isn't available — is its drive plugged in?`, 'error')
    return
  }
  const s = deck(d)
  if (s.playing && settings().lockPlayingDeck) {
    toast(`Deck ${d + 1} is playing. Pause it first (or disable the lock in Settings).`)
    return
  }
  const token = ++loadTokens[d]
  player(d).send({ t: 'pause' })
  patchDeck(d, {
    trackId,
    loading: true,
    analyzing: false,
    error: null,
    playing: false,
    ended: false,
    loop: null,
    duration: track.duration,
    grid: track.grid,
    key: track.key,
    cuePoint: track.cuePoint ?? 0,
    hotCues: hotCueSlots(track.hotCues),
    gridEdit: false
  })
  void loadWaveform(trackId)
  try {
    const buffer = await decodeTrack(track, getEngine().ctx)
    if (token !== loadTokens[d]) return // another track was loaded meanwhile
    const p = player(d)
    p.load(buffer)
    p.setGrid(track.grid)
    const cue = track.cuePoint ?? (track.grid ? firstBeat(track.grid) : 0)
    p.send({ t: 'seek', pos: cue })
    patchDeck(d, { loading: false, duration: buffer.duration, cuePoint: cue })
    if (settings().autoGain && track.gainDb != null) setTrim(d, track.gainDb)
    else setTrim(d, 0)
    if (!track.analyzed) {
      patchDeck(d, { analyzing: true })
      void analysisQueue.analyzeNow(trackId, buffer).then((t) => {
        if (!t && deck(d).trackId === trackId) patchDeck(d, { analyzing: false })
      })
    }
    if (deck(d).sync) applySync(d, true)
  } catch (err) {
    if (token !== loadTokens[d]) return
    console.error(err)
    patchDeck(d, { loading: false, trackId: null, error: 'Could not decode this file' })
    toast(`Couldn't load "${track.title}": ${(err as Error).message}`, 'error')
  }
}

function hotCueSlots(list: HotCue[]): (HotCue | null)[] {
  const slots: (HotCue | null)[] = new Array(8).fill(null)
  for (const h of list) if (h.slot >= 0 && h.slot < 8) slots[h.slot] = h
  return slots
}

async function persist(d: number, patch: Parameters<typeof api.library.updateTrack>[1]): Promise<void> {
  const id = deck(d).trackId
  if (id == null) return
  const t = await api.library.updateTrack(id, patch)
  upsertTracks([t])
}

// ============================== transport ==============================

export function play(d: number): void {
  const s = deck(d)
  if (s.trackId == null || s.loading) return
  cuePreview[d] = false
  hotPreview[d] = null
  player(d).send({ t: 'play' })
  patchDeck(d, { playing: true, ended: false })
  if (s.sync) {
    alignPhase(d)
    // The first alignment uses a slightly stale position; re-check once running.
    setTimeout(() => deck(d).sync && alignPhase(d), 120)
  }
  updateMaster()
}

export function pause(d: number): void {
  player(d).send({ t: 'pause' })
  patchDeck(d, { playing: false })
  updateMaster()
}

export function togglePlay(d: number): void {
  if (deck(d).playing && !cuePreview[d] && hotPreview[d] == null) pause(d)
  else play(d)
}

/**
 * CUE button, like a CD player for DJs:
 *  - playing: jump back to the cue point and stop
 *  - stopped away from the cue point: set a new cue point here
 *  - stopped on the cue point: play while held, return when released
 */
export function cueDown(d: number): void {
  const s = deck(d)
  if (s.trackId == null || s.loading) return
  const p = player(d)
  if (s.playing && !cuePreview[d]) {
    p.send({ t: 'pause' })
    p.send({ t: 'seek', pos: s.cuePoint })
    patchDeck(d, { playing: false })
    updateMaster()
    return
  }
  const pos = p.posNow()
  if (Math.abs(pos - s.cuePoint) > 0.02) {
    const cue = snapToBeat(s, pos)
    p.send({ t: 'seek', pos: cue })
    patchDeck(d, { cuePoint: cue })
    void persist(d, { cuePoint: cue })
  } else {
    cuePreview[d] = true
    p.send({ t: 'play' })
    patchDeck(d, { playing: true })
  }
}

export function cueUp(d: number): void {
  if (!cuePreview[d]) return
  cuePreview[d] = false
  const p = player(d)
  p.send({ t: 'pause' })
  p.send({ t: 'seek', pos: deck(d).cuePoint })
  patchDeck(d, { playing: false })
}

export function jumpToStart(d: number): void {
  if (deck(d).trackId == null) return
  player(d).send({ t: 'seek', pos: 0 })
  patchDeck(d, { ended: false })
}

/** Click on a waveform: jump there (quantized to keep the beat if playing). */
export function seekTo(d: number, pos: number): void {
  const s = deck(d)
  if (s.trackId == null) return
  player(d).send({ t: 'seek', pos: Math.max(0, Math.min(s.duration, pos)), quantize: s.playing })
  patchDeck(d, { ended: false })
}

// ============================== hot cues ==============================

export function hotCueDown(d: number, slot: number): void {
  const s = deck(d)
  if (s.trackId == null || s.loading) return
  const p = player(d)
  const hc = s.hotCues[slot]
  if (!hc) {
    const time = snapToBeat(s, p.posNow())
    const hotCues = [...s.hotCues]
    hotCues[slot] = { slot, time, color: HOT_CUE_COLORS[slot] }
    patchDeck(d, { hotCues })
    void persist(d, { hotCues: hotCues.filter((h): h is HotCue => h != null) })
    return
  }
  if (s.playing && hotPreview[d] == null && !cuePreview[d]) {
    p.send({ t: 'seek', pos: hc.time, quantize: true })
  } else {
    // Stopped: play from the hot cue while the pad is held.
    hotPreview[d] = slot
    p.send({ t: 'seek', pos: hc.time })
    p.send({ t: 'play' })
    patchDeck(d, { playing: true })
  }
}

export function hotCueUp(d: number, slot: number): void {
  if (hotPreview[d] !== slot) return
  hotPreview[d] = null
  const hc = deck(d).hotCues[slot]
  const p = player(d)
  p.send({ t: 'pause' })
  if (hc) p.send({ t: 'seek', pos: hc.time })
  patchDeck(d, { playing: false })
}

export function deleteHotCue(d: number, slot: number): void {
  const s = deck(d)
  if (!s.hotCues[slot]) return
  const hotCues = [...s.hotCues]
  hotCues[slot] = null
  patchDeck(d, { hotCues })
  void persist(d, { hotCues: hotCues.filter((h): h is HotCue => h != null) })
}

// ============================== tempo & sync ==============================

export function setTempo(d: number, value: number, fromSync = false): void {
  const s = deck(d)
  if (s.sync && !s.master && !fromSync) return // locked to the master deck
  const tempo = fromSync ? value : Math.max(-s.tempoRange, Math.min(s.tempoRange, value))
  patchDeck(d, { tempo })
  player(d).setTempo(1 + tempo)
  // Anyone synced to this deck follows.
  const o = 1 - d
  if (!fromSync && deck(o).sync && !deck(o).master) applySync(o, false)
}

export function nudgeTempo(d: number, delta: number): void {
  setTempo(d, deck(d).tempo + delta)
}

export function resetTempo(d: number): void {
  setTempo(d, 0)
}

export function setTempoRange(d: number, range: number): void {
  patchDeck(d, { tempoRange: range })
  setTempo(d, deck(d).tempo)
}

/** Temporary speed change from the jog wheel or the nudge keys (pitch bend). */
export function setBend(d: number, amount: number): void {
  player(d).send({ t: 'bend', amount })
}

export function toggleSync(d: number): void {
  const s = deck(d)
  if (s.sync) {
    patchDeck(d, { sync: false, master: false })
    return
  }
  const o = 1 - d
  if (!s.grid || !deck(o).grid) {
    toast('Sync needs both decks loaded and analysed')
    return
  }
  patchDeck(d, { sync: true, master: false })
  patchDeck(o, { master: true })
  applySync(d, true)
}

export function makeMaster(d: number): void {
  patchDeck(d, { master: true })
  patchDeck(1 - d, { master: false })
  const o = 1 - d
  if (deck(o).sync) applySync(o, false)
}

/** Auto-choose the master: the deck that's playing, preferring the current one. */
function updateMaster(): void {
  const [a, b] = useDecks.getState().decks
  const m = a.master ? 0 : b.master ? 1 : -1
  if (m >= 0 && deck(m).playing) return
  const playingDeck = a.playing && a.grid ? 0 : b.playing && b.grid ? 1 : -1
  if (playingDeck >= 0 && !deck(playingDeck).sync) {
    patchDeck(playingDeck, { master: true })
    patchDeck(1 - playingDeck, { master: false })
  }
}

/** Match this deck's BPM to the other deck (allowing half/double time) and optionally its beat phase. */
function applySync(d: number, phase: boolean): void {
  const s = deck(d)
  const m = deck(1 - d)
  const mBpm = currentBpm(m)
  if (!s.grid || !mBpm) return
  const candidates = [mBpm, mBpm * 2, mBpm / 2]
  const target = candidates.reduce((best, c) => (Math.abs(c - s.grid!.bpm) < Math.abs(best - s.grid!.bpm) ? c : best))
  setTempo(d, target / s.grid.bpm - 1, true)
  if (phase && s.playing) alignPhase(d)
}

/** Shift this deck so its beats land exactly on the master deck's beats. */
function alignPhase(d: number): void {
  const s = deck(d)
  const m = deck(1 - d)
  if (!s.grid || !m.grid || !m.playing) return
  const t = getEngine().ctx.currentTime
  const bm = player(1 - d).beatAt(t)
  const bs = player(d).beatAt(t)
  if (bm == null || bs == null) return
  const ratio = (s.grid.bpm * (1 + s.tempo)) / (m.grid.bpm * (1 + m.tempo)) // 1, 2 or 0.5
  const frac = (x: number) => x - Math.floor(x)
  let diff = frac(bm * ratio) - frac(bs)
  if (diff > 0.5) diff -= 1
  if (diff < -0.5) diff += 1
  if (Math.abs(diff) < 0.002) return
  player(d).send({ t: 'phaseShift', seconds: diff * beatLen(s) })
}

// ============================== toggles ==============================

export function toggleKeyLock(d: number): void {
  const on = !deck(d).keyLock
  patchDeck(d, { keyLock: on })
  player(d).send({ t: 'keyLock', on })
}

export function toggleQuantize(d: number): void {
  const on = !deck(d).quantize
  patchDeck(d, { quantize: on })
  player(d).send({ t: 'quantize', on })
}

export function toggleSlip(d: number): void {
  const on = !deck(d).slip
  patchDeck(d, { slip: on })
  player(d).send({ t: 'slip', on })
}

export function toggleVinyl(d: number): void {
  patchDeck(d, { vinyl: !deck(d).vinyl })
}

// ============================== loops ==============================

export const loopIn = (d: number) => deck(d).trackId != null && player(d).send({ t: 'loopIn' })
export const loopOut = (d: number) => deck(d).trackId != null && player(d).send({ t: 'loopOut' })
export const reloop = (d: number) => deck(d).trackId != null && player(d).send({ t: 'reloop' })
export const autoLoop = (d: number, beats = 4) => deck(d).trackId != null && player(d).send({ t: 'autoLoop', beats })
export const loopHalve = (d: number) => player(d).send({ t: 'loopScale', factor: 0.5 })
export const loopDouble = (d: number) => player(d).send({ t: 'loopScale', factor: 2 })
export const beatJump = (d: number, beats: number) =>
  deck(d).trackId != null && player(d).send({ t: 'beatJump', beats })

// ============================== jog wheel ==============================

// One platter revolution = 1.8 s of audio, the speed of a 33⅓ RPM record.
const SECONDS_PER_REV = 1.8
const jog = [
  { scratching: false, angle: 0, bendTimer: 0 },
  { scratching: false, angle: 0, bendTimer: 0 }
]

/** Mouse down on the platter (top of the jog wheel). */
export function jogTouch(d: number, down: boolean): void {
  const s = deck(d)
  const j = jog[d]
  if (s.trackId == null) return
  if (down) {
    // Vinyl mode: touching the platter grabs the record. Otherwise only when stopped.
    if (s.vinyl || !s.playing) {
      j.scratching = true
      j.angle = 0
      player(d).send({ t: 'scratch', on: true })
    }
  } else if (j.scratching) {
    j.scratching = false
    player(d).send({ t: 'scratch', on: false })
  }
}

/** Platter rotated by `dAngle` radians (or nudged when not scratching). */
export function jogTurn(d: number, dAngle: number, dt: number): void {
  const j = jog[d]
  if (j.scratching) {
    j.angle += dAngle
    player(d).send({ t: 'scratchMove', delta: (j.angle / (2 * Math.PI)) * SECONDS_PER_REV })
  } else {
    jogBend(d, dAngle, dt)
  }
}

/** Grab the track directly (dragging the zoomed waveform): it follows the mouse. */
const grabs = [0, 0]
export function grabStart(d: number): void {
  if (deck(d).trackId == null) return
  grabs[d] = 0
  player(d).send({ t: 'scratch', on: true })
}
export function grabMove(d: number, seconds: number): void {
  grabs[d] += seconds
  player(d).send({ t: 'scratchMove', delta: grabs[d] })
}
export function grabEnd(d: number): void {
  player(d).send({ t: 'scratch', on: false })
}

/** Outer ring: spinning it speeds up / slows down the track briefly (beat matching). */
export function jogBend(d: number, dAngle: number, dt: number): void {
  const s = deck(d)
  if (s.trackId == null) return
  if (!s.playing) {
    // Stopped: the ring moves the playhead finely ("search").
    const p = player(d)
    p.send({ t: 'seek', pos: p.posNow() + (dAngle / (2 * Math.PI)) * 0.3 })
    return
  }
  const revPerSec = dAngle / (2 * Math.PI) / Math.max(dt, 0.004)
  const amount = Math.max(-0.5, Math.min(0.5, revPerSec * 0.12))
  setBend(d, amount)
  const j = jog[d]
  clearTimeout(j.bendTimer)
  j.bendTimer = window.setTimeout(() => setBend(d, 0), 70)
}

// ============================== pads ==============================

export function setPadMode(d: number, padMode: PadMode): void {
  patchDeck(d, { padMode })
}

/** Pad FX layout: top row = loop rolls, bottom row = momentary effects. */
type PadFx =
  | { label: string; roll: number }
  | { label: string; fx: FxId; beats: number; depth: number }
  | { label: string; brake: true }

export const PAD_FX: PadFx[] = [
  { label: 'ROLL 1/2', roll: 0.5 },
  { label: 'ROLL 1/4', roll: 0.25 },
  { label: 'ROLL 1/8', roll: 0.125 },
  { label: 'ROLL 1/16', roll: 0.0625 },
  { label: 'ECHO', fx: 'echo', beats: 0.5, depth: 0.75 },
  { label: 'GATE', fx: 'gate', beats: 0.125, depth: 0.95 },
  { label: 'CRUSH', fx: 'crush', beats: 1, depth: 0.7 },
  { label: 'BRAKE', brake: true }
]

export function padDown(d: number, i: number, alt = false): void {
  const s = deck(d)
  switch (s.padMode) {
    case 'hotcue':
      if (alt) deleteHotCue(d, i)
      else hotCueDown(d, i)
      break
    case 'beatjump':
      beatJump(d, BEAT_JUMPS[i])
      break
    case 'padfx': {
      if (s.trackId == null) break
      const fx = PAD_FX[i]
      if ('roll' in fx) player(d).send({ t: 'roll', beats: fx.roll })
      else if ('brake' in fx) player(d).send({ t: 'brake', on: true, seconds: (2 * beatLen(s)) / (1 + s.tempo) })
      else {
        const slot = channel(d).padFx
        slot.setType(fx.fx, fx.beats)
        slot.setBeats(fx.beats)
        slot.setDepth(fx.depth)
        slot.setEnabled(true)
      }
      break
    }
    case 'sampler': {
      const slot = d * 8 + i
      const sampler = getEngine().sampler
      if (alt) sampler.stop(slot)
      else sampler.trigger(slot)
      break
    }
  }
}

export function padUp(d: number, i: number): void {
  const s = deck(d)
  if (s.padMode === 'hotcue') hotCueUp(d, i)
  else if (s.padMode === 'padfx') {
    const fx = PAD_FX[i]
    if ('roll' in fx) player(d).send({ t: 'roll', beats: null })
    else if ('brake' in fx) player(d).send({ t: 'brake', on: false, seconds: 0 })
    else channel(d).padFx.setEnabled(false)
  }
}

// ============================== beat grid editing ==============================

function setGrid(d: number, grid: BeatGrid): void {
  const g = normalizeGrid(grid)
  patchDeck(d, { grid: g })
  player(d).setGrid(g)
  void persist(d, { grid: g })
  const o = 1 - d
  if (deck(o).sync && !deck(o).master) applySync(o, false)
  if (deck(d).sync) applySync(d, false)
}

/** Move every marker by `ms` milliseconds. */
export function shiftGrid(d: number, ms: number): void {
  const g = deck(d).grid
  if (g) setGrid(d, { bpm: g.bpm, anchor: g.anchor + ms / 1000 })
}

/** Make the current playhead position a downbeat (beat "1" of a bar and phrase). */
export function setDownbeatHere(d: number): void {
  const s = deck(d)
  if (s.trackId == null) return
  const bpm = s.grid?.bpm ?? 120
  setGrid(d, { bpm, anchor: player(d).posNow() })
}

/** Shift which beats count as bar/phrase starts, by whole beats (bars keep their spacing). */
export function shiftDownbeat(d: number, beats: number): void {
  const g = deck(d).grid
  if (g) setGrid(d, { bpm: g.bpm, anchor: g.anchor + (beats * 60) / g.bpm })
}

/** Change BPM while keeping the beat nearest the playhead where it is. */
export function setGridBpm(d: number, bpm: number): void {
  const s = deck(d)
  if (s.trackId == null || !(bpm > 20 && bpm < 400)) return
  const g = s.grid ?? { bpm, anchor: 0 }
  const pos = player(d).posNow()
  const oldLen = 60 / g.bpm
  const k = Math.round((pos - g.anchor) / oldLen)
  const pinned = g.anchor + k * oldLen
  // Beat k keeps both its time and its number, so bar/phrase labels don't move either.
  const newBpm = Math.round(bpm * 100) / 100
  setGrid(d, { bpm: newBpm, anchor: pinned - k * (60 / newBpm) })
}

const taps: number[][] = [[], []]

/** Tap along to the beat; after 4+ taps the BPM is set from the average interval. */
export function tapTempo(d: number): void {
  const now = performance.now()
  const list = taps[d]
  if (list.length && now - list[list.length - 1] > 2000) list.length = 0
  list.push(now)
  if (list.length > 16) list.shift()
  if (list.length >= 4) {
    const avg = (list[list.length - 1] - list[0]) / (list.length - 1)
    setGridBpm(d, 60000 / avg)
  }
}

export function setKey(d: number, key: number | null): void {
  patchDeck(d, { key })
  void persist(d, { key })
}

/** Throw away grid/key edits and analyse again from scratch. */
export async function reanalyze(d: number): Promise<void> {
  const id = deck(d).trackId
  if (id == null) return
  await persist(d, { grid: null, key: null })
  patchDeck(d, { analyzing: true })
  const t = await analysisQueue.analyzeNow(id)
  if (!t) patchDeck(d, { analyzing: false })
}

export function toggleGridEdit(d: number): void {
  patchDeck(d, { gridEdit: !deck(d).gridEdit })
}

// ============================== mixer section (per channel) ==============================

export function setTrim(d: number, db: number): void {
  const v = Math.max(-12, Math.min(12, db))
  patchDeck(d, { trim: v })
  channel(d).setTrim(v)
}

export function setEq(d: number, band: 'high' | 'mid' | 'low', v: number): void {
  const s = deck(d)
  const value = Math.max(0, Math.min(1, v))
  patchDeck(d, { eq: { ...s.eq, [band]: value } })
  channel(d).setEq(band, value, s.kills[band])
}

export function toggleKill(d: number, band: 'high' | 'mid' | 'low'): void {
  const s = deck(d)
  const kills = { ...s.kills, [band]: !s.kills[band] }
  patchDeck(d, { kills })
  channel(d).setEq(band, s.eq[band], kills[band])
}

export function setFilter(d: number, v: number): void {
  const value = Math.max(0, Math.min(1, v))
  patchDeck(d, { filter: value })
  channel(d).setFilter(value)
}

export function setFader(d: number, v: number): void {
  const value = Math.max(0, Math.min(1, v))
  patchDeck(d, { fader: value })
  channel(d).setFader(value)
}

export function toggleCue(d: number): void {
  const on = !deck(d).cue
  patchDeck(d, { cue: on })
  channel(d).setCue(on)
}

// ============================== effects ==============================

function patchFx(d: number, i: number, patch: Partial<DeckState['fx'][number]>): void {
  const fx = deck(d).fx.map((f, k) => (k === i ? { ...f, ...patch } : f))
  patchDeck(d, { fx })
}

export function setFxType(d: number, i: number, type: DeckState['fx'][number]['type'], beats?: number): void {
  const slot = channel(d).fx[i]
  slot.setType(type, beats)
  const b = beats ?? FX_LIST.find((f) => f.id === type)?.beats ?? 1
  slot.setBeats(b)
  patchFx(d, i, { type, beats: b })
}

export function toggleFx(d: number, i: number): void {
  const on = !deck(d).fx[i].enabled
  channel(d).fx[i].setEnabled(on)
  patchFx(d, i, { enabled: on })
}

export function setFxDepth(d: number, i: number, v: number): void {
  const depth = Math.max(0, Math.min(1, v))
  channel(d).fx[i].setDepth(depth)
  patchFx(d, i, { depth })
}

export function setFxBeats(d: number, i: number, beats: number): void {
  channel(d).fx[i].setBeats(beats)
  patchFx(d, i, { beats })
}

/** Push the deck's initial UI state (effects, tempo...) into the audio engine. */
export function syncEngineFromState(): void {
  for (const d of [0, 1]) {
    const s = deck(d)
    s.fx.forEach((f, i) => {
      const slot = channel(d).fx[i]
      slot.setType(f.type, f.beats)
      slot.setBeats(f.beats)
      slot.setDepth(f.depth)
      slot.setEnabled(f.enabled)
    })
    channel(d).setFader(s.fader)
    channel(d).setFilter(s.filter)
    channel(d).setTrim(s.trim)
    for (const b of ['high', 'mid', 'low'] as const) channel(d).setEq(b, s.eq[b], s.kills[b])
    player(d).send({ t: 'quantize', on: s.quantize })
  }
}
