// Tooltips that show the keyboard shortcut for a control, e.g. "Play / pause  [S]".

import { useSettings } from '../state/settings'
import { currentKeymap } from '../input/bindings'
import { prettyCombo } from '../input/actions'

/** Returns a function that appends the current shortcut(s) of an action to a tooltip. */
export function useKeyHint(): (text: string, actionId: string | string[]) => string {
  useSettings((s) => s.settings.keymap) // re-render when shortcuts are remapped
  const map = currentKeymap()
  return (text, actionId) => {
    const ids = Array.isArray(actionId) ? actionId : [actionId]
    const combos = ids.flatMap((id) => map[id] ?? []).map(prettyCombo)
    return combos.length ? `${text}   [${combos.join(' / ')}]` : text
  }
}
