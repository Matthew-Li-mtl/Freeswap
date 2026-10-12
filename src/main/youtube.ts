// YouTube import using yt-dlp (a command-line downloader, public domain licensed).
// We don't ship yt-dlp inside the installer: YouTube changes often and old yt-dlp
// versions stop working, so the app downloads the latest release on first use and
// asks it to self-update once per session.
//
// Note: downloading from YouTube may violate YouTube's Terms of Service. This feature
// is provided for personal use; the user is responsible for what they download.

import { app, net, nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DownloadJob, Track } from '@shared/types'
import { ffmpegPath } from './protocol'
import type { LibraryService } from './library/service'

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

interface YtInfo {
  id: string
  title: string
  artist?: string | null
  track?: string | null
  uploader?: string | null
  channel?: string | null
  duration?: number | null
  webpage_url?: string
  filepath: string
}

export class YouTubeImporter {
  private jobs: DownloadJob[] = []
  private updatedThisSession = false
  private running = false
  private pending: { job: DownloadJob; folderId: number | null }[] = []

  constructor(
    private library: LibraryService,
    private getDownloadFolder: () => string,
    private onJobs: (jobs: DownloadJob[]) => void,
    private onImported: (tracks: Track[], folderId: number | null) => void
  ) {}

  enqueue(url: string, folderId: number | null): void {
    const job: DownloadJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      url,
      status: 'queued',
      progress: 0,
      title: url
    }
    this.jobs = [...this.jobs.filter((j) => j.status !== 'done'), job].slice(-20)
    this.pending.push({ job, folderId })
    this.emit()
    void this.pump()
  }

  private emit(): void {
    this.onJobs(this.jobs.map((j) => ({ ...j })))
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length) {
        const { job, folderId } = this.pending.shift()!
        try {
          job.status = 'downloading'
          this.emit()
          const exe = await this.ensureBinary(job)
          await this.download(exe, job, folderId)
          job.status = 'done'
          job.progress = 1
        } catch (err) {
          job.status = 'error'
          job.error = err instanceof Error ? err.message : String(err)
        }
        this.emit()
      }
    } finally {
      this.running = false
    }
  }

  private async ensureBinary(job: DownloadJob): Promise<string> {
    const dir = path.join(app.getPath('userData'), 'bin')
    const exe = path.join(dir, 'yt-dlp.exe')
    let exists = true
    try {
      await fs.access(exe)
    } catch {
      exists = false
    }
    if (!exists) {
      job.title = 'Downloading yt-dlp (first use)...'
      this.emit()
      await fs.mkdir(dir, { recursive: true })
      const res = await net.fetch(YTDLP_URL)
      if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status})`)
      await fs.writeFile(exe, Buffer.from(await res.arrayBuffer()))
      this.updatedThisSession = true
    } else if (!this.updatedThisSession) {
      this.updatedThisSession = true
      job.title = 'Checking yt-dlp for updates...'
      this.emit()
      await run(exe, ['-U']).catch(() => undefined)
    }
    return exe
  }

  private async download(exe: string, job: DownloadJob, folderId: number | null): Promise<void> {
    const dir = this.getDownloadFolder()
    await fs.mkdir(dir, { recursive: true })
    const args = [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--windows-filenames',
      '--encoding',
      'utf-8',
      '--ffmpeg-location',
      path.dirname(ffmpegPath()),
      '-o',
      path.join(dir, '%(title).150B [%(id)s].%(ext)s'),
      '--newline',
      '--progress-template',
      'download:FSPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      '--print',
      'before_dl:FSNAME %(title)s',
      '--print',
      'after_move:FSJSON %(.{id,title,artist,track,uploader,channel,duration,webpage_url,filepath})j',
      '--no-simulate',
      job.url
    ]
    const imports: Promise<void>[] = []
    let failure = ''
    await run(exe, args, (line) => {
      if (line.startsWith('FSPROG ')) {
        const [done, total, est] = line.slice(7).split(' ').map(Number)
        const t = total || est
        if (t > 0) job.progress = Math.min(1, done / t)
        this.emit()
      } else if (line.startsWith('FSNAME ')) {
        job.title = line.slice(7)
        job.progress = 0
        this.emit()
      } else if (line.startsWith('FSJSON ')) {
        const info = JSON.parse(line.slice(7)) as YtInfo
        imports.push(this.importDownloaded(info, folderId, job))
      } else if (line.startsWith('ERROR')) {
        failure = line
      }
    }).catch((err) => {
      throw new Error(failure || (err as Error).message)
    })
    await Promise.all(imports)
    if (!imports.length) throw new Error(failure || 'Nothing was downloaded')
  }

  private async importDownloaded(info: YtInfo, folderId: number | null, job: DownloadJob): Promise<void> {
    job.status = 'importing'
    this.emit()
    const { artist, title } = guessArtistTitle(info)
    let artwork: Buffer | null = null
    try {
      const res = await net.fetch(`https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`)
      if (res.ok) {
        // hqdefault is 4:3 with black bars around a 16:9 frame; crop to a centred square.
        const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
        const { width, height } = img.getSize()
        const side = Math.min(width, Math.round((height * 3) / 4))
        artwork = img
          .crop({ x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), width: side, height: side })
          .toJPEG(90)
      }
    } catch {
      /* artwork is optional */
    }
    const track = await this.library.importFile(info.filepath, {
      title,
      artist,
      source: 'youtube',
      sourceUrl: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
      sourceId: info.id,
      artwork
    })
    this.onImported([track], folderId)
    job.status = 'downloading'
  }
}

const NOISE =
  /\s*[([](official\s*(music\s*)?(video|audio|visualizer|lyric video)|lyrics?|lyric video|audio|hd|hq|4k|visualizer|music video|official)[)\]]\s*/gi

/** YouTube titles are messy: "Artist - Title (Official Video) [HD]". Clean them up. */
export function guessArtistTitle(info: Pick<YtInfo, 'title' | 'artist' | 'track' | 'uploader' | 'channel'>): {
  artist: string
  title: string
} {
  if (info.artist && info.track) return { artist: info.artist, title: info.track }
  const clean = info.title
    .replace(NOISE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  const channel = (info.artist || info.channel || info.uploader || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim()
  return { artist: channel, title: clean }
}

function run(exe: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true })
    let buf = ''
    let errBuf = ''
    const feed = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        onLine?.(line)
      }
    }
    p.stdout.on('data', feed)
    p.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString('utf8')
      feed(d)
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (buf) onLine?.(buf)
      if (code === 0) resolve()
      else reject(new Error(errBuf.trim().split('\n').pop() || `yt-dlp exited with code ${code}`))
    })
  })
}
