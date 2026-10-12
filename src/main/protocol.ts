// A private URL scheme so the renderer can fetch() track audio and artwork:
//   fsmedia://track/<id>            -> the audio file's bytes
//   fsmedia://track/<id>?transcode  -> the file converted to FLAC by ffmpeg (cached)
//   fsmedia://artwork/<id>          -> the cover thumbnail (JPEG)
// The renderer never sees raw file paths in URLs, and only library files can be served.

import { protocol, net, app } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { MEDIA_SCHEME } from '@shared/api'
import type { LibraryService } from './library/service'

export function registerMediaScheme(): void {
  // Must run before the app is ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

export function ffmpegPath(): string {
  const require = createRequire(import.meta.url)
  const p = require('ffmpeg-static') as string
  // In a packaged app the binary is unpacked next to the asar archive.
  return p.replace('app.asar', 'app.asar.unpacked')
}

export function handleMediaProtocol(library: LibraryService): void {
  const transcodeDir = path.join(app.getPath('userData'), 'transcode')
  const inflight = new Map<number, Promise<string>>()

  const transcode = (id: number, src: string): Promise<string> => {
    const out = path.join(transcodeDir, `${id}.flac`)
    const existing = inflight.get(id)
    if (existing) return existing
    const job = (async () => {
      try {
        const [a, b] = await Promise.all([fs.stat(out), fs.stat(src)])
        if (a.mtimeMs >= b.mtimeMs && a.size > 0) return out
      } catch {
        /* not cached yet */
      }
      await fs.mkdir(transcodeDir, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const p = spawn(ffmpegPath(), ['-y', '-v', 'error', '-i', src, '-vn', '-c:a', 'flac', out], {
          windowsHide: true
        })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`))))
      })
      return out
    })().finally(() => inflight.delete(id))
    inflight.set(id, job)
    return job
  }

  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url)
    const id = Number(url.pathname.replace(/^\//, ''))
    if (!Number.isInteger(id)) return new Response('bad id', { status: 400 })
    try {
      if (url.hostname === 'artwork') {
        return await net.fetch(pathToFileURL(library.artworkPath(id)).toString())
      }
      if (url.hostname === 'track') {
        const file = library.pathFor(id)
        if (!file) return new Response('track unavailable', { status: 404 })
        const target = url.searchParams.has('transcode') ? await transcode(id, file) : file
        return await net.fetch(pathToFileURL(target).toString())
      }
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
    return new Response('not found', { status: 404 })
  })
}
