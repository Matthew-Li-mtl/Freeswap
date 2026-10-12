// SQLite access using Node's built-in `node:sqlite` module (no native add-ons to compile).
// Schema changes are applied as numbered migrations tracked with PRAGMA user_version.

import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE tracks (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL,
    volume_serial   INTEGER NOT NULL,
    rel_path        TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    file_mtime      REAL NOT NULL DEFAULT 0,
    title           TEXT NOT NULL DEFAULT '',
    artist          TEXT NOT NULL DEFAULT '',
    album           TEXT NOT NULL DEFAULT '',
    genre           TEXT NOT NULL DEFAULT '',
    year            INTEGER,
    comment         TEXT NOT NULL DEFAULT '',
    duration        REAL NOT NULL DEFAULT 0,
    bpm             REAL,
    music_key       INTEGER,
    grid_anchor     REAL,
    analyzed_bpm    REAL,
    analyzed_key    INTEGER,
    analyzed_anchor REAL,
    analysis_version INTEGER NOT NULL DEFAULT 0,
    gain_db         REAL,
    cue_point       REAL,
    hot_cues        TEXT NOT NULL DEFAULT '[]',
    source          TEXT NOT NULL DEFAULT 'local',
    source_url      TEXT,
    source_id       TEXT,
    has_artwork     INTEGER NOT NULL DEFAULT 0,
    added_at        INTEGER NOT NULL,
    UNIQUE (volume_serial, rel_path)
  );
  CREATE INDEX idx_tracks_source_id ON tracks(source_id);

  CREATE TABLE waveforms (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    data     BLOB NOT NULL
  );

  CREATE TABLE folders (
    id        INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE folder_tracks (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    PRIMARY KEY (folder_id, track_id)
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
]

export type DB = DatabaseSync

export function openDatabase(file: string): DB {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version])
      version++
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

/** Run `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
