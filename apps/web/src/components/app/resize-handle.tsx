import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const read = (key: string) => {
  try { return Number(localStorage.getItem(`devdash.width.${key}`)) || null } catch { return null }
}

/** A pane width the member picked, remembered on this device. */
export function useStoredWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)))
  const [width, setWidth] = useState(() => clamp(read(key) ?? initial))
  const set = (w: number) => {
    const v = clamp(w)
    setWidth(v)
    try { localStorage.setItem(`devdash.width.${key}`, String(v)) } catch { /* private mode: not remembered */ }
  }
  return { width, setWidth: set, reset: () => set(initial) }
}

/**
 * Drag tracking for a vertical resize edge. Returns pointer handlers; `moved` tells a drag from a click.
 * While dragging, transitions are off and the whole page shows the resize cursor (see [data-resizing] in styles.css).
 */
export function useDragWidth(width: number, onWidth: (w: number) => void, dir: 1 | -1 = 1) {
  const drag = useRef<{ x: number; w: number; moved: boolean } | null>(null)
  // Clear the page-wide resize cursor/overlay and end the drag. Must run on every way a drag can end — pointerup can be
  // missed once the pointer is captured, which left the col-resize cursor stuck on the whole page.
  const end = () => {
    delete document.documentElement.dataset.resizing
    setTimeout(() => (drag.current = null)) // after the click that follows pointerup
  }
  return {
    moved: () => !!drag.current?.moved,
    handlers: {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width, moved: false }
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const d = drag.current
        if (!d) return
        const dx = (e.clientX - d.x) * dir
        if (!d.moved && Math.abs(dx) < 4) return
        d.moved = true
        document.documentElement.dataset.resizing = ''
        onWidth(d.w + dx)
      },
      // lostpointercapture always fires when the captured pointer is released (or capture is lost), so the cursor is
      // never left stuck; pointerup and pointercancel are kept as belt-and-suspenders. All three are idempotent.
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    },
  }
}

/** The right edge of a left-hand pane: drag to resize, arrow keys to nudge, double-click to reset. */
export function ResizeHandle({ label, width, min, max, onWidth, onReset, className }: {
  label: string; width: number; min: number; max: number; onWidth: (w: number) => void; onReset: () => void; className?: string
}) {
  const { handlers } = useDragWidth(width, onWidth)
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      title="Drag to resize, double-click to reset" {...handlers} onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          onWidth(width + (e.key === 'ArrowRight' ? 16 : -16))
        }
      }}
      className={cn('absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 hover:after:w-0.5 hover:after:bg-border focus-visible:after:w-0.5 focus-visible:after:bg-ring', className)} />
  )
}
