// "Edit track info" dialog: title, artist, album, genre, comment.
// Changes are saved in the library database only. The audio file itself isn't modified.

import { useEffect, useState } from 'react'
import { api } from '../platform'
import { useUi, toast } from '../state/ui'
import { getTrack, upsertTracks } from '../state/library'
import { Btn } from './controls'

const FIELDS = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['genre', 'Genre'],
  ['comment', 'Comment']
] as const

type Field = (typeof FIELDS)[number][0]

export function TrackInfoModal() {
  const id = useUi((s) => s.editTrack)
  const [values, setValues] = useState<Record<Field, string>>({
    title: '',
    artist: '',
    album: '',
    genre: '',
    comment: ''
  })

  useEffect(() => {
    const t = id != null ? getTrack(id) : undefined
    if (t) setValues({ title: t.title, artist: t.artist, album: t.album, genre: t.genre, comment: t.comment })
  }, [id])

  if (id == null) return null
  const close = () => useUi.setState({ editTrack: null })
  const save = async () => {
    const t = await api.library.updateTrack(id, { ...values, title: values.title.trim() || 'Untitled' })
    upsertTracks([t])
    toast('Track info saved')
    close()
  }

  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div className="modal" style={{ width: 480 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Edit track info
          <Btn className="ghost" onPress={close}>
            ✕
          </Btn>
        </div>
        <form
          className="modal-body"
          style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          onKeyDown={(e) => e.key === 'Escape' && close()}
        >
          {FIELDS.map(([k, label], i) => (
            <label key={k} style={{ display: 'contents' }}>
              <span style={{ color: 'var(--text-dim)' }}>{label}</span>
              <input
                autoFocus={i === 0}
                value={values[k]}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              />
            </label>
          ))}
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <span style={{ color: 'var(--text-faint)', marginRight: 'auto', fontSize: 11 }}>
              Saved in Freeswap's library (the file's own tags are not changed).
            </span>
            <Btn onPress={close}>CANCEL</Btn>
            <Btn lit color="var(--accent)" onPress={() => void save()}>
              SAVE
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
