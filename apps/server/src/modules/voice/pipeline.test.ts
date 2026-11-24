import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { ACK_MS, ACKS, HAMASA_VOICE, END_WAITS, endKind, FALSE_BARGE_MS, socialTurn, STUCK_MS, FILLER_MS, FILLERS, hesitationOnly, IDLE_MS, STILL_MS, stopCommand, voiceConversation, voiceTag, type Raw } from './pipeline.ts'
import type { SttEvent, SttProvider, TtsProvider } from './providers.ts'

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

/** A voice conversation wired to fakes: what the recogniser hears, what the chat answers, what the browser gets. */
function setup(o: { mode?: 'hands-free' | 'ptt'; cap?: number; chunks?: (text: string) => Uint8Array[]; languages?: string[]; waitTalk?: boolean; endWait?: 'quick' | 'normal' | 'patient'; fail?: (text: string, attempt: number) => boolean; expressions?: boolean } = {}) {
  let hear: (e: SttEvent) => void = () => {}
  const stt = { audio: [] as number[], finalized: 0, keepalives: 0, agentText: [] as string[], closed: false }
  const sttProvider: SttProvider = {
    id: 'fake', label: 'Fake', perMinute: 0.01,
    connect: (_key, _o, on) => {
      hear = on
      return {
        audio: (b) => void stt.audio.push(b.length), finalize: () => void stt.finalized++, keepalive: () => void stt.keepalives++,
        agentText: (t) => void stt.agentText.push(t), close: () => void (stt.closed = true),
      }
    },
    check: async () => {},
  }
  const spoken: string[] = []
  const aborted: string[] = []
  const timeline: string[] = []
  const ttsProvider: TtsProvider = {
    id: 'faketts', label: 'Fake TTS', voices: null, defaultVoice: null,
    expressions: o.expressions,
    async *speak(_key, { text, signal }) {
      spoken.push(text)
      const attempt = spoken.filter((x) => x === text).length
      if (o.fail?.(text, attempt)) throw new Error('Fish Audio: 500 upstream error')
      timeline.push(`start ${text}`)
      // Sound, not silence: silence at the edges is trimmed off.
      for (const c of (o.chunks?.(text) ?? [new Uint8Array(4800), new Uint8Array(4800)]).map((x) => x.fill(0x40))) {
        await new Promise((r) => setImmediate(r))
        if (signal.aborted) { aborted.push(text); return }
        yield c
      }
      timeline.push(`end ${text}`)
    },
    cost: (text) => text.length / 1000,
    check: async () => {},
  }
  let listener: ((m: Raw) => void) | null = null
  const chat = {
    sent: [] as string[], interrupts: 0,
    // Like the real chat: every message sent into it is also in its stream.
    send: async (t: string) => { chat.sent.push(t); listener?.({ type: 'user', message: { content: [{ type: 'text', text: t }] } }) },
    interrupt: async () => { chat.interrupts++; queueMicrotask(() => listener?.({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })) },
    onMessage: (fn: (m: Raw) => void) => { listener = fn; return () => { listener = null } },
  }
  const client = { msgs: [] as Record<string, unknown>[], audio: [] as { gen: number; bytes: number }[] }
  let spent = 0
  const ended: string[] = []
  const logs: Record<string, unknown>[] = []
  const conv = voiceConversation({
    stt: sttProvider, sttKey: 'stt-secret-key', tts: ttsProvider, ttsKey: 'tts-secret-key', voice: () => null, languages: o.languages ?? ['en'],
    mode: o.mode ?? 'hands-free', chat, log: (t) => void logs.push(t), waitTalk: o.waitTalk, endWait: o.endWait,
    client: { json: (m) => void client.msgs.push(m), audio: (gen, pcm) => void client.audio.push({ gen, bytes: pcm.length }) },
    meter: (u) => { spent += u.costUsd; return o.cap == null || spent < o.cap },
    onEnd: (r) => void ended.push(r),
  })
  const say = (s: string, language = 'en') => hear({ type: 'tokens', final: [{ text: s, language }], partial: [] })
  const partly = (s: string, language = 'en') => hear({ type: 'tokens', final: [], partial: [{ text: s, language }] })
  // Their end of speech, and tapping Send (no waiting out the pause): the hold has its own tests.
  const endpoint = () => { hear({ type: 'endpoint' }); conv.control({ type: 'send' }) }
  const pause = () => hear({ type: 'endpoint' })
  const reply = (m: Raw) => listener?.(m)
  const delta = (text: string) => reply({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const types = () => client.msgs.map((m) => m.type)
  const states = () => client.msgs.filter((m) => m.type === 'state').map((m) => m.state)
  const marks = () => client.msgs.filter((m) => m.type === 'mark') as { id: number; text: string }[]
  const playAll = () => { for (const m of marks()) conv.control({ type: 'played', id: m.id }) }
  const canned = new Set([...Object.values(ACKS), ...Object.values(FILLERS)].flat())
  /** What it said of its answers (acknowledgements and fillers left out). */
  const answers = () => marks().map((m) => m.text).filter((t) => !canned.has(t))
  const acks = () => marks().map((m) => m.text).filter((t) => canned.has(t))
  const result = (m: Partial<Raw> = {}) => reply({ type: 'result', subtype: 'success', ...m })
  return { conv, pause, stt, spoken, aborted, timeline, chat, client, ended, logs, say, partly, endpoint, reply, delta, result, types, states, marks, playAll, answers, acks, hear: (e: SttEvent) => hear(e) }
}


test('a spoken turn: an acknowledgement at once, then only the <voice> parts of the answer, and a timing line', async () => {
  const t = setup({ languages: ['ar', 'en', 'de'] })
  t.conv.control({ type: 'page', page: '<devdash-page path="/tasks" title="Tasks"/>' })
  t.say('شوف ', 'ar'); t.say('my tasks', 'en'); t.say(' بتاعتي النهارده', 'ar')
  t.endpoint()
  await flush()
  assert.equal(t.chat.sent[0], `<devdash-page path="/tasks" title="Tasks"/>\n${voiceTag('ar')}\n${HAMASA_VOICE}\n\nشوف my tasks بتاعتي النهارده`)
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>Okay, I\'m checking'); t.delta(' your tasks.</voice>')
  t.reply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })
  await flush()
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>You have two open tasks. I put the links in the chat.</voice>\n\n- [shop#12](/tasks/shop/12)')
  t.result({ result: 'whole' })
  await flush()
  assert.deepEqual(t.answers(), ['Okay, I\'m checking your tasks.', 'You have two open tasks. I put the links in the chat.'])
  t.conv.control({ type: 'playing', idleMs: 9000 })
  t.playAll()
  assert.equal(t.states().at(-1), 'listening')
  // One line for the turn, timings only.
  const log = t.logs.at(-1)!
  for (const k of ['sent', 'firstToken', 'firstVoiceText', 'firstAudio', 'firstAnswerAudio', 'playStart', 'turnEnd']) assert.equal(typeof log[k], 'number', k)
  assert.ok(!JSON.stringify(t.logs).includes('tasks'))
  t.conv.end('stopped')
  assert.deepEqual(t.ended, ['stopped'])
})

test('barge-in stops the audio, not the work; every reply after it is spoken again', async () => {
  const t = setup({ chunks: () => [new Uint8Array(100), new Uint8Array(100), new Uint8Array(100)] })
  t.say('what is failing'); t.endpoint(); await flush()
  t.delta('<voice>The shop deploy failed this morning.</voice>')
  await flush()
  t.playAll()
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>It was the token, it expired yesterday at noon.</voice>')
  await flush() // sent, playing
  t.partly('wait wait') // talked over it
  assert.ok(t.types().includes('flush'))
  assert.equal(t.chat.interrupts, 0) // the turn keeps running
  t.delta('<voice>Then I retried it twice.</voice>') // the rest of this answer is only written
  t.say('wait wait, check the shop service'); t.endpoint()
  await flush()
  assert.equal(t.chat.interrupts, 0)
  assert.equal(t.chat.sent.length, 2) // joins the running turn, like a typed message
  assert.match(t.chat.sent[1]!, /cut-off-after="The shop deploy failed this morning\."/)
  // The one they talked over was on its way (the flush stopped it); "Then I retried" never went out.
  assert.deepEqual(t.answers(), ['The shop deploy failed this morning.', 'It was the token, it expired yesterday at noon.'])
  t.result() // the turn (both messages) ends
  // Reply 2 and reply 3 are both spoken.
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>Checking the shop service now.</voice>')
  await flush()
  t.result()
  await flush()
  t.playAll()
  t.say('and the builds'); t.endpoint(); await flush()
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>The builds are all green.</voice>')
  t.result()
  await flush()
  assert.deepEqual(t.answers().slice(2), ['Checking the shop service now.', 'The builds are all green.'])
  assert.ok(t.client.audio.at(-1)!.gen > 0) // audio after a flush is a new generation: the browser drops the old one's
  // Message 3 interrupted nothing: no cut-off marker, and never the old one.
  assert.doesNotMatch(t.chat.sent[2]!, /cut-off-after="/)
})

test('cut off before anything of the new answer was heard: no stale marker from an older reply', async () => {
  const t = setup()
  t.say('first'); t.endpoint(); await flush()
  t.delta('<voice>Reply one, the first sentence here.</voice>')
  await flush()
  t.playAll()
  t.result()
  t.say('second'); t.endpoint(); await flush()
  t.delta('<voice>Reply two is starting to play now.</voice>')
  await flush() // sent to the browser, not played yet
  t.say('no wait'); t.endpoint(); await flush()
  assert.doesNotMatch(t.chat.sent[2]!, /cut-off-after="/)
  assert.doesNotMatch(t.chat.sent.join('\n'), /Reply one/)
})

test('a sentence while tools run is delivered mid-turn; only "stop" cancels the work', async () => {
  const t = setup({ languages: ['ar', 'en'] })
  t.say('send it to the session'); t.endpoint(); await flush()
  t.reply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })
  await flush()
  t.playAll()
  t.say('okay, that\'s gonna be better'); t.endpoint(); await flush()
  assert.equal(t.chat.interrupts, 0)
  assert.equal(t.chat.sent.length, 2)
  t.say('وقف', 'ar'); t.endpoint(); await flush()
  assert.equal(t.chat.interrupts, 1)
  assert.equal(t.chat.sent.length, 2) // "stop" isn't a message: it's the stop button
  assert.equal(stopCommand('Stop it please'), true)
  assert.equal(stopCommand('وقف خلاص'), true)
  assert.equal(stopCommand('stop the deploy on the shop'), false)
  assert.equal(stopCommand('don\'t stop'), false)
})

test('"أمم" alone is no interruption and no message: it joins what they say next', async () => {
  const t = setup({ languages: ['ar', 'en'] })
  t.say('hi'); t.endpoint(); await flush()
  t.delta('<voice>Good morning, three sessions are waiting for you today.</voice>')
  await flush()
  t.partly('أمم', 'ar')
  assert.ok(!t.types().includes('flush') && !t.types().includes('pause'))
  t.say('أمم', 'ar'); t.endpoint(); await flush()
  assert.equal(t.chat.sent.length, 1)
  assert.ok(!t.types().includes('flush'))
  t.say(' قولي الحالة', 'ar'); t.endpoint(); await flush()
  assert.match(t.chat.sent[1]!, /أمم قولي الحالة$/)
  assert.equal(hesitationOnly('ähm'), true)
  assert.equal(hesitationOnly('uh, hmm'), true)
  assert.equal(hesitationOnly('اممم'), true)
  assert.equal(hesitationOnly('أمم طيب'), false)
  assert.equal(hesitationOnly('ok'), false)
})

test('its own voice coming back through the mic is not an interruption, and never becomes a message', async () => {
  const t = setup()
  t.say('hi'); t.endpoint(); await flush()
  t.delta('<voice>Good morning, three sessions are waiting for you.</voice>')
  await flush()
  t.partly('three sessions are waiting')
  t.say('sessions are waiting for you')
  assert.ok(!t.types().includes('flush') && !t.types().includes('pause'))
  t.endpoint()
  await flush()
  assert.equal(t.chat.sent.length, 1)
})

test('a single word pauses the reply a moment, then it carries on', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup()
    t.say('hi'); t.endpoint(); await flush()
    t.delta('<voice>Here is the plan for today, starting with the shop.</voice>')
    await flush()
    t.partly('wait')
    assert.equal(t.types().at(-1), 'pause')
    mock.timers.tick(FALSE_BARGE_MS)
    assert.ok(t.types().includes('resume'))
    assert.ok(!t.types().includes('flush'))
    t.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
})

test('an answer without a <voice> block still speaks its first sentence or two', async () => {
  const t = setup()
  t.say('status?'); t.endpoint(); await flush()
  t.reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'All **three** services are up. See [Services](/services).' }] } })
  t.result({ result: 'All **three** services are up. See [Services](/services).' })
  await flush()
  assert.deepEqual(t.answers(), ['All three services are up. See Services.'])
})

test('while the model is quiet: "still on it" after a few seconds, and after a tool starts', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup({ languages: ['de'], waitTalk: true })
    t.say('Wie läuft der Build?', 'de'); t.endpoint(); await flush()
    mock.timers.tick(ACK_MS)
    await flush()
    t.playAll()
    mock.timers.tick(STILL_MS)
    await flush()
    assert.deepEqual(t.acks().slice(1), ['Bin noch dran.'])
    t.playAll()
    t.reply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })
    assert.equal(t.states().at(-1), 'working')
    mock.timers.tick(FILLER_MS)
    await flush()
    assert.deepEqual(t.acks().slice(1), ['Bin noch dran.', 'Gleich.'])
    t.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
})

test('a long reply is cut at sentence ends into a few long pieces, the next synthesized while the first plays', async () => {
  const slow = () => Array.from({ length: 6 }, () => new Uint8Array(200))
  const t = setup({ chunks: slow })
  t.say('x'); t.endpoint(); await flush()
  const one = 'This is the first part of a long answer, and it goes on for a while so that it is clearly a full sentence. '
  const two = 'Here comes the second part, which is just as long and also ends with a proper full stop at the end of it. '
  const three = 'And a third one closes the answer, again long enough to stand as a piece of its own when it is spoken.'
  for (const part of [one, two, three]) t.delta(part.replace(/^/, part === one ? '<voice>' : ''))
  t.delta('</voice>')
  await flush()
  assert.ok(t.answers().length >= 2 && t.answers().length <= 3, t.answers().join(' | '))
  assert.ok(t.answers().every((a) => a.length >= 60))
  const a = t.timeline.findIndex((x) => x.startsWith('end '))
  const b = t.timeline.filter((x) => x.startsWith('start ')).length > 1 ? t.timeline.findIndex((x, i) => x.startsWith('start ') && i > t.timeline.findIndex((y) => y.startsWith('start '))) : -1
  assert.ok(b >= 0 && b < a, t.timeline.join(' | ')) // the second was requested before the first finished
})

test('push-to-talk: audio only while held, sent when released, and pressing it stops the reply', async () => {
  const t = setup({ mode: 'ptt' })
  t.conv.audio(Buffer.alloc(320))
  assert.deepEqual(t.stt.audio, [])
  t.conv.control({ type: 'ptt', down: true })
  t.conv.audio(Buffer.alloc(320))
  t.say('add a task'); t.endpoint()
  await flush()
  assert.equal(t.chat.sent.length, 0)
  t.conv.control({ type: 'ptt', down: false })
  assert.equal(t.stt.finalized, 1)
  t.say(' for the logo'); t.hear({ type: 'finalized' })
  await flush()
  assert.match(t.chat.sent[0]!, /add a task for the logo$/)
  t.delta('<voice>Sure, which project should it go in?</voice>')
  await flush()
  t.conv.control({ type: 'ptt', down: true })
  assert.ok(t.types().includes('flush'))
})

test('the monthly cap ends the conversation; so does two minutes of quiet', async () => {
  const capped = setup({ cap: 0.2 })
  capped.say('hello'); capped.endpoint(); await flush()
  capped.delta(`<voice>${'This sentence costs more than the cap allows today. '.repeat(5)}</voice>`)
  await flush()
  assert.deepEqual(capped.ended, ['cap'])
  assert.equal(capped.client.msgs.at(-1)!.reason, 'cap')

  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup()
    mock.timers.tick(IDLE_MS + 5_000)
    assert.deepEqual(t.ended, ['idle'])
    assert.ok(t.stt.keepalives > 0)
  } finally {
    mock.timers.reset()
  }
})

test('audio frames never split a sample, and the voice tag is escaped', async () => {
  const t = setup({ chunks: () => [new Uint8Array(3), new Uint8Array(5), new Uint8Array(1)] })
  t.say('x'); t.endpoint(); await flush()
  assert.ok(t.client.audio.every((a) => a.bytes % 2 === 0))
  assert.equal(voiceTag('en', 'He said "go" <now>'), '<devdash-voice lang="en" cut-off-after="He said &quot;go&quot; &lt;now&gt;"/>')
  t.conv.control({ type: 'page', page: '<devdash-page path="/x"/><script>' })
  t.say('again'); t.endpoint(); await flush()
  assert.ok(t.chat.sent.at(-1)!.startsWith('<devdash-voice'))
})

test('the acknowledgement: only when the answer is slow, never for a greeting, never the same twice in a row', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    // "Hello": no "let me check", however long the reply takes.
    const hi = setup({ languages: ['ar', 'en'], waitTalk: true })
    hi.say('Hello'); hi.endpoint(); await flush()
    mock.timers.tick(ACK_MS * 2)
    await flush()
    assert.deepEqual(hi.acks(), [])
    hi.conv.end('stopped')

    // A request that takes a while (tools): nothing before 1.2 s, then a fitting line, then the answer.
    const t = setup({ languages: ['ar', 'en'], waitTalk: true })
    t.say('شوف الـ tasks بتاعتي النهارده', 'ar'); t.endpoint(); await flush()
    mock.timers.tick(ACK_MS - 100)
    await flush()
    assert.deepEqual(t.acks(), [])
    t.reply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })
    mock.timers.tick(100)
    await flush()
    assert.equal(t.acks().length, 1)
    assert.ok(ACKS.ar!.includes(t.acks()[0]!))
    t.delta('<voice>عندك تاسكين مفتوحين.</voice>')
    t.result()
    await flush()
    assert.deepEqual(t.answers(), ['عندك تاسكين مفتوحين.'])
    const log = t.logs.at(-1) ?? {}
    t.playAll()
    assert.ok(typeof (t.logs.at(-1) ?? log).ack === 'number')

    // The next slow request gets another line, not the same one.
    t.say('and the sessions waiting for me', 'en'); t.endpoint(); await flush()
    mock.timers.tick(ACK_MS)
    await flush()
    assert.equal(t.acks().length, 2)
    assert.notEqual(t.acks()[1], t.acks()[0])

    // A quick answer (before 1.2 s): no acknowledgement at all.
    const q = setup({ waitTalk: true })
    q.say('what time is my next meeting'); q.endpoint(); await flush()
    mock.timers.tick(400)
    q.delta('<voice>At three.</voice>')
    await flush()
    mock.timers.tick(ACK_MS)
    await flush()
    assert.deepEqual(q.acks(), [])
    for (const c of [t, q]) c.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
  assert.equal(socialTurn('Hello'), true)
  assert.equal(socialTurn('السلام عليكم'), true)
  assert.equal(socialTurn('thanks'), true)
  assert.equal(socialTurn('Danke, gut'), true)
  assert.equal(socialTurn('check my tasks'), false)
  assert.equal(socialTurn('hello, what failed today'), false)
  for (const l of Object.values(ACKS)) for (const a of l) assert.doesNotMatch(a, /^(okay|ok|تمام)\.?$/i)
})

test('his sequence: talked over a reply (one word, then more), and the next two replies are both spoken', async () => {
  const t = setup({ chunks: () => [new Uint8Array(4800)] })
  t.say('what failed'); t.endpoint(); await flush()
  t.delta('<voice>The shop deploy failed this morning, at step two.</voice>')
  await flush()
  t.partly('no') // one word: held
  t.partly('no wait, the other one') // a real sentence: interruption
  assert.ok(t.types().includes('pause') && t.types().includes('flush'))
  // The flush must end the pause too (the browser's player stayed paused, so later replies were silent).
  t.say('no wait, the other one'); t.endpoint(); await flush()
  t.delta('<voice>Okay, the builds then: all green.</voice>')
  t.result()
  await flush()
  t.playAll()
  t.say('and sessions'); t.endpoint(); await flush()
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>Two sessions are waiting for you.</voice>')
  t.result()
  await flush()
  assert.deepEqual(t.answers().slice(-2), ['Okay, the builds then: all green.', 'Two sessions are waiting for you.'])
})

test('talked over while the reply text was still streaming: the replies after it are spoken', async () => {
  const t = setup()
  t.say('tell me about today'); t.endpoint(); await flush()
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>Today you have three things. First the shop')
  await flush()
  t.say('wait, just the shop'); t.endpoint(); await flush() // mid-block, the block never closes in this message
  t.delta(' deploy, then two reviews.</voice>')
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  t.delta('<voice>The shop deploy failed at step two.</voice>')
  t.result()
  await flush()
  assert.ok(t.answers().includes('The shop deploy failed at step two.'), t.answers().join(' | '))
})

test('a browser whose player is stuck gets reset and the unheard reply sent again: never silence', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup({ chunks: () => [new Uint8Array(48000)] }) // a second of audio
    t.say('status'); t.endpoint(); await flush()
    t.delta('<voice>Everything is running fine today.</voice>')
    await flush()
    const sent = t.marks().length
    const flushes = t.types().filter((x) => x === 'flush').length
    mock.timers.tick(1000 + STUCK_MS) // never played
    await flush()
    assert.equal(t.types().filter((x) => x === 'flush').length, flushes + 1)
    assert.equal(t.marks().length, sent + 1, JSON.stringify(t.marks().map((m) => m.text))) // sent again
    assert.equal(t.marks().at(-1)!.text, 'Everything is running fine today.')
    t.result()
    t.playAll()
    mock.timers.tick(10 * STUCK_MS)
    await flush()
    assert.equal(t.marks().length, sent + 1) // heard: no more retries
    t.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
})

test('live audio for a sentence is the preview\'s: the same length, sent whole, no gap inside it', async () => {
  // A TTS that generates slower than real time, in bursts (what left 1-2 s pauses between words when streamed).
  const pieces = () => Array.from({ length: 5 }, () => new Uint8Array(9600)) // 5 x 200 ms
  const t = setup({ chunks: pieces })
  t.say('x'); t.endpoint(); await flush()
  const before = t.client.audio.length
  t.delta('<voice>A fixed sentence to compare with its preview.</voice>')
  await flush()
  const frames = t.client.audio.slice(before)
  const ms = (frames.reduce((n, f) => n + f.bytes, 0) / 2 / 24000) * 1000
  assert.equal(Math.round(ms), 1000) // the preview's duration: 5 x 200 ms
  // All of it reaches the browser together, after the sentence is complete: the player never waits mid-sentence.
  const marks = t.client.msgs.filter((m) => m.type === 'mark')
  assert.equal(marks.length, 1)
})

test('by default it says nothing while it works: no acknowledgement, no "one moment", only real answers', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup({ languages: ['ar', 'en'] })
    t.say('شوف الـ tasks بتاعتي النهارده', 'ar'); t.endpoint(); await flush()
    t.reply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })
    mock.timers.tick(60_000)
    await flush()
    assert.deepEqual(t.marks(), [])
    t.delta('<voice>عندك تاسكين مفتوحين.</voice>')
    t.result()
    await flush()
    assert.deepEqual(t.marks().map((m) => m.text), ['عندك تاسكين مفتوحين.'])
    t.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
})

test('a breath mid-thought is not the end: it waits, merges what follows, and sends sooner after a question', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const N = END_WAITS.normal
    // "شوف الـ tasks و" + a breath + "قولي مين مستنيني": one message.
    const t = setup({ languages: ['ar', 'en'] })
    t.say('شوف الـ tasks بتاعتي و', 'ar'); t.pause(); await flush()
    assert.ok(t.client.msgs.some((m) => m.type === 'holding' && (m.ms as number) > 0))
    mock.timers.tick(N.unfinished - 300)
    await flush()
    assert.equal(t.chat.sent.length, 0) // still listening
    t.partly(' قولي', 'ar'); t.say(' قولي مين مستنيني؟', 'ar'); t.pause(); await flush()
    mock.timers.tick(N.done)
    await flush()
    assert.equal(t.chat.sent.length, 1)
    assert.match(t.chat.sent[0]!, /شوف الـ tasks بتاعتي و قولي مين مستنيني؟$/)
    // A plain sentence: the normal hold, then sent.
    t.say('Check the shop deploy.'); t.pause(); await flush()
    mock.timers.tick(N.normal - 100); await flush()
    assert.equal(t.chat.sent.length, 1)
    mock.timers.tick(100); await flush()
    assert.equal(t.chat.sent.length, 2)
    // "…, send": at once, without the word.
    t.say('add a task for the logo, send'); t.pause(); await flush()
    mock.timers.tick(N.done); await flush()
    assert.match(t.chat.sent[2]!, /add a task for the logo$/)
    // "وقف" never waits.
    t.say('وقف', 'ar'); t.pause(); await flush()
    assert.equal(t.chat.interrupts, 1)
    t.conv.end('stopped')

    // Patient waits longer than quick for the same words.
    for (const [w, ms] of [['quick', END_WAITS.quick.normal], ['patient', END_WAITS.patient.normal]] as const) {
      const c = setup({ endWait: w })
      c.say('Check the shop deploy.'); c.pause(); await flush()
      mock.timers.tick(ms - 50); await flush()
      assert.equal(c.chat.sent.length, 0, w)
      mock.timers.tick(50); await flush()
      assert.equal(c.chat.sent.length, 1, w)
      c.conv.end('stopped')
    }
  } finally {
    mock.timers.reset()
  }
  assert.equal(endKind('what failed today?'), 'done')
  assert.equal(endKind('شوف مين مستنيني؟'), 'done')
  assert.equal(endKind('check the build and'), 'unfinished')
  assert.equal(endKind('عايزك تشوف الـ deploy عشان'), 'unfinished')
  assert.equal(endKind('ich wollte fragen, ähm'), 'unfinished')
  assert.equal(endKind('the shop'), 'unfinished') // a short fragment
  assert.equal(endKind('Check the shop deploy.'), 'normal')
  assert.ok(END_WAITS.normal.done < END_WAITS.normal.normal && END_WAITS.normal.normal < END_WAITS.normal.unfinished)
})

test('a block closing in its own delta is spoken right away, not when the whole message lands', async () => {
  const t = setup()
  t.say('x'); t.endpoint(); await flush()
  for (const d of ['<voice>Okay, everything', ' is running fine.', '</vo', 'ice>', '\n\nAnd a long written part follows here.']) t.delta(d)
  await flush()
  // No 'assistant' message or result yet: the closed block still went to TTS.
  assert.deepEqual(t.answers(), ['Okay, everything is running fine.'])
})

test('[laughing]-style cues: never read out by a voice that can\'t act them, never shown in the marks', async () => {
  const t = setup() // the fake voice has no expressions (like OpenAI)
  t.say('x'); t.endpoint(); await flush()
  t.delta('<voice>[laughing] That one was funny, honestly.</voice>')
  await flush()
  assert.deepEqual(t.spoken, ['That one was funny, honestly.'])
  assert.deepEqual(t.answers(), ['That one was funny, honestly.'])
  // The message tells the model which cues it may use only when the voice can act them out.
  assert.doesNotMatch(t.chat.sent[0]!, /expressions=/)
})

test('his reply: a short <voice> block, then 2,000+ characters of markdown, streamed in odd pieces: the block is spoken', async () => {
  const voice = '[chuckling] تمام يا باشا، كتبتلك الإيميل بالإنجليزي في الشات وفيه كل النقط اللي قلتها.'
  const written = ('\n\n## Draft\n\n> **Subject:** Follow-up on the `shop` deploy <draft>\n>\n> Hi Ann,\n\n- **Tests:** 40 pass\n- الـ migration محتاجة تتراجع\n- 3 < 5 and 5 > 3, see [the PR](https://x/y)\n\n```ts\nconst x = a < b\n```\n').repeat(10)
  const reply = `<voice>${voice}</voice>${written}`
  assert.ok(reply.length > 2000)
  const t = setup({ languages: ['ar', 'en', 'de'], expressions: true })
  t.say('اكتبلي إيميل لآن', 'ar'); t.endpoint(); await flush()
  assert.match(t.chat.sent[0]!, /expressions="laughing chuckling sighing whispering break"/)
  t.reply({ type: 'stream_event', event: { type: 'message_start' } })
  // "</voice>" and the text after it in one piece, then the rest in pieces of 37.
  const cut = reply.indexOf('</voice>') - 5
  t.delta(reply.slice(0, cut)); t.delta(reply.slice(cut, cut + 60))
  for (let i = cut + 60; i < reply.length; i += 37) t.delta(reply.slice(i, i + 37))
  t.reply({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
  t.result({ result: reply })
  await flush()
  assert.deepEqual(t.spoken, [voice]) // the cue goes to a voice that acts it out
  assert.deepEqual(t.answers(), ['تمام يا باشا، كتبتلك الإيميل بالإنجليزي في الشات وفيه كل النقط اللي قلتها.'])
  t.playAll()
  const log = t.logs.at(-1)!
  assert.equal(log.voiceChars, voice.length)
  assert.equal(log.pieces, 1)
  assert.deepEqual(log.errors, [])
})

test('a voice service failure is retried once; if it fails again, the voice bar says so instead of going quiet', async () => {
  const once = setup({ fail: (_t, attempt) => attempt === 1 })
  once.say('x'); once.endpoint(); await flush()
  once.delta('<voice>The build is green again.</voice>')
  await flush()
  assert.deepEqual(once.answers(), ['The build is green again.']) // the second try worked
  const twice = setup({ fail: () => true })
  twice.say('x'); twice.endpoint(); await flush()
  twice.delta('<voice>The build is green again.</voice>')
  await flush()
  assert.deepEqual(twice.answers(), [])
  assert.ok(twice.client.msgs.some((m) => m.type === 'error' && /^Couldn't speak this reply: 500 upstream error/.test(String(m.message))))
  twice.conv.end('stopped')
  assert.deepEqual(twice.logs.at(-1)!.errors, ['tts:1', 'tts:2'])
})

test('a player that stays stuck: after the retries the voice bar says so, and the next reply tries again from scratch', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const t = setup({ chunks: () => [new Uint8Array(48000)] })
    t.say('status'); t.endpoint(); await flush()
    t.delta('<voice>Everything is running fine today.</voice>')
    await flush()
    for (let i = 0; i < 3; i++) { mock.timers.tick(1000 + STUCK_MS + 1000); await flush() }
    assert.ok(t.client.msgs.some((m) => m.type === 'error' && /Couldn't play this reply/.test(String(m.message))))
    t.result()
    const before = t.marks().length
    t.say('and now'); t.endpoint(); await flush()
    t.delta('<voice>The second reply is here now.</voice>')
    await flush()
    assert.equal(t.marks().length, before + 1)
    mock.timers.tick(1000 + STUCK_MS + 100); await flush()
    assert.equal(t.marks().length, before + 2) // retried: the counter started over for the new reply
    t.conv.end('stopped')
  } finally {
    mock.timers.reset()
  }
})

test('a reply to a typed message, a wake-up or a reminder is never spoken, even with a <voice> block in it', async () => {
  const t = setup()
  t.say('hi'); t.endpoint(); await flush()
  assert.match(t.chat.sent[0]!, /<system-reminder>This message was spoken in voice mode/) // the rules ride on the spoken message
  t.delta('<voice>Hello there, good morning to you.</voice>')
  t.result()
  await flush()
  assert.equal(t.answers().length, 1)
  // A typed message, then a wake-up reminder: their replies stay silent.
  for (const typed of ['<devdash-page path="/x" title="X"/>\n\nwhat about the shop?', '<system-reminder>Sessions you follow changed: shop finished.</system-reminder>']) {
    t.reply({ type: 'user', message: { content: [{ type: 'text', text: typed }] } })
    t.reply({ type: 'stream_event', event: { type: 'message_start' } })
    t.delta('<voice>The shop deploy is done.</voice>\n\nDetails here.')
    t.result({ result: 'The shop deploy is done.' })
    await flush()
  }
  assert.equal(t.answers().length, 1)
})
