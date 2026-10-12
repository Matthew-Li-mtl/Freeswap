import { create } from 'zustand'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface UiStore {
  toasts: Toast[]
  showKeys: boolean
  showSettings: boolean
  showImport: boolean
  /** Bumped when sampler slots change so pads re-read their names. */
  samplerVersion: number
}

export const useUi = create<UiStore>(() => ({
  toasts: [],
  showKeys: false,
  showSettings: false,
  showImport: false,
  samplerVersion: 0
}))

let toastId = 0

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500)
}
