/**
 * The reply Claude is typing right now. Deltas arrive many times a second; keeping them out of React state means only
 * the live-text component re-renders, at most once per animation frame, instead of the whole conversation per token.
 */
export function createLiveText() {
  let text = ''
  let frame = 0
  const listeners = new Set<() => void>()
  const notify = () => {
    frame = 0
    for (const l of listeners) l()
  }
  return {
    get: () => text,
    append(t: string) {
      text += t
      if (!frame) frame = requestAnimationFrame(notify)
    },
    reset() {
      if (!text) return
      text = ''
      if (frame) cancelAnimationFrame(frame)
      notify()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export type LiveTextStore = ReturnType<typeof createLiveText>
