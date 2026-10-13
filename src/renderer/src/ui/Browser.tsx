// The library browser: folder tree on the left, search + import tools + track list on the right.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Folder, Track } from '@shared/types'
import { formatKey } from '@shared/musicKey'
import { useLibrary, visibleTracks, type SortKey } from '../state/library'
import { useSettings } from '../state/settings'
import { useDecks } from '../state/decks'
import { useUi } from '../state/ui'
import * as L from '../control/library'
import { loadTrack } from '../control/deck'
import { api } from '../platform'
import { Btn } from './controls'
import { openMenu, type MenuItem } from './ContextMenu'
import { FOLDER_MIME, TRACKS_MIME, hasFiles, importDroppedFiles, readDraggedTracks, setDragTracks } from './dnd'
import { formatTime } from './frameLoop'

const COLORS = ['#2fd6b5', '#ff7a59']

export function Browser() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: 0, height: '100%' }}>
      <FolderTree />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <Toolbar />
        <TrackTable />
      </div>
    </div>
  )
}

// ================================================================ folder tree

function FolderTree() {
  const folders = useLibrary((s) => s.folders)
  const view = useLibrary((s) => s.view)
  const total = useLibrary((s) => Object.keys(s.tracks).length)
  const [editing, setEditing] = useState<number | null>(null)
  const roots = folders.filter((f) => f.parentId == null).sort((a, b) => a.position - b.position)

  const startNew = async (parentId: number | null) => {
    const id = await L.createFolder(parentId)
    setEditing(id)
  }

  return (
    <div
      style={{ background: 'var(--panel)', borderRight: '1px solid var(--line)', overflow: 'auto', padding: '6px 4px' }}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(e.clientX, e.clientY, [{ label: 'New folder', onClick: () => void startNew(null) }])
      }}
    >
      <TreeRow
        label={`Collection`}
        count={total}
        icon="♫"
        active={view === 'collection'}
        depth={0}
        onClick={() => L.setView('collection')}
        onDropFiles={(e) => void importDroppedFiles(e, null)}
        onDropFolder={(id) => void L.moveFolder(id, null, roots.length)}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 6px 4px' }}>
        <span className="label">Folders</span>
        <Btn
          className="ghost"
          style={{ minHeight: 18, padding: '0 6px' }}
          title="New folder"
          onPress={() => void startNew(null)}
        >
          +
        </Btn>
      </div>
      {roots.map((f) => (
        <FolderNode key={f.id} folder={f} depth={0} editing={editing} setEditing={setEditing} onNew={startNew} />
      ))}
      {!roots.length && (
        <div style={{ color: 'var(--text-faint)', padding: '4px 10px', lineHeight: 1.5 }}>
          Create folders with +, then drag tracks into them.
        </div>
      )}
    </div>
  )
}

function FolderNode({
  folder,
  depth,
  editing,
  setEditing,
  onNew
}: {
  folder: Folder
  depth: number
  editing: number | null
  setEditing: (id: number | null) => void
  onNew: (parentId: number | null) => Promise<void>
}) {
  const children = useLibrary(
    useShallow((s) => s.folders.filter((f) => f.parentId === folder.id).sort((a, b) => a.position - b.position))
  )
  const expanded = useLibrary((s) => !!s.expanded[folder.id])
  const active = useLibrary((s) => s.view === folder.id)
  const count = useLibrary((s) => (s.membership[folder.id] ?? []).length)
  const toggle = () =>
    useLibrary.setState((s) => ({ expanded: { ...s.expanded, [folder.id]: !s.expanded[folder.id] } }))

  const menu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMenu(e.clientX, e.clientY, [
      { label: 'New sub-folder', onClick: () => void onNew(folder.id) },
      { label: 'Rename', onClick: () => setEditing(folder.id) },
      { separator: true },
      {
        label: 'Delete folder',
        onClick: () => {
          if (confirm(`Delete folder "${folder.name}" and its sub-folders?\n(The tracks stay in your collection.)`))
            void L.deleteFolder(folder.id)
        }
      }
    ])
  }

  return (
    <>
      <TreeRow
        label={folder.name}
        count={count}
        icon={children.length ? (expanded ? '▾' : '▸') : '•'}
        onIcon={children.length ? toggle : undefined}
        active={active}
        depth={depth + 1}
        editing={editing === folder.id}
        onRename={(name) => {
          setEditing(null)
          if (name != null) void L.renameFolder(folder.id, name)
        }}
        onClick={() => L.setView(folder.id)}
        onDoubleClick={() => setEditing(folder.id)}
        onContextMenu={menu}
        draggableFolder={folder.id}
        onDropTracks={(ids, e) => {
          const from = useLibrary.getState().view
          // Drag from another folder = move (hold Ctrl to copy). From the collection = add.
          if (typeof from === 'number' && !e.ctrlKey) void L.moveTracks(from, folder.id, ids)
          else void L.addToFolder(folder.id, ids)
        }}
        onDropFiles={(e) => void importDroppedFiles(e, folder.id)}
        onDropFolder={(id) => void L.moveFolder(id, folder.id, children.length)}
        onAdd={() => void onNew(folder.id)}
      />
      {expanded &&
        children.map((c) => (
          <FolderNode key={c.id} folder={c} depth={depth + 1} editing={editing} setEditing={setEditing} onNew={onNew} />
        ))}
    </>
  )
}

function TreeRow(props: {
  label: string
  count: number
  icon: string
  onIcon?: () => void
  active: boolean
  depth: number
  editing?: boolean
  onRename?: (name: string | null) => void
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  draggableFolder?: number
  onDropTracks?: (ids: number[], e: React.DragEvent) => void
  onDropFiles?: (e: React.DragEvent) => void
  onDropFolder?: (id: number) => void
  onAdd?: () => void
}) {
  const [over, setOver] = useState(false)
  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 6px',
    paddingLeft: 6 + props.depth * 12,
    borderRadius: 4,
    cursor: 'pointer',
    background: over ? 'rgba(143,123,255,0.25)' : props.active ? 'var(--panel-3)' : undefined,
    color: props.active ? 'var(--text)' : 'var(--text-dim)',
    outline: over ? '1px solid var(--accent)' : undefined
  }
  return (
    <div
      className="tree-row"
      style={style}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      draggable={props.draggableFolder != null && !props.editing}
      onDragStart={(e) => {
        if (props.draggableFolder != null) e.dataTransfer.setData(FOLDER_MIME, String(props.draggableFolder))
      }}
      onDragOver={(e) => {
        const t = e.dataTransfer.types
        if (t.includes(TRACKS_MIME) || t.includes(FOLDER_MIME) || hasFiles(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = t.includes(TRACKS_MIME) && e.ctrlKey ? 'copy' : 'move'
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const folderId = e.dataTransfer.getData(FOLDER_MIME)
        if (folderId) {
          if (Number(folderId) !== props.draggableFolder) props.onDropFolder?.(Number(folderId))
          return
        }
        const ids = readDraggedTracks(e)
        if (ids.length) props.onDropTracks?.(ids, e)
        else if (hasFiles(e)) props.onDropFiles?.(e)
      }}
    >
      <span
        style={{ width: 12, textAlign: 'center', color: 'var(--text-faint)' }}
        onClick={(e) => {
          if (props.onIcon) {
            e.stopPropagation()
            props.onIcon()
          }
        }}
      >
        {props.icon}
      </span>
      {props.editing ? (
        <input
          autoFocus
          defaultValue={props.label}
          style={{ flex: 1, minWidth: 0, padding: '1px 4px' }}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => props.onRename?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') props.onRename?.(null)
          }}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.label}
        </span>
      )}
      {props.onAdd && (
        <span
          className="row-add"
          title="New sub-folder inside this one"
          onClick={(e) => {
            e.stopPropagation()
            props.onAdd?.()
          }}
        >
          +
        </span>
      )}
      <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{props.count}</span>
    </div>
  )
}

// ================================================================ toolbar

export const searchInputRef: { current: HTMLInputElement | null } = { current: null }

function Toolbar() {
  const search = useLibrary((s) => s.search)
  const importing = useLibrary((s) => s.importing)
  const queue = useLibrary((s) => s.analysisQueue)
  const downloads = useLibrary((s) => s.downloads)
  const [yt, setYt] = useState('')
  const active = downloads.filter((j) => j.status !== 'done' && j.status !== 'error')
  const failed = downloads.filter((j) => j.status === 'error').slice(-1)[0]

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--panel)',
        flexWrap: 'wrap'
      }}
    >
      <input
        ref={(el) => {
          searchInputRef.current = el
        }}
        placeholder="Search title, artist, key (8A, Am), bpm:120-128…   [Tab]"
        value={search}
        style={{ width: 300 }}
        onChange={(e) => useLibrary.setState({ search: e.target.value, selection: [] })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (search) useLibrary.setState({ search: '' })
            else (e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Enter' || e.key === 'ArrowDown') (e.target as HTMLInputElement).blur()
        }}
      />
      <Btn onPress={() => void L.pickAndImport('files')} title="Add music files to the library">
        + FILES
      </Btn>
      <Btn onPress={() => void L.pickAndImport('folder')} title="Add a whole folder (and sub-folders)">
        + FOLDER
      </Btn>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 6 }}>
        <input
          placeholder="Paste a YouTube link…"
          value={yt}
          style={{ width: 220 }}
          onChange={(e) => setYt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && yt.trim()) {
              void L.downloadYouTube(yt)
              setYt('')
            }
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
        <Btn
          onPress={() => {
            if (yt.trim()) {
              void L.downloadYouTube(yt)
              setYt('')
            }
          }}
          title="Download the audio and add it to the library (personal use)"
        >
          + YOUTUBE
        </Btn>
        <Btn disabled title="Spotify import is coming in a later version">
          + SPOTIFY (soon)
        </Btn>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, color: 'var(--text-dim)', fontSize: 11 }}>
        {importing && (
          <span>
            Importing {importing.done}/{importing.total}…
          </span>
        )}
        {active.map((j) => (
          <span
            key={j.id}
            title={j.url}
            style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            ⬇ {j.title} {j.status === 'downloading' ? `${Math.round(j.progress * 100)}%` : j.status}
          </span>
        ))}
        {failed && (
          <span
            style={{
              color: 'var(--danger)',
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title={failed.error}
          >
            ⚠ {failed.error}
          </span>
        )}
        {queue > 0 && <span style={{ color: 'var(--warn)' }}>Analysing {queue}…</span>}
      </div>
    </div>
  )
}

// ================================================================ track table

interface Column {
  key: SortKey
  label: string
  width: number | string
  align?: 'right' | 'center'
  render: (t: Track, i: number) => React.ReactNode
}

const ROW_H = 26

function TrackTable() {
  const state = useLibrary()
  const notation = useSettings((s) => s.settings.keyNotation)
  const loaded = useDecks(useShallow((s) => s.decks.map((d) => d.trackId)))
  const tracks = useMemo(
    () => visibleTracks(state),
    [state.tracks, state.membership, state.view, state.search, state.sort]
  )
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const [dropBefore, setDropBefore] = useState<number | null>(null)
  const selection = new Set(state.selection)
  const inFolder = state.view !== 'collection'

  useEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the selected row visible when it changes from the keyboard.
  useEffect(() => {
    const el = scroller.current
    if (!el || state.anchor == null) return
    const idx = tracks.findIndex((t) => t.id === state.anchor)
    if (idx < 0) return
    const top = idx * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = top - el.clientHeight + ROW_H * 2
  }, [state.anchor])

  const columns: Column[] = [
    ...(inFolder
      ? [
          {
            key: 'order' as SortKey,
            label: '#',
            width: 34,
            align: 'right' as const,
            render: (_t: Track, i: number) => i + 1
          }
        ]
      : []),
    {
      key: 'title',
      label: 'Title',
      width: '2.2fr',
      render: (t) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {loaded.map((id, d) =>
            id === t.id ? (
              <span key={d} style={{ width: 6, height: 6, borderRadius: 3, background: COLORS[d], flexShrink: 0 }} />
            ) : null
          )}
          {t.source === 'youtube' && (
            <span title="Downloaded from YouTube" style={{ color: '#ff5b5b', fontSize: 9 }}>
              ▶
            </span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
        </span>
      )
    },
    { key: 'artist', label: 'Artist', width: '1.5fr', render: (t) => t.artist },
    {
      key: 'bpm',
      label: 'BPM',
      width: 60,
      align: 'right',
      render: (t) => (t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 2 : 0) : t.analyzed ? '' : '…')
    },
    { key: 'key', label: 'Key', width: 46, align: 'center', render: (t) => formatKey(t.key, notation) },
    {
      key: 'duration',
      label: 'Time',
      width: 52,
      align: 'right',
      render: (t) => (t.duration ? formatTime(t.duration, false) : '')
    },
    { key: 'album', label: 'Album', width: '1fr', render: (t) => t.album },
    { key: 'genre', label: 'Genre', width: 90, render: (t) => t.genre },
    { key: 'addedAt', label: 'Added', width: 82, render: (t) => new Date(t.addedAt).toLocaleDateString() }
  ]
  const template = columns.map((c) => (typeof c.width === 'number' ? `${c.width}px` : c.width)).join(' ')

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
  const last = Math.min(tracks.length, Math.ceil((scrollTop + height) / ROW_H) + 5)

  const select = (t: Track, e: React.MouseEvent) => {
    if (e.shiftKey && state.anchor != null) {
      const a = tracks.findIndex((x) => x.id === state.anchor)
      const b = tracks.findIndex((x) => x.id === t.id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      useLibrary.setState({ selection: tracks.slice(lo, hi + 1).map((x) => x.id) })
    } else if (e.ctrlKey) {
      const sel = selection.has(t.id) ? state.selection.filter((id) => id !== t.id) : [...state.selection, t.id]
      useLibrary.setState({ selection: sel, anchor: t.id })
    } else if (!selection.has(t.id)) {
      useLibrary.setState({ selection: [t.id], anchor: t.id })
    }
    // Clicking an already-selected row keeps the multi-selection so it can be dragged;
    // a plain click (without dragging) narrows it down in onClick below.
  }

  const rowMenu = (t: Track, e: React.MouseEvent) => {
    e.preventDefault()
    if (!selection.has(t.id)) useLibrary.setState({ selection: [t.id], anchor: t.id })
    const ids = selection.has(t.id) ? state.selection : [t.id]
    const folderItems: MenuItem[] = state.folders.length
      ? [
          { title: 'Add to folder' },
          ...state.folders.map((f) => ({
            label: `   ${folderLabel(f, state.folders)}`,
            onClick: () => void L.addToFolder(f.id, ids)
          }))
        ]
      : []
    openMenu(e.clientX, e.clientY, [
      { label: 'Load to deck 1', onClick: () => void loadTrack(0, t.id), disabled: !t.available },
      { label: 'Load to deck 2', onClick: () => void loadTrack(1, t.id), disabled: !t.available },
      { separator: true },
      ...folderItems,
      ...(inFolder
        ? [
            {
              label: `Remove from this folder (${ids.length})`,
              onClick: () => void L.removeFromFolder(state.view as number, ids)
            }
          ]
        : []),
      { separator: true },
      { label: 'Edit info (title, artist…)', onClick: () => useUi.setState({ editTrack: t.id }) },
      { label: 'Show in Explorer', onClick: () => void api.library.showInFolder(t.id), disabled: !t.available },
      ...(t.available ? [] : [{ label: 'Locate missing file…', onClick: () => void L.relocate(t.id) }]),
      { label: `Re-analyse (${ids.length})`, onClick: () => void L.reanalyzeTracks(ids) },
      ...(t.sourceUrl
        ? [{ label: 'Copy source link', onClick: () => void navigator.clipboard.writeText(t.sourceUrl!) }]
        : []),
      { separator: true },
      {
        label: `Remove from library (${ids.length})`,
        onClick: () => {
          if (confirm(`Remove ${ids.length} track(s) from the library?\nFiles on disk are not deleted.`))
            void L.removeFromLibrary(ids)
        }
      }
    ])
  }

  return (
    <div
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDrop={(e) => {
        if (hasFiles(e) && !readDraggedTracks(e).length) {
          e.preventDefault()
          void importDroppedFiles(e, L.currentFolder())
        }
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: template,
          gap: 8,
          padding: '0 10px',
          height: 24,
          alignItems: 'center',
          borderBottom: '1px solid var(--line)',
          background: 'var(--panel-2)'
        }}
      >
        {columns.map((c) => (
          <div
            key={c.key}
            className="label"
            style={{ textAlign: c.align, cursor: 'pointer', whiteSpace: 'nowrap' }}
            onClick={() =>
              useLibrary.setState((s) => ({
                sort: { key: c.key, dir: s.sort.key === c.key ? (s.sort.dir === 1 ? -1 : 1) : 1 }
              }))
            }
          >
            {c.label}
            {state.sort.key === c.key ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </div>
        ))}
      </div>
      <div
        ref={scroller}
        style={{ flex: 1, overflow: 'auto', position: 'relative', outline: 'none' }}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={(e) => {
          if (e.key === 'Delete' && state.selection.length) {
            if (inFolder) void L.removeFromFolder(state.view as number, state.selection)
          }
        }}
        tabIndex={-1}
      >
        <div style={{ height: tracks.length * ROW_H, position: 'relative' }}>
          {tracks.slice(first, last).map((t, k) => {
            const i = first + k
            const sel = selection.has(t.id)
            return (
              <div
                key={t.id}
                data-track-id={t.id}
                draggable
                onDragStart={(e) => {
                  const ids = sel ? state.selection : [t.id]
                  setDragTracks(e, ids)
                }}
                onDragOver={(e) => {
                  if (inFolder && state.sort.key === 'order' && e.dataTransfer.types.includes(TRACKS_MIME)) {
                    e.preventDefault()
                    setDropBefore(t.id)
                  }
                }}
                onDragLeave={() => setDropBefore(null)}
                onDrop={(e) => {
                  const ids = readDraggedTracks(e)
                  setDropBefore(null)
                  if (ids.length && inFolder && state.sort.key === 'order') {
                    e.preventDefault()
                    e.stopPropagation()
                    void L.reorderInFolder(state.view as number, ids, t.id)
                  }
                }}
                onMouseDown={(e) => select(t, e)}
                onClick={(e) => {
                  if (!e.shiftKey && !e.ctrlKey) useLibrary.setState({ selection: [t.id], anchor: t.id })
                }}
                onDoubleClick={() => {
                  // Double-click loads to an empty deck, else to the first one that isn't playing.
                  const decks = useDecks.getState().decks
                  const empty = decks.findIndex((x) => x.trackId == null)
                  const idle = decks.findIndex((x) => !x.playing)
                  const target = empty >= 0 ? empty : idle >= 0 ? idle : 0
                  void loadTrack(target, t.id)
                }}
                onContextMenu={(e) => rowMenu(t, e)}
                style={{
                  position: 'absolute',
                  top: i * ROW_H,
                  left: 0,
                  right: 0,
                  height: ROW_H,
                  display: 'grid',
                  gridTemplateColumns: template,
                  gap: 8,
                  padding: '0 10px',
                  alignItems: 'center',
                  background: sel ? 'rgba(143,123,255,0.22)' : i % 2 ? 'rgba(255,255,255,0.015)' : undefined,
                  borderTop: dropBefore === t.id ? '2px solid var(--accent)' : undefined,
                  color: t.available ? undefined : 'var(--text-faint)',
                  textDecoration: t.available ? undefined : 'line-through',
                  cursor: 'default'
                }}
                title={t.available ? undefined : 'File not found — drive unplugged or file moved'}
              >
                {columns.map((c) => (
                  <div
                    key={c.key}
                    className={c.key === 'bpm' || c.key === 'duration' || c.key === 'key' ? 'mono' : undefined}
                    style={{
                      textAlign: c.align,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0
                    }}
                  >
                    {c.render(t, i)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        {!tracks.length && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: 13,
              textAlign: 'center',
              lineHeight: 1.8,
              pointerEvents: 'none',
              whiteSpace: 'pre-line'
            }}
          >
            {state.search
              ? 'No tracks match your search.'
              : inFolder
                ? 'This folder is empty. Drag tracks here from the Collection.'
                : 'Your library is empty.\nDrop music files or folders here, use + FILES / + FOLDER, or paste a YouTube link.'}
          </div>
        )}
      </div>
    </div>
  )
}

function folderLabel(f: Folder, all: Folder[]): string {
  const names = [f.name]
  let p = f.parentId
  while (p != null) {
    const parent = all.find((x) => x.id === p)
    if (!parent) break
    names.unshift(parent.name)
    p = parent.parentId
  }
  return names.join(' / ')
}

export function moveSelection(delta: number): void {
  const s = useLibrary.getState()
  const list = visibleTracks(s)
  if (!list.length) return
  const idx = s.anchor != null ? list.findIndex((t) => t.id === s.anchor) : -1
  const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))]
  useLibrary.setState({ selection: [next.id], anchor: next.id })
}

export function selectedTrack(): number | null {
  const s = useLibrary.getState()
  return s.anchor ?? s.selection[0] ?? null
}
