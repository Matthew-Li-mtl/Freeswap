// A small right-click menu. Open it with openMenu(x, y, items) from anywhere.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'

export type MenuItem =
  { label: string; onClick: () => void; disabled?: boolean } | { separator: true } | { title: string }

const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[] } | null }>(() => ({ menu: null }))

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  useMenu.setState({ menu: { x, y, items } })
}

export function ContextMenu() {
  const menu = useMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 4),
      y: Math.min(menu.y, window.innerHeight - r.height - 4)
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => useMenu.setState({ menu: null })
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="menu-sep" />
        ) : 'title' in it ? (
          <div key={i} className="menu-title">
            {it.title}
          </div>
        ) : (
          <div
            key={i}
            className={`menu-item ${it.disabled ? 'disabled' : ''}`}
            onClick={() => {
              useMenu.setState({ menu: null })
              it.onClick()
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>
  )
}
