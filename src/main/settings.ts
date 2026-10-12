// User settings, stored as JSON values in the `settings` table.

import { app } from 'electron'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { DB } from './db/database'

export class SettingsStore {
  private cache: Settings

  constructor(private db: DB) {
    const music = app.getPath('music')
    const defaults: Settings = {
      ...DEFAULT_SETTINGS,
      downloadFolder: path.join(music, 'Freeswap', 'Downloads'),
      recordingFolder: path.join(music, 'Freeswap', 'Recordings')
    }
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const stored: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value)
      } catch {
        /* ignore corrupt values */
      }
    }
    this.cache = { ...defaults, ...(stored as Partial<Settings>) }
  }

  get(): Settings {
    return this.cache
  }

  set(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      stmt.run(k, JSON.stringify(v))
    }
    this.cache = { ...this.cache, ...patch }
    return this.cache
  }
}
