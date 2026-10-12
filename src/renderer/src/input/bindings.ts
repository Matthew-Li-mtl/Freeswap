// Owns the keyboard controller and the active key map (user's custom map or defaults).

import { buildActions, defaultKeymap, type ActionDef } from './actions'
import { KeyboardController } from './keyboard'
import { settings, updateSettings } from '../state/settings'

let controller: KeyboardController | null = null
let actions: ActionDef[] = []

export function initKeyboard(app: Record<string, () => void>): void {
  controller?.dispose()
  controller = new KeyboardController()
  actions = buildActions(app)
  applyKeymap()
}

export function currentKeymap(): Record<string, string[]> {
  return settings().keymap ?? defaultKeymap()
}

export function applyKeymap(): void {
  controller?.setBindings(actions, currentKeymap())
}

export function allActions(): ActionDef[] {
  return actions
}

export async function setBindings(actionId: string, combos: string[]): Promise<void> {
  const map = { ...currentKeymap() }
  // A key combo can only do one thing: take it away from any other action first.
  for (const [id, list] of Object.entries(map)) {
    if (id !== actionId) map[id] = list.filter((c) => !combos.includes(c))
  }
  map[actionId] = combos
  await updateSettings({ keymap: map })
  applyKeymap()
}

export async function resetKeymap(): Promise<void> {
  await updateSettings({ keymap: null })
  applyKeymap()
}

/** Capture the next key combo the user presses (Escape cancels → ''). */
export function captureCombo(): Promise<string> {
  return new Promise((resolve) => {
    if (!controller) return resolve('')
    controller.capture = (combo) => {
      controller!.capture = null
      resolve(combo)
    }
  })
}

export function setKeyboardEnabled(on: boolean): void {
  if (controller) controller.enabled = on
}
