import type { Terminal } from '@xterm/xterm'

/** Finger travel before a touch counts as a scroll rather than a tap (a tap still focuses the terminal). */
const SLOP_PX = 8

/**
 * Touch scrolling, which xterm 6 doesn't have (its viewport only listens to the wheel): one finger drags the scrollback,
 * and a flick glides on and slows to a stop. Returns the cleanup.
 */
export function scrollOnTouch(term: Terminal, el: HTMLElement) {
  let y = 0, t = 0, v = 0, rest = 0, dragging = false, frame = 0
  const rowPx = () => (el.querySelector<HTMLElement>('.xterm-screen')?.offsetHeight || el.clientHeight) / term.rows
  // Positive px goes back toward older output. Whatever's short of a whole row carries over to the next move.
  const by = (px: number) => {
    rest += px
    const rows = Math.trunc(rest / rowPx())
    if (rows) {
      term.scrollLines(rows)
      rest -= rows * rowPx()
    }
  }

  const start = (e: TouchEvent) => {
    cancelAnimationFrame(frame)
    y = e.touches[0]!.clientY
    t = e.timeStamp
    v = rest = 0
    dragging = false
  }
  const move = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    const now = e.touches[0]!.clientY
    if (!dragging && Math.abs(now - y) < SLOP_PX) return
    dragging = true
    e.preventDefault() // the page itself doesn't scroll or bounce under the finger
    const dt = Math.max(1, e.timeStamp - t)
    v = 0.8 * ((now - y) / dt) + 0.2 * v // px per ms, smoothed over the last few moves
    by(y - now)
    y = now
    t = e.timeStamp
  }
  const end = (e: TouchEvent) => {
    if (!dragging || e.timeStamp - t > 80 || Math.abs(v) < 0.3) return // lifted after a pause: no glide
    let last = performance.now()
    const glide = (now: number) => {
      const dt = now - last
      last = now
      by(-v * dt)
      v *= 0.995 ** dt
      if (Math.abs(v) > 0.03) frame = requestAnimationFrame(glide)
    }
    frame = requestAnimationFrame(glide)
  }

  el.addEventListener('touchstart', start, { passive: true })
  el.addEventListener('touchmove', move, { passive: false })
  el.addEventListener('touchend', end, { passive: true })
  return () => {
    cancelAnimationFrame(frame)
    el.removeEventListener('touchstart', start)
    el.removeEventListener('touchmove', move)
    el.removeEventListener('touchend', end)
  }
}
