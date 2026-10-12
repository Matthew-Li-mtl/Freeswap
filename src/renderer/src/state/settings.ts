import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { api } from '../platform'

interface SettingsStore {
  settings: Settings
  loaded: boolean
}

export const useSettings = create<SettingsStore>(() => ({
  settings: { ...DEFAULT_SETTINGS, downloadFolder: '', recordingFolder: '' },
  loaded: false
}))

export async function loadSettings(): Promise<Settings> {
  const settings = await api.settings.get()
  useSettings.setState({ settings, loaded: true })
  return settings
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  useSettings.setState((s) => ({ settings: { ...s.settings, ...patch } }))
  const settings = await api.settings.set(patch)
  useSettings.setState({ settings })
}

export function settings(): Settings {
  return useSettings.getState().settings
}
