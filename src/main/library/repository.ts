// All SQL for the music library lives here. The rest of the main process talks to
// this class with plain objects and never writes SQL itself.

import type { AnalysisResult, Folder, HotCue, Track, TrackPatch, TrackSource } from '@shared/types'
import { ANALYSIS_VERSION } from '@shared/types'
import { transaction, type DB } from '../db/database'

interface TrackRow {
  id: number
  path: string
  volume_serial: number
  rel_path: string
  file_size: number
  title: string
  artist: string
  album: string
  genre: string
  year: number | null
  comment: string
  duration: number
  bpm: number | null
  music_key: number | null
  grid_anchor: number | null
  analysis_version: number
  gain_db: number | null
  cue_point: number | null
  hot_cues: string
  source: string
  source_url: string | null
  has_artwork: number
  tag_bpm: number | null
  tag_key: number | null
  added_at: number
}

export interface NewTrack {
  path: string
  serial: number
  relPath: string
  fileSize: number
  fileMtime: number
  title: string
  artist: string
  album: string
  genre: string
  year: number | null
  comment: string
  duration: number
  source: TrackSource
  sourceUrl: string | null
  sourceId: string | null
  tagBpm: number | null
  tagKey: number | null
}

export class LibraryRepository {
  /** Availability is runtime-only state (is the file reachable right now?). */
  private available = new Map<number, boolean>()

  constructor(private db: DB) {}

  // ---------- tracks ----------

  private toTrack(r: TrackRow): Track {
    let hotCues: HotCue[] = []
    try {
      hotCues = JSON.parse(r.hot_cues)
    } catch {
      /* corrupted json -> no cues */
    }
    return {
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      genre: r.genre,
      year: r.year,
      comment: r.comment,
      duration: r.duration,
      bpm: r.bpm,
      key: r.music_key,
      grid: r.bpm != null && r.grid_anchor != null ? { bpm: r.bpm, anchor: r.grid_anchor } : null,
      analyzed: r.analysis_version >= ANALYSIS_VERSION,
      gainDb: r.gain_db,
      cuePoint: r.cue_point,
      hotCues,
      source: r.source as TrackSource,
      sourceUrl: r.source_url,
      path: r.path,
      available: this.available.get(r.id) ?? true,
      fileSize: r.file_size,
      addedAt: r.added_at,
      hasArtwork: r.has_artwork === 1,
      tagBpm: r.tag_bpm,
      tagKey: r.tag_key
    }
  }

  allTracks(): Track[] {
    const rows = this.db.prepare('SELECT * FROM tracks ORDER BY id').all() as unknown as TrackRow[]
    return rows.map((r) => this.toTrack(r))
  }

  getTrack(id: number): Track | null {
    const r = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined
    return r ? this.toTrack(r) : null
  }

  /** Location info used to find the file again after a drive letter changes. */
  allLocations(): { id: number; serial: number; relPath: string; path: string }[] {
    return (
      this.db.prepare('SELECT id, volume_serial, rel_path, path FROM tracks').all() as {
        id: number
        volume_serial: number
        rel_path: string
        path: string
      }[]
    ).map((r) => ({ id: r.id, serial: r.volume_serial, relPath: r.rel_path, path: r.path }))
  }

  findByLocation(serial: number, relPath: string): Track | null {
    const r = this.db
      .prepare('SELECT * FROM tracks WHERE volume_serial = ? AND rel_path = ? COLLATE NOCASE')
      .get(serial, relPath) as TrackRow | undefined
    return r ? this.toTrack(r) : null
  }

  findBySourceId(source: TrackSource, sourceId: string): Track | null {
    const r = this.db.prepare('SELECT * FROM tracks WHERE source = ? AND source_id = ?').get(source, sourceId) as
      TrackRow | undefined
    return r ? this.toTrack(r) : null
  }

  insertTrack(t: NewTrack): Track {
    const info = this.db
      .prepare(
        `INSERT INTO tracks (path, volume_serial, rel_path, file_size, file_mtime, title, artist,
           album, genre, year, comment, duration, source, source_url, source_id, added_at, tag_bpm, tag_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.path,
        t.serial,
        t.relPath,
        t.fileSize,
        t.fileMtime,
        t.title,
        t.artist,
        t.album,
        t.genre,
        t.year,
        t.comment,
        t.duration,
        t.source,
        t.sourceUrl,
        t.sourceId,
        Date.now(),
        t.tagBpm,
        t.tagKey
      )
    const id = Number(info.lastInsertRowid)
    this.available.set(id, true)
    return this.getTrack(id)!
  }

  updateTrack(id: number, p: TrackPatch): Track {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    const set = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`)
      vals.push(v)
    }
    if (p.title !== undefined) set('title', p.title)
    if (p.artist !== undefined) set('artist', p.artist)
    if (p.album !== undefined) set('album', p.album)
    if (p.genre !== undefined) set('genre', p.genre)
    if (p.comment !== undefined) set('comment', p.comment)
    if (p.key !== undefined) set('music_key', p.key)
    if (p.grid !== undefined) {
      set('bpm', p.grid ? p.grid.bpm : null)
      set('grid_anchor', p.grid ? p.grid.anchor : null)
    } else if (p.bpm !== undefined) {
      set('bpm', p.bpm)
    }
    if (p.cuePoint !== undefined) set('cue_point', p.cuePoint)
    if (p.hotCues !== undefined) set('hot_cues', JSON.stringify(p.hotCues))
    if (sets.length) {
      this.db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.getTrack(id)!
  }

  setArtwork(id: number, has: boolean): void {
    this.db.prepare('UPDATE tracks SET has_artwork = ? WHERE id = ?').run(has ? 1 : 0, id)
  }

  setPath(id: number, path: string, serial?: number, relPath?: string): void {
    if (serial != null && relPath != null) {
      this.db
        .prepare('UPDATE tracks SET path = ?, volume_serial = ?, rel_path = ? WHERE id = ?')
        .run(path, serial, relPath, id)
    } else {
      this.db.prepare('UPDATE tracks SET path = ? WHERE id = ?').run(path, id)
    }
  }

  setAvailable(id: number, available: boolean): boolean {
    const changed = this.available.get(id) !== available
    this.available.set(id, available)
    return changed
  }

  saveAnalysis(id: number, a: AnalysisResult): Track {
    transaction(this.db, () => {
      // Keep user edits: only overwrite bpm/key/grid if the user never changed them
      // (i.e. they still equal the previous analysis, or are empty).
      const cur = this.db
        .prepare(
          'SELECT bpm, music_key, grid_anchor, analyzed_bpm, analyzed_key, analyzed_anchor FROM tracks WHERE id = ?'
        )
        .get(id) as {
        bpm: number | null
        music_key: number | null
        grid_anchor: number | null
        analyzed_bpm: number | null
        analyzed_key: number | null
        analyzed_anchor: number | null
      }
      const gridUntouched = cur.bpm == null || (cur.bpm === cur.analyzed_bpm && cur.grid_anchor === cur.analyzed_anchor)
      const keyUntouched = cur.music_key == null || cur.music_key === cur.analyzed_key
      this.db
        .prepare(
          `UPDATE tracks SET duration = ?, gain_db = ?, analysis_version = ?,
             analyzed_bpm = ?, analyzed_key = ?, analyzed_anchor = ?,
             bpm = ?, grid_anchor = ?, music_key = ?
           WHERE id = ?`
        )
        .run(
          a.duration,
          a.gainDb,
          ANALYSIS_VERSION,
          a.grid?.bpm ?? a.bpm,
          a.key,
          a.grid?.anchor ?? null,
          gridUntouched ? (a.grid?.bpm ?? a.bpm) : cur.bpm,
          gridUntouched ? (a.grid?.anchor ?? null) : cur.grid_anchor,
          keyUntouched ? a.key : cur.music_key,
          id
        )
      this.db.prepare('INSERT OR REPLACE INTO waveforms (track_id, data) VALUES (?, ?)').run(id, a.waveform)
    })
    return this.getTrack(id)!
  }

  /** Returns the analysed (pre-edit) grid and key so the UI can offer "reset". */
  analyzedValues(id: number): { bpm: number | null; anchor: number | null; key: number | null } {
    const r = this.db
      .prepare('SELECT analyzed_bpm, analyzed_anchor, analyzed_key FROM tracks WHERE id = ?')
      .get(id) as { analyzed_bpm: number | null; analyzed_anchor: number | null; analyzed_key: number | null }
    return { bpm: r.analyzed_bpm, anchor: r.analyzed_anchor, key: r.analyzed_key }
  }

  getWaveform(id: number): Uint8Array | null {
    const r = this.db.prepare('SELECT data FROM waveforms WHERE track_id = ?').get(id) as
      { data: Uint8Array } | undefined
    return r ? r.data : null
  }

  removeTracks(ids: number[]): void {
    transaction(this.db, () => {
      const stmt = this.db.prepare('DELETE FROM tracks WHERE id = ?')
      for (const id of ids) {
        stmt.run(id)
        this.available.delete(id)
      }
    })
  }

  // ---------- folders ----------

  allFolders(): Folder[] {
    return (
      this.db.prepare('SELECT id, parent_id, name, position FROM folders ORDER BY parent_id, position').all() as {
        id: number
        parent_id: number | null
        name: string
        position: number
      }[]
    ).map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, position: r.position }))
  }

  membership(): Record<number, number[]> {
    const rows = this.db
      .prepare('SELECT folder_id, track_id FROM folder_tracks ORDER BY folder_id, position')
      .all() as { folder_id: number; track_id: number }[]
    const out: Record<number, number[]> = {}
    for (const r of rows) (out[r.folder_id] ??= []).push(r.track_id)
    return out
  }

  folderTrackIds(folderId: number): number[] {
    return (
      this.db.prepare('SELECT track_id FROM folder_tracks WHERE folder_id = ? ORDER BY position').all(folderId) as {
        track_id: number
      }[]
    ).map((r) => r.track_id)
  }

  createFolder(parentId: number | null, name: string): Folder {
    const pos = this.db
      .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM folders WHERE parent_id IS ?')
      .get(parentId) as { p: number }
    const info = this.db
      .prepare('INSERT INTO folders (parent_id, name, position) VALUES (?, ?, ?)')
      .run(parentId, name, pos.p)
    return { id: Number(info.lastInsertRowid), parentId, name, position: pos.p }
  }

  /** A direct child folder with this name (case-insensitive), if one exists. */
  findFolder(parentId: number | null, name: string): Folder | null {
    const r = this.db
      .prepare('SELECT id, parent_id, name, position FROM folders WHERE parent_id IS ? AND name = ? COLLATE NOCASE')
      .get(parentId, name) as { id: number; parent_id: number | null; name: string; position: number } | undefined
    return r ? { id: r.id, parentId: r.parent_id, name: r.name, position: r.position } : null
  }

  /** Find-or-create a child folder by name. */
  ensureFolder(parentId: number | null, name: string): Folder {
    return this.findFolder(parentId, name) ?? this.createFolder(parentId, name)
  }

  renameFolder(id: number, name: string): void {
    this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
  }

  removeFolder(id: number): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }

  /** Move a folder under a new parent at `position`, renumbering its new siblings. */
  moveFolder(id: number, parentId: number | null, position: number): void {
    // Refuse to move a folder into itself or one of its descendants.
    let p = parentId
    while (p != null) {
      if (p === id) throw new Error('Cannot move a folder into itself')
      const row = this.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(p) as
        { parent_id: number | null } | undefined
      p = row ? row.parent_id : null
    }
    transaction(this.db, () => {
      const siblings = (
        this.db
          .prepare('SELECT id FROM folders WHERE parent_id IS ? AND id != ? ORDER BY position')
          .all(parentId, id) as { id: number }[]
      ).map((r) => r.id)
      siblings.splice(Math.max(0, Math.min(position, siblings.length)), 0, id)
      const stmt = this.db.prepare('UPDATE folders SET parent_id = ?, position = ? WHERE id = ?')
      siblings.forEach((fid, i) => stmt.run(parentId, i, fid))
    })
  }

  addToFolder(folderId: number, trackIds: number[]): number[] {
    transaction(this.db, () => {
      const max = this.db
        .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM folder_tracks WHERE folder_id = ?')
        .get(folderId) as { p: number }
      let pos = max.p
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO folder_tracks (folder_id, track_id, position) VALUES (?, ?, ?)'
      )
      for (const id of trackIds) stmt.run(folderId, id, pos++)
    })
    return this.folderTrackIds(folderId)
  }

  removeFromFolder(folderId: number, trackIds: number[]): number[] {
    transaction(this.db, () => {
      const stmt = this.db.prepare('DELETE FROM folder_tracks WHERE folder_id = ? AND track_id = ?')
      for (const id of trackIds) stmt.run(folderId, id)
    })
    return this.folderTrackIds(folderId)
  }

  reorderFolder(folderId: number, trackIds: number[]): number[] {
    transaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE folder_tracks SET position = ? WHERE folder_id = ? AND track_id = ?')
      trackIds.forEach((id, i) => stmt.run(i, folderId, id))
    })
    return this.folderTrackIds(folderId)
  }
}
