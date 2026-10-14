// A small "pick one option" dialog with a promise-based API:
//   const choice = await askChoice({ title, message, choices: [...] })   // id, or null if cancelled
// While it's open, DJ keyboard shortcuts are paused so key presses don't trigger the decks.

import { useEffect } from 'react'
import { create } from 'zustand'
import { setKeyboardEnabled } from '../input/bindings'
import { Btn } from './controls'

export interface Choice {
  id: string
  label: string
  primary?: boolean
}

interface Request {
  title: string
  message: string
  choices: Choice[]
  resolve: (id: string | null) => void
}

const useChoice = create<{ req: Request | null }>(() => ({ req: null }))

export function askChoice(opts: { title: string; message: string; choices: Choice[] }): Promise<string | null> {
  return new Promise((resolve) => {
    useChoice.getState().req?.resolve(null) // only one dialog at a time
    useChoice.setState({ req: { ...opts, resolve } })
  })
}

function finish(id: string | null): void {
  const req = useChoice.getState().req
  useChoice.setState({ req: null })
  req?.resolve(id)
}

export function ChoiceDialog() {
  const req = useChoice((s) => s.req)

  useEffect(() => {
    if (!req) return
    setKeyboardEnabled(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null)
      if (e.key === 'Enter') finish(req.choices.find((c) => c.primary)?.id ?? req.choices[0].id)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      setKeyboardEnabled(true)
    }
  }, [req])

  if (!req) return null
  return (
    <div className="modal-backdrop" onPointerDown={() => finish(null)}>
      <div className="modal" style={{ width: 460 }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">{req.title}</div>
        <div className="modal-body" style={{ lineHeight: 1.6 }}>
          <div style={{ whiteSpace: 'pre-line' }}>{req.message}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <Btn onPress={() => finish(null)}>CANCEL</Btn>
            {req.choices.map((c) => (
              <Btn key={c.id} lit={c.primary} color="var(--accent)" onPress={() => finish(c.id)}>
                {c.label}
              </Btn>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
