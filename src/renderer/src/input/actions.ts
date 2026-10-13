// Every keyboard-controllable action, plus the default key layout.
//
// Layout idea (QWERTY, no numpad needed): your LEFT hand plays deck 1 on the left half
// of the keyboard and your RIGHT hand plays deck 2 on the right half. Deck 2's keys are
// deck 1's keys moved six columns to the right (1→7, Q→U, A→J, Z→M...), so you only
// learn one layout. Each hand has its own modifier keys for extra "layers":
//   no modifier  = performance (pads, play/cue, loops, nudge)
//   Shift        = mixer (EQ, filter, volume, trim, tempo)
//   Ctrl         = effects and pad modes
//   Alt          = kills and beat-grid editing
// Left Shift/Ctrl/Alt switch layers for deck 1, the right-hand ones for deck 2, so
// both hands can work independently at the same time.

import * as D from '../control/deck'
import * as M from '../control/mixer'
import { BEAT_DIVISIONS, FX_LIST } from '../audio/effects'
import { TEMPO_RANGES } from '@shared/types'
import { deck, useDecks, type PadMode } from '../state/decks'

export interface ActionDef {
  id: string
  label: string
  group: string
  /** Momentary actions: called on key down / key up. */
  down?: () => void
  up?: () => void
  /** Continuous actions: called every frame while held with (units per second × dt). */
  rate?: number
  change?: (delta: number) => void
}

const mixer = () => useDecks.getState().mixer

function deckActions(d: number): ActionDef[] {
  const g = `Deck ${d + 1}`
  const a: ActionDef[] = []
  const press = (id: string, label: string, down: () => void, up?: () => void) =>
    a.push({ id: `d${d}.${id}`, label, group: g, down, up })
  const cont = (id: string, label: string, rate: number, change: (delta: number) => void) =>
    a.push({ id: `d${d}.${id}`, label, group: g, rate, change })

  for (let i = 0; i < 8; i++) {
    press(
      `pad${i + 1}`,
      `Pad ${i + 1}`,
      () => D.padDown(d, i),
      () => D.padUp(d, i)
    )
  }
  press(
    'cue',
    'Cue',
    () => D.cueDown(d),
    () => D.cueUp(d)
  )
  press('play', 'Play / pause', () => D.togglePlay(d))
  press(
    'bendDown',
    'Nudge slower (hold)',
    () => D.setBend(d, -0.04),
    () => D.setBend(d, 0)
  )
  press(
    'bendUp',
    'Nudge faster (hold)',
    () => D.setBend(d, 0.04),
    () => D.setBend(d, 0)
  )
  press('sync', 'Sync', () => D.toggleSync(d))
  press('loopIn', 'Loop in', () => D.loopIn(d))
  press('loopOut', 'Loop out', () => D.loopOut(d))
  press('reloop', 'Reloop / exit', () => D.reloop(d))
  press('loopDouble', 'Loop ×2', () => D.loopDouble(d))
  press('loopHalve', 'Loop ½', () => D.loopHalve(d))
  press('autoLoop', '4-beat loop', () => D.autoLoop(d, 4))
  press('loopAnchor', 'Loop resize: keep start / keep end', () => D.toggleLoopAnchor(d))

  // Mixer layer
  for (const band of ['high', 'mid', 'low'] as const) {
    const name = band === 'high' ? 'High' : band === 'mid' ? 'Mid' : 'Low'
    cont(`eq.${band}.up`, `${name} EQ up`, 1, (x) => D.setEq(d, band, deck(d).eq[band] + x))
    cont(`eq.${band}.down`, `${name} EQ down`, -1, (x) => D.setEq(d, band, deck(d).eq[band] + x))
    press(`kill.${band}`, `${name} kill`, () => D.toggleKill(d, band))
  }
  cont('filter.up', 'Filter → high-pass', 1, (x) => D.setFilter(d, deck(d).filter + x))
  cont('filter.down', 'Filter → low-pass', -1, (x) => D.setFilter(d, deck(d).filter + x))
  press('filter.toggle', 'Filter off / restore', () => M.toggleLabel({ kind: 'filter', deck: d }))
  cont('fader.up', 'Volume up', 1.5, (x) => D.setFader(d, deck(d).fader + x))
  cont('fader.down', 'Volume down', -1.5, (x) => D.setFader(d, deck(d).fader + x))
  press('fader.toggle', 'Mute / restore volume', () => M.toggleLabel({ kind: 'fader', deck: d }))
  cont('trim.up', 'Trim up', 12, (x) => D.setTrim(d, deck(d).trim + x))
  cont('trim.down', 'Trim down', -12, (x) => D.setTrim(d, deck(d).trim + x))
  press('cueHp', 'Headphone cue', () => D.toggleCue(d))
  cont('tempo.down', 'Tempo slower', -0.02, (x) => D.setTempo(d, deck(d).tempo + x * (deck(d).tempoRange / 0.1)))
  cont('tempo.up', 'Tempo faster', 0.02, (x) => D.setTempo(d, deck(d).tempo + x * (deck(d).tempoRange / 0.1)))
  press('tempo.reset', 'Tempo reset', () => D.resetTempo(d))
  press('keyLock', 'Key lock', () => D.toggleKeyLock(d))
  press('start', 'Jump to start', () => D.jumpToStart(d))
  press('master', 'Make master', () => D.makeMaster(d))

  // FX layer
  for (let i = 0; i < 3; i++) {
    cont(`fx${i + 1}.up`, `FX ${i + 1} depth up`, 1, (x) => D.setFxDepth(d, i, deck(d).fx[i].depth + x))
    cont(`fx${i + 1}.down`, `FX ${i + 1} depth down`, -1, (x) => D.setFxDepth(d, i, deck(d).fx[i].depth + x))
    press(`fx${i + 1}.toggle`, `FX ${i + 1} on / off`, () => D.toggleFx(d, i))
    press(`fx${i + 1}.next`, `FX ${i + 1} next effect`, () => {
      const types = FX_LIST.filter((f) => f.id !== 'none')
      const cur = types.findIndex((f) => f.id === deck(d).fx[i].type)
      D.setFxType(d, i, types[(cur + 1) % types.length].id)
    })
    press(`fx${i + 1}.length`, `FX ${i + 1} length (cycle)`, () => {
      const idx = BEAT_DIVISIONS.findIndex((b) => Math.abs(b - deck(d).fx[i].beats) < 1e-6)
      D.setFxBeats(d, i, BEAT_DIVISIONS[(idx + 1) % BEAT_DIVISIONS.length])
    })
  }
  press('tempoRange', 'Tempo range (cycle)', () => {
    const ranges = TEMPO_RANGES
    D.setTempoRange(d, ranges[(ranges.indexOf(deck(d).tempoRange) + 1) % ranges.length])
  })
  const modes: [PadMode, string][] = [
    ['hotcue', 'Pads: hot cues'],
    ['beatjump', 'Pads: beat jump'],
    ['padfx', 'Pads: pad FX'],
    ['sampler', 'Pads: sampler']
  ]
  for (const [m, label] of modes) press(`mode.${m}`, label, () => D.setPadMode(d, m))
  press('quantize', 'Quantize', () => D.toggleQuantize(d))
  press('slip', 'Slip', () => D.toggleSlip(d))
  press('vinyl', 'Vinyl (scratch) mode', () => D.toggleVinyl(d))

  // Grid layer
  press('grid.edit', 'Beat grid editor', () => D.toggleGridEdit(d))
  press('grid.tap', 'Tap tempo', () => D.tapTempo(d))
  press('grid.earlier', 'Grid 10 ms earlier', () => D.shiftGrid(d, -10))
  press('grid.later', 'Grid 10 ms later', () => D.shiftGrid(d, 10))
  press('grid.downbeat', 'Set beat 1 here', () => D.setDownbeatHere(d))
  press('grid.beatLeft', 'Downbeat 1 beat earlier', () => D.shiftDownbeat(d, -1))
  press('grid.beatRight', 'Downbeat 1 beat later', () => D.shiftDownbeat(d, 1))
  press('grid.barLeft', 'Phrase 1 bar earlier', () => D.shiftDownbeat(d, -4))
  press('grid.barRight', 'Phrase 1 bar later', () => D.shiftDownbeat(d, 4))
  return a
}

function globalActions(): ActionDef[] {
  const g = 'Mixer'
  return [
    {
      id: 'xf.left',
      label: 'Crossfader ← (deck 1)',
      group: g,
      rate: -2,
      change: (x) => M.setCrossfader(mixer().crossfader + x)
    },
    {
      id: 'xf.right',
      label: 'Crossfader → (deck 2)',
      group: g,
      rate: 2,
      change: (x) => M.setCrossfader(mixer().crossfader + x)
    },
    { id: 'xf.center', label: 'Crossfader centre', group: g, down: () => M.setCrossfader(0.5) },
    { id: 'master.up', label: 'Master up', group: g, rate: 0.6, change: (x) => M.setMasterVolume(mixer().master + x) },
    {
      id: 'master.down',
      label: 'Master down',
      group: g,
      rate: -0.6,
      change: (x) => M.setMasterVolume(mixer().master + x)
    },
    {
      id: 'hpLevel.up',
      label: 'Headphone level up',
      group: g,
      rate: 0.8,
      change: (x) => M.setHeadphoneLevel(mixer().hpLevel + x)
    },
    {
      id: 'hpLevel.down',
      label: 'Headphone level down',
      group: g,
      rate: -0.8,
      change: (x) => M.setHeadphoneLevel(mixer().hpLevel + x)
    },
    {
      id: 'hpMix.master',
      label: 'Headphone mix → master',
      group: g,
      rate: 1,
      change: (x) => M.setHeadphoneMix(mixer().hpMix + x)
    },
    {
      id: 'hpMix.cue',
      label: 'Headphone mix → cue',
      group: g,
      rate: -1,
      change: (x) => M.setHeadphoneMix(mixer().hpMix + x)
    },
    {
      id: 'sampler.up',
      label: 'Sampler volume up',
      group: g,
      rate: 0.8,
      change: (x) => M.setSamplerVolume(mixer().samplerVolume + x)
    },
    {
      id: 'sampler.down',
      label: 'Sampler volume down',
      group: g,
      rate: -0.8,
      change: (x) => M.setSamplerVolume(mixer().samplerVolume + x)
    },
    { id: 'record', label: 'Record mix', group: g, down: () => void M.toggleRecording() },
    {
      id: 'xf.curve',
      label: 'Crossfader curve (smooth / sharp)',
      group: g,
      down: () => M.setCrossfaderCurve(mixer().crossfaderCurve === 'smooth' ? 'sharp' : 'smooth')
    }
  ]
}

/** App actions are implemented by the UI (they need React state), registered at runtime. */
export const APP_ACTION_IDS = [
  ['app.search', 'Focus search'],
  ['app.keys', 'Show keyboard shortcuts'],
  ['app.settings', 'Settings'],
  ['app.up', 'Browser: previous track'],
  ['app.down', 'Browser: next track'],
  ['app.load1', 'Load selected track to deck 1'],
  ['app.load2', 'Load selected track to deck 2']
] as const

export function buildActions(app: Record<string, () => void>): ActionDef[] {
  return [
    ...deckActions(0),
    ...deckActions(1),
    ...globalActions(),
    ...APP_ACTION_IDS.map(([id, label]) => ({ id, label, group: 'App', down: () => app[id]?.() }))
  ]
}

// ------------------------------- default layout -------------------------------

/** Deck 2 = deck 1 shifted six keys to the right. */
const RIGHT_OF: Record<string, string> = {
  Digit1: 'Digit7',
  Digit2: 'Digit8',
  Digit3: 'Digit9',
  Digit4: 'Digit0',
  Digit5: 'Minus',
  KeyQ: 'KeyU',
  KeyW: 'KeyI',
  KeyE: 'KeyO',
  KeyR: 'KeyP',
  KeyT: 'BracketLeft',
  KeyA: 'KeyJ',
  KeyS: 'KeyK',
  KeyD: 'KeyL',
  KeyF: 'Semicolon',
  KeyG: 'Quote',
  KeyZ: 'KeyM',
  KeyX: 'Comma',
  KeyC: 'Period',
  KeyV: 'Slash',
  ShiftLeft: 'ShiftRight',
  ControlLeft: 'ControlRight',
  AltLeft: 'AltRight'
}

const DECK1_LAYOUT: Record<string, string> = {
  // performance layer
  pad1: 'Digit1',
  pad2: 'Digit2',
  pad3: 'Digit3',
  pad4: 'Digit4',
  pad5: 'KeyQ',
  pad6: 'KeyW',
  pad7: 'KeyE',
  pad8: 'KeyR',
  cue: 'KeyA',
  play: 'KeyS',
  bendDown: 'KeyD',
  bendUp: 'KeyF',
  sync: 'KeyZ',
  loopIn: 'KeyX',
  loopOut: 'KeyC',
  reloop: 'KeyV',
  loopDouble: 'Digit5',
  loopHalve: 'KeyT',
  autoLoop: 'KeyG',
  // Shift = mixer layer
  'eq.high.up': 'ShiftLeft+Digit1',
  'eq.high.down': 'ShiftLeft+KeyQ',
  'eq.mid.up': 'ShiftLeft+Digit2',
  'eq.mid.down': 'ShiftLeft+KeyW',
  'eq.low.up': 'ShiftLeft+Digit3',
  'eq.low.down': 'ShiftLeft+KeyE',
  'filter.up': 'ShiftLeft+Digit4',
  'filter.down': 'ShiftLeft+KeyR',
  'fader.up': 'ShiftLeft+Digit5',
  'fader.down': 'ShiftLeft+KeyT',
  'trim.up': 'ShiftLeft+KeyA',
  'trim.down': 'ShiftLeft+KeyZ',
  cueHp: 'ShiftLeft+KeyS',
  'tempo.down': 'ShiftLeft+KeyD',
  'tempo.up': 'ShiftLeft+KeyF',
  'tempo.reset': 'ShiftLeft+KeyG',
  keyLock: 'ShiftLeft+KeyX',
  start: 'ShiftLeft+KeyC',
  master: 'ShiftLeft+KeyV',
  // Ctrl = FX layer
  'fx1.up': 'ControlLeft+Digit1',
  'fx1.down': 'ControlLeft+KeyQ',
  'fx2.up': 'ControlLeft+Digit2',
  'fx2.down': 'ControlLeft+KeyW',
  'fx3.up': 'ControlLeft+Digit3',
  'fx3.down': 'ControlLeft+KeyE',
  'fx1.toggle': 'ControlLeft+KeyA',
  'fx2.toggle': 'ControlLeft+KeyS',
  'fx3.toggle': 'ControlLeft+KeyD',
  'fx1.next': 'ControlLeft+KeyZ',
  'fx2.next': 'ControlLeft+KeyX',
  'fx3.next': 'ControlLeft+KeyC',
  'mode.hotcue': 'ControlLeft+Digit4',
  'mode.beatjump': 'ControlLeft+KeyR',
  'mode.padfx': 'ControlLeft+KeyF',
  'mode.sampler': 'ControlLeft+KeyV',
  quantize: 'ControlLeft+Digit5',
  slip: 'ControlLeft+KeyT',
  vinyl: 'ControlLeft+KeyG',
  // Alt = kills & grid layer
  'kill.high': 'AltLeft+Digit1',
  'kill.mid': 'AltLeft+Digit2',
  'kill.low': 'AltLeft+Digit3',
  'filter.toggle': 'AltLeft+Digit4',
  'fader.toggle': 'AltLeft+Digit5',
  'grid.edit': 'AltLeft+KeyQ',
  'grid.tap': 'AltLeft+KeyW',
  'grid.earlier': 'AltLeft+KeyE',
  'grid.later': 'AltLeft+KeyR',
  'grid.downbeat': 'AltLeft+KeyT',
  'grid.beatLeft': 'AltLeft+KeyA',
  'grid.beatRight': 'AltLeft+KeyS',
  'grid.barLeft': 'AltLeft+KeyD',
  'grid.barRight': 'AltLeft+KeyF',
  'fx1.length': 'AltLeft+KeyZ',
  'fx2.length': 'AltLeft+KeyX',
  'fx3.length': 'AltLeft+KeyC',
  tempoRange: 'AltLeft+KeyV',
  loopAnchor: 'AltLeft+KeyG'
}

const GLOBAL_LAYOUT: Record<string, string[]> = {
  'xf.left': ['KeyB'],
  'xf.right': ['KeyN'],
  'xf.center': ['KeyH'],
  'master.up': ['Digit6'],
  'master.down': ['KeyY'],
  'hpLevel.up': ['ShiftLeft+Digit6', 'ShiftRight+Digit6'],
  'hpLevel.down': ['ShiftLeft+KeyY', 'ShiftRight+KeyY'],
  'hpMix.cue': ['ShiftLeft+KeyB', 'ShiftRight+KeyB'],
  'hpMix.master': ['ShiftLeft+KeyN', 'ShiftRight+KeyN'],
  'sampler.up': ['ControlLeft+Digit6', 'ControlRight+Digit6'],
  'sampler.down': ['ControlLeft+KeyY', 'ControlRight+KeyY'],
  record: ['F9'],
  'xf.curve': ['ControlLeft+KeyH', 'ControlRight+KeyH'],
  'app.search': ['Tab'],
  'app.keys': ['F1'],
  'app.settings': ['F2'],
  'app.up': ['ArrowUp'],
  'app.down': ['ArrowDown'],
  'app.load1': ['ArrowLeft'],
  'app.load2': ['ArrowRight']
}

export function defaultKeymap(): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const [action, combo] of Object.entries(DECK1_LAYOUT)) {
    map[`d0.${action}`] = [combo]
    map[`d1.${action}`] = [
      combo
        .split('+')
        .map((k) => RIGHT_OF[k] ?? k)
        .join('+')
    ]
  }
  for (const [action, combos] of Object.entries(GLOBAL_LAYOUT)) map[action] = combos
  return map
}

/** Human-readable key names for the overlay and settings. */
export function prettyCombo(combo: string): string {
  return combo
    .split('+')
    .map((k) =>
      k
        .replace(/^Key/, '')
        .replace(/^Digit/, '')
        .replace('ShiftLeft', 'L-Shift')
        .replace('ShiftRight', 'R-Shift')
        .replace('ControlLeft', 'L-Ctrl')
        .replace('ControlRight', 'R-Ctrl')
        .replace('AltLeft', 'L-Alt')
        .replace('AltRight', 'R-Alt')
        .replace('BracketLeft', '[')
        .replace('BracketRight', ']')
        .replace('Semicolon', ';')
        .replace('Quote', "'")
        .replace('Comma', ',')
        .replace('Period', '.')
        .replace('Slash', '/')
        .replace('Minus', '-')
        .replace('Equal', '=')
        .replace('Backquote', '`')
        .replace('Arrow', '')
    )
    .join(' + ')
}
