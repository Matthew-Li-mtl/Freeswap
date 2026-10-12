// Tracks are remembered by (volume serial number, path relative to that volume's root)
// instead of by absolute path. On Windows a USB drive can come back as E: one day and
// F: the next; its serial number stays the same, so we can always find the file again.
//
// On Windows, Node's fs.stat().dev *is* the volume serial number, which makes this cheap.

import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface VolumeLocation {
  serial: number
  relPath: string
}

export async function locate(absPath: string): Promise<VolumeLocation> {
  const st = await fs.stat(absPath)
  const root = path.parse(absPath).root
  return { serial: st.dev, relPath: path.relative(root, absPath) }
}

/**
 * Keeps a live map of mounted volumes (serial -> root such as "E:\").
 * Polls because Windows has no simple drive-arrival event available to Node.
 */
export class VolumeWatcher extends EventEmitter {
  private roots = new Map<number, string>()
  private timer: NodeJS.Timeout | null = null
  private scanning = false

  async start(intervalMs = 3000): Promise<void> {
    await this.scan()
    this.timer = setInterval(() => void this.scan(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  rootFor(serial: number): string | undefined {
    return this.roots.get(serial)
  }

  /** Learn about a root we saw while importing (covers network shares too). */
  remember(serial: number, absPath: string): void {
    const root = path.parse(absPath).root
    if (!this.roots.has(serial)) this.roots.set(serial, root)
  }

  resolve(loc: VolumeLocation): string | null {
    const root = this.roots.get(loc.serial)
    return root ? path.join(root, loc.relPath) : null
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const next = new Map<number, string>()
      const letters = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('') : []
      await Promise.all(
        letters.map(async (l) => {
          const root = `${l}:\\`
          try {
            const st = await fs.stat(root)
            next.set(st.dev, root)
          } catch {
            /* not mounted */
          }
        })
      )
      if (process.platform !== 'win32') {
        // Non-Windows: absolute paths are stable enough; treat "/" as the only root.
        const st = await fs.stat('/')
        next.set(st.dev, '/')
      }
      // Keep remembered non-letter roots (e.g. \\server\share\) if still reachable.
      for (const [serial, root] of this.roots) {
        if (next.has(serial) || /^[A-Z]:\\$/i.test(root)) continue
        try {
          await fs.stat(root)
          next.set(serial, root)
        } catch {
          /* gone */
        }
      }
      const changed = next.size !== this.roots.size || [...next].some(([s, r]) => this.roots.get(s) !== r)
      this.roots = next
      if (changed) this.emit('change')
    } finally {
      this.scanning = false
    }
  }
}
