// Keyboard engine: turns physical key presses into DJ actions.
//
// We use KeyboardEvent.code (the physical key, e.g. "KeyQ") rather than .key (the
// character, which changes with Shift and keyboard language), and we tell left and
// right modifiers apart (ShiftLeft vs ShiftRight) so each hand gets its own layers.
//
// Knobs and faders move *continuously* while a key is held: a requestAnimationFrame
// loop applies `rate × elapsed time` every frame, so movement speed doesn't depend on
// the operating system's key-repeat settings.

import type { ActionDef } from './actions'

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'])

interface Binding {
  mod: string | null
  action: ActionDef
}

export class KeyboardController {
  private byKey = new Map<string, Binding[]>()
  private heldMods = new Set<string>()
  private active = new Map<string, ActionDef>() // key code -> action being held
  private raf = 0
  private lastFrame = 0
  enabled = true
  /** When set, the next key combo is captured instead of triggering an action. */
  capture: ((combo: string) => void) | null = null

  constructor() {
    window.addEventListener('keydown', this.onDown, true)
    window.addEventListener('keyup', this.onUp, true)
    window.addEventListener('blur', this.releaseAll)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown, true)
    window.removeEventListener('keyup', this.onUp, true)
    window.removeEventListener('blur', this.releaseAll)
    cancelAnimationFrame(this.raf)
  }

  setBindings(actions: ActionDef[], keymap: Record<string, string[]>): void {
    this.releaseAll()
    this.byKey.clear()
    const byId = new Map(actions.map((a) => [a.id, a]))
    for (const [id, combos] of Object.entries(keymap)) {
      const action = byId.get(id)
      if (!action) continue
      for (const combo of combos) {
        const parts = combo.split('+')
        const key = parts[parts.length - 1]
        const mod = parts.length > 1 ? parts[0] : null
        const list = this.byKey.get(key) ?? []
        list.push({ mod, action })
        this.byKey.set(key, list)
      }
    }
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null
    if (!t) return false
    const tag = t.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
  }

  private onDown = (e: KeyboardEvent): void => {
    if (MODIFIERS.has(e.code)) {
      this.heldMods.add(e.code)
      if (e.code.startsWith('Alt')) e.preventDefault() // keep Alt from focusing anything
      if (!this.capture) return
    }
    if (this.capture) {
      if (MODIFIERS.has(e.code) || e.code === 'Escape') {
        if (e.code === 'Escape') this.capture('')
        return
      }
      e.preventDefault()
      const mod = [...this.heldMods][0]
      this.capture(mod ? `${mod}+${e.code}` : e.code)
      return
    }
    if (!this.enabled || this.isTyping(e)) return
    const bindings = this.byKey.get(e.code)
    if (!bindings) return
    // Prefer a binding whose modifier is held; otherwise the plain one. That way the
    // left hand holding Shift doesn't change what the right hand's plain keys do.
    const b = bindings.find((x) => x.mod && this.heldMods.has(x.mod)) ?? bindings.find((x) => !x.mod)
    if (!b) return
    e.preventDefault()
    if (e.repeat || this.active.has(e.code)) return
    this.active.set(e.code, b.action)
    if (b.action.down) b.action.down()
    if (b.action.change) this.startLoop()
  }

  private onUp = (e: KeyboardEvent): void => {
    if (MODIFIERS.has(e.code)) this.heldMods.delete(e.code)
    const action = this.active.get(e.code)
    if (!action) return
    this.active.delete(e.code)
    action.up?.()
  }

  private releaseAll = (): void => {
    for (const a of this.active.values()) a.up?.()
    this.active.clear()
    this.heldMods.clear()
  }

  private startLoop(): void {
    if (this.raf) return
    this.lastFrame = performance.now()
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000)
      this.lastFrame = now
      let any = false
      for (const a of this.active.values()) {
        if (a.change && a.rate) {
          a.change(a.rate * dt)
          any = true
        }
      }
      this.raf = any ? requestAnimationFrame(frame) : 0
    }
    this.raf = requestAnimationFrame(frame)
  }
}
