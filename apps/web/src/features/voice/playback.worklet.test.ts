import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

/** The real playback worklet, run outside a browser: messages in, 128-sample blocks out, what it posts back. */
function worklet() {
  const posted: Record<string, unknown>[] = []
  let Cls: new () => { port: { onmessage: (e: { data: unknown }) => void }; process: (i: unknown, o: Float32Array[][]) => boolean } = null!
  class AudioWorkletProcessor { port = { onmessage: (_: unknown) => {}, postMessage: (m: Record<string, unknown>) => void posted.push(m) } }
  runInNewContext(readFileSync(new URL('./playback.worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor, sampleRate: 24000, registerProcessor: (_: string, c: typeof Cls) => { Cls = c },
  })
  const w = new Cls()
  const send = (data: unknown) => w.port.onmessage({ data })
  /** Plays `n` blocks; returns how many samples had sound. */
  const play = (n: number) => {
    let sound = 0
    for (let b = 0; b < n; b++) { const out = [[new Float32Array(128)]]; w.process([], out); sound += out[0]![0]!.filter((x) => x !== 0).length }
    return sound
  }
  const pcm = (samples: number) => new Int16Array(samples).fill(1000).buffer
  return { send, play, pcm, posted }
}

test('a clear after a pause unpauses: the next reply plays (it was silent after a barge-in)', () => {
  const w = worklet()
  w.send({ pcm: w.pcm(24000) })
  assert.ok(w.play(10) > 0)
  w.send({ cmd: 'pause' }) // one word over the reply: held
  assert.equal(w.play(10), 0)
  w.send({ cmd: 'clear' }) // more words: an interruption, the reply is dropped
  w.send({ pcm: w.pcm(12000) }); w.send({ mark: 2 }) // the next reply
  assert.ok(w.play(200) > 0, 'the next reply must be heard')
  assert.ok(w.posted.some((m) => m.played === 2))
})

test('after silence it waits for ~300 ms of audio (or a whole sentence) before starting, and reports underruns', () => {
  const w = worklet()
  w.send({ pcm: w.pcm(2400) }) // 100 ms: too little to start with
  assert.equal(w.play(5), 0)
  w.send({ pcm: w.pcm(6000) }) // now 350 ms
  assert.ok(w.play(5) > 0)
  assert.ok(w.posted.some((m) => typeof m.playing === 'number'))
  w.play(100) // runs out mid-sentence: no mark came
  assert.ok(w.posted.some((m) => m.underrun === true))
  const v = worklet()
  v.send({ pcm: v.pcm(1200) }); v.send({ mark: 1 }) // a short whole sentence starts at once
  assert.ok(v.play(2) > 0)
  v.play(50)
  assert.ok(!v.posted.some((m) => m.underrun)) // ending at a mark isn't an underrun
})
