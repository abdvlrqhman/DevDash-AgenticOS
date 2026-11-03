import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { scrollOnTouch } from './touch-scroll.ts'

test('one finger scrolls the terminal: a drag moves row by row, a flick glides, a tap stays a tap', () => {
  // 20 rows of 15 px. Negative rows scroll back toward older output.
  let scrolled = 0
  const term = { rows: 20, scrollLines: (n: number) => { scrolled += n } } as unknown as Terminal
  const el = Object.assign(new EventTarget(), { clientHeight: 300, querySelector: () => ({ offsetHeight: 300 }) }) as unknown as HTMLElement
  let frames: FrameRequestCallback[] = []
  globalThis.requestAnimationFrame = (cb) => frames.push(cb)
  globalThis.cancelAnimationFrame = () => { frames = [] }
  const runFrames = (max = 1000) => {
    let at = performance.now(), n = 0
    while (frames.length && n++ < max) frames.shift()!((at += 16))
    return n
  }
  const touch = (type: string, y: number | null, at: number) => {
    const e = new Event(type, { cancelable: true })
    Object.defineProperties(e, { touches: { value: y === null ? [] : [{ clientY: y }] }, timeStamp: { value: at } })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  const drag = (from: number, to: number, steps: number, stepMs: number, liftAfterMs: number) => {
    let t = 1000, prevented = false
    touch('touchstart', from, t)
    for (let i = 1; i <= steps; i++) prevented = touch('touchmove', from + ((to - from) * i) / steps, (t += stepMs)) || prevented
    touch('touchend', null, t + liftAfterMs)
    return prevented
  }
  const stop = scrollOnTouch(term, el)

  // A tap that wobbles a few pixels doesn't scroll, and leaves the touch alone so it still focuses the terminal.
  assert.equal(drag(300, 304, 1, 10, 10), false)
  assert.equal(scrolled, 0)

  // A slow 150 px drag down shows 10 older rows, without the page scrolling too; lifted after a pause, it doesn't glide.
  assert.equal(drag(100, 250, 10, 16, 200), true)
  assert.equal(scrolled, -10)
  assert.equal(runFrames(), 0)
  // And back up.
  drag(250, 100, 10, 16, 200)
  assert.equal(scrolled, 0)

  // A flick keeps going after the finger lifts, then slows to a stop.
  drag(100, 260, 4, 8, 0)
  const lifted = scrolled
  const n = runFrames()
  assert.ok(scrolled < lifted - 10, `glided ${lifted - scrolled} rows`)
  assert.ok(n > 5 && n < 1000, `stopped after ${n} frames`)

  // Touching the screen during a glide stops it.
  scrolled = 0
  drag(260, 100, 4, 8, 0)
  runFrames(3)
  touch('touchstart', 200, 5000)
  assert.equal(frames.length, 0)

  // After cleanup, touches do nothing.
  stop()
  const before = scrolled
  assert.equal(drag(100, 250, 10, 16, 200), false)
  assert.equal(scrolled, before)
})
