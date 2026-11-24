import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../core/db.ts'
import type { AssistantService } from '../assistant/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService } from '../claude/service.ts'
import { fish, fishVoiceId, ProviderError, openai, openaiInstructions, pcmToWav, redact, wavToPcm24k, type SttProvider, type TtsProvider } from './providers.ts'
import { SAMPLES, voiceService } from './service.ts'

const KEY = 'fake-voice-key-for-tests-WXYZ'

const VOICE = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const PRIVATE = 'abababababababababababababababab'

function setup() {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann Lee', 'x', 'x', 'member')").run()
  const checks: string[] = []
  // A provider that refuses one key, echoing it back the way a careless API might.
  const check = async (key: string) => {
    checks.push(key)
    if (key.startsWith('bad')) throw new Error(`invalid api key ${key}`)
  }
  const stt: SttProvider = { id: 'soniox', label: 'Soniox', perMinute: 0.002, connect: () => { throw new Error('no') }, check }
  const tts: TtsProvider = { ...openai, check }
  const spoke: { voice: string | null; text: string }[] = []
  const library = { [VOICE]: 'Cairo Narrator', [OTHER]: 'Berlin Calm' } as Record<string, string>
  const voiceOf = (id: string) => ({ id, name: library[id]!, languages: ['ar'], likes: 3, uses: 900, author: 'x' })
  const fishTts: TtsProvider = {
    ...fish, check,
    library: {
      ...fish.library!,
      search: async () => ({ items: [voiceOf(VOICE)], total: 1 }),
      get: async (_k, id) => {
        if (id === PRIVATE) throw new ProviderError('Fish Audio', 403, 'that voice is private, or not usable with your key.')
        if (!library[id]) throw new ProviderError('Fish Audio', 404, 'no voice with that id.')
        return voiceOf(id)
      },
    },
    async *speak(_k, o) { spoke.push({ voice: o.voice, text: o.text }); yield new Uint8Array(4800) },
  }
  const voice = voiceService({
    db, masterKey: randomBytes(32), claude: {} as ClaudeService, assistant: {} as AssistantService, stt: { soniox: stt }, tts: { fish: fishTts, openai: tts },
  })
  const ann: User = { id: 1, email: '', username: 'ann', name: 'Ann Lee', role: 'member' }
  return { db, voice, ann, checks, spoke }
}

test('keys are checked, sealed at rest, and only ever shown as their last four characters', async () => {
  const { db, voice, ann, checks } = setup()
  const logs: unknown[] = []
  const log = console.log, error = console.error
  console.log = (...a) => void logs.push(a)
  console.error = (...a) => void logs.push(a)
  try {
    const st = await voice.setKey(ann, 'openai', `  ${KEY}\n`)
    assert.deepEqual(checks, [KEY])
    assert.equal(st.keys.openai, '••••WXYZ')
    assert.equal(st.keys.soniox, null)
    assert.deepEqual(st.missing, ['soniox', 'fish', 'voice']) // Fish Audio is the voice by default
    // Nowhere in what goes back to the browser, nor in the database in the clear.
    assert.ok(!JSON.stringify(st).includes(KEY))
    assert.ok(!JSON.stringify(voice.state(ann)).includes(KEY))
    const rows = JSON.stringify(db.prepare('select * from voice_keys').all())
    assert.ok(!rows.includes(KEY) && !rows.includes(KEY.slice(0, 12)))
    assert.deepEqual(await voice.checkKey(ann, 'openai'), { ok: true })

    // A refused key: the error says so without repeating it, and nothing is saved.
    await assert.rejects(voice.setKey(ann, 'soniox', 'bad-key-0123456789'), (e: Error) => !e.message.includes('bad-key-0123456789') && /••••/.test(e.message))
    assert.equal(voice.state(ann).keys.soniox, null)
    await assert.rejects(voice.setKey(ann, 'soniox', 'short'), /doesn't look like/)
    await assert.rejects(voice.setKey(ann, 'nope', KEY), /Unknown provider/)

    assert.equal(voice.removeKey(ann, 'openai').keys.openai, null)
    assert.ok(!JSON.stringify(logs).includes(KEY), 'a key reached the logs')
  } finally {
    console.log = log
    console.error = error
  }
})

test('settings: Fish Audio by default, voices picked from its library or a link, per language if wanted; costs and cap', async () => {
  const { db, voice, ann, spoke } = setup()
  let st = voice.state(ann)
  assert.equal(st.enabled, false)
  assert.equal(st.tts, 'fish') // the default voice provider for everyone
  assert.deepEqual(st.missing, ['soniox', 'fish', 'voice'])
  assert.throws(() => voice.ready(ann), /Turn on voice mode/)
  st = voice.update(ann, { enabled: true, languages: ['ar', 'en', 'de', 'xx'], monthlyCapUsd: 5 })
  assert.deepEqual(st.languages, ['ar', 'en', 'de'])
  assert.throws(() => voice.update(ann, { tts: 'elevenlabs' }), /Unknown voice provider/)
  assert.throws(() => voice.update(ann, { languages: [] }), /at least one/)
  assert.throws(() => voice.ready(ann), /keys/)
  await assert.rejects(voice.setVoice(ann, { voice: VOICE }), /Add your Fish Audio key first/)
  await voice.setKey(ann, 'soniox', KEY)
  await voice.setKey(ann, 'fish', KEY)
  assert.throws(() => voice.ready(ann), /Pick a voice/)

  // A link to the voice's page works as well as its id; its name comes from the library.
  st = await voice.setVoice(ann, { voice: `https://fish.audio/app/m/${VOICE}/` })
  assert.deepEqual(st.voice, { id: VOICE, name: 'Cairo Narrator' })
  await assert.rejects(voice.setVoice(ann, { voice: 'not a voice' }), /isn't a Fish Audio voice id or link/)
  await assert.rejects(voice.setVoice(ann, { voice: 'f'.repeat(32) }), /no voice with that id/)
  voice.ready(ann) // on, keys, a voice, under the cap

  // Its own voice for Arabic, used only once they ask for that.
  st = await voice.setVoice(ann, { voice: OTHER, language: 'ar' })
  assert.deepEqual(st.languageVoices.ar, { id: OTHER, name: 'Berlin Calm' })
  assert.equal(st.perLanguage, false)
  assert.equal(voice.update(ann, { perLanguage: true }).perLanguage, true)

  const found = await voice.searchVoices(ann, { q: 'egypt', language: 'ar' })
  assert.deepEqual(found.items.map((v) => v.id), [VOICE])
  // An id or a link in the search box: that exact voice, or a sentence saying why not (never an empty list).
  assert.deepEqual((await voice.searchVoices(ann, { q: OTHER })).items.map((v) => v.name), ['Berlin Calm'])
  assert.deepEqual((await voice.searchVoices(ann, { q: `https://fish.audio/app/m/${OTHER}/?utm_source=share&lang=ar` })).items.map((v) => v.id), [OTHER])
  const missing = await voice.searchVoices(ann, { q: 'f'.repeat(32) })
  assert.deepEqual(missing.items, [])
  assert.match(missing.notice!, /No Fish Audio voice has the id f{32}/)
  assert.match((await voice.searchVoices(ann, { q: PRIVATE })).notice!, /private, or your Fish Audio key can't use it/)
  assert.equal((await voice.searchVoices(ann, { q: VOICE.slice(1) })).notice, null) // 31 characters: a name search
  // A preview is a WAV of the sample in that language, in the voice asked for (else that language's voice).
  const wav = await voice.preview(ann, { language: 'ar' })
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.deepEqual(spoke.at(-1), { voice: OTHER, text: SAMPLES.ar })
  await voice.preview(ann, { language: 'de', voice: VOICE })
  assert.deepEqual(spoke.at(-1), { voice: VOICE, text: SAMPLES.de })

  // OpenAI is still there, with its fixed list.
  st = voice.update(ann, { tts: 'openai' })
  assert.deepEqual(st.voice, { id: 'marin', name: 'Marin' })
  await voice.setKey(ann, 'openai', KEY)
  assert.deepEqual((await voice.setVoice(ann, { voice: 'cedar' })).voice, { id: 'cedar', name: 'Cedar' })
  await assert.rejects(voice.setVoice(ann, { voice: 'robot' }), /Unknown voice/)

  // About a cent a minute: STT the whole time, TTS for the part it talks.
  assert.ok(st.usage.perMinuteUsd > 0.002 && st.usage.perMinuteUsd < 0.01, String(st.usage.perMinuteUsd))
  db.prepare('insert into voice_calls (user_id, stt, tts, cost_usd, stt_seconds) values (1, ?, ?, 5.2, 600)').run('soniox', 'openai')
  st = voice.state(ann)
  assert.equal(st.overCap, true)
  assert.ok(st.usage.monthMinutes >= 10)
  assert.throws(() => voice.ready(ann), /cap is reached/)
})

test('provider details: redaction and how Arabic is voiced', () => {
  assert.equal(redact(`bad key ${KEY}!`, KEY), 'bad key ••••!')
  assert.match(openaiInstructions('ar'), /Egyptian/)
  assert.doesNotMatch(openaiInstructions('de'), /Egyptian/)
  assert.equal(fishVoiceId('https://fish.audio/app/m/3FA6223BF9424861A60946E8DC2F5BFF/'), '3fa6223bf9424861a60946e8dc2f5bff')
  assert.equal(fishVoiceId('3fa6223bf9424861a60946e8dc2f5bff'), '3fa6223bf9424861a60946e8dc2f5bff')
  assert.equal(fishVoiceId('3fa6223bf9424861a60946e8dc2f5bff00'), null) // too long: not an id
  assert.equal(fishVoiceId('hello'), null)
  // What Fish sends is checked and converted: a 44.1 kHz stereo file comes out 24 kHz mono, the same length.
  const sec = 44_100, st = Buffer.alloc(sec * 4)
  for (let i = 0; i < sec; i++) { st.writeInt16LE(8000, i * 4); st.writeInt16LE(8000, i * 4 + 2) }
  const h = pcmToWav(st, sec)
  h.writeUInt16LE(2, 22); h.writeUInt32LE(sec * 4, 28); h.writeUInt16LE(4, 32) // stereo header
  const mono = wavToPcm24k(h)
  assert.equal(mono.length, 24_000 * 2)
  assert.ok(Math.abs(mono.readInt16LE(1000) - 8000) < 2)
  assert.equal(wavToPcm24k(pcmToWav(Buffer.alloc(4800))).length, 4800) // already right: as it is
  assert.throws(() => wavToPcm24k(Buffer.from('ID3 not a wav file')), /wasn't a WAV/)
  const wav = pcmToWav(Buffer.alloc(480))
  assert.equal(wav.length, 44 + 480)
  assert.equal(wav.subarray(36, 40).toString(), 'data')
})

test('the socket: refused with a reason when voice is off, else wired into the chat and metered', async () => {
  const { EventEmitter } = await import('node:events')
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann Lee', 'x', 'x', 'member')").run()
  let hear: ((e: import('./providers.ts').SttEvent) => void) | null = null
  const stt: SttProvider = {
    id: 'soniox', label: 'Soniox', perMinute: 0.002, check: async () => {},
    connect: (key, _o, on) => { assert.equal(key, KEY); hear = on; return { audio() {}, finalize() {}, keepalive() {}, agentText() {}, close() {} } },
  }
  const tts: TtsProvider = { ...openai, check: async () => {}, async *speak() { yield new Uint8Array(4800).fill(0x40) } }
  let listener: ((id: string, m: unknown) => void) | null = null
  let prompt: ((s: { id: string }, r: { toolName: string }) => void) | null = null
  const SESSION = '11111111-2222-3333-4444-555555555555', OTHERS = '99999999-2222-3333-4444-555555555555'
  const sent: string[] = []
  const claude = {
    send: async (_u: User, id: string, text: string) => { sent.push(`${id}:${text}`); listener?.(id, { type: 'user', message: { content: [{ type: 'text', text }] } }); return 'uuid' },
    interrupt: async () => {},
    onMessage: (fn: (id: string, m: unknown) => void) => { listener = fn; return () => { listener = null } },
    onPrompt: (fn: (s: { id: string }, r: { toolName: string }) => void) => { prompt = fn; return () => { prompt = null } },
    voiceAccess: (_u: User, id: string) => {
      if (id === OTHERS) throw new Error('You can only watch this session, so you can\'t talk to it.')
      return { assistant: false }
    },
  } as unknown as ClaudeService
  const assistant = { current: async () => 'chat-1' } as unknown as AssistantService
  const voice = voiceService({ db, masterKey: randomBytes(32), claude, assistant, stt: { soniox: stt }, tts: { openai: tts } })
  const ann: User = { id: 1, email: '', username: 'ann', name: 'Ann Lee', role: 'member' }
  const socket = () => {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, out: [] as (string | Buffer)[] })
    return Object.assign(ws, { send: (d: string | Buffer) => void ws.out.push(d), close: () => { ws.readyState = 3; ws.emit('close') } })
  }
  const off = socket()
  await voice.talk(ann, off as never, 'hands-free')
  assert.match(String(off.out[0]), /Turn on voice mode/)
  assert.equal(off.readyState, 3)

  voice.update(ann, { enabled: true, tts: 'openai' })
  await voice.setKey(ann, 'soniox', KEY)
  await voice.setKey(ann, 'openai', KEY)
  const ws = socket()
  await voice.talk(ann, ws as never, 'hands-free')
  assert.deepEqual(JSON.parse(String(ws.out.find((d) => String(d).includes('ready')))), { type: 'ready', sessionId: 'chat-1' })
  ws.emit('message', Buffer.alloc(32_000), true) // a second of audio
  hear!({ type: 'tokens', final: [{ text: 'hello there', language: 'en' }], partial: [] })
  hear!({ type: 'endpoint' })
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'send' })), false) // tapped Send: no waiting out the pause
  await new Promise((r) => setImmediate(r))
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /^chat-1:<devdash-voice lang="en"\/>\n<system-reminder>[\s\S]*<\/system-reminder>\n\nhello there$/)
  listener!('other-session', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<voice>Not this one.</voice>' } } })
  listener!('chat-1', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<voice>Hi.</voice>' } } })
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.ok(ws.out.some((d) => Buffer.isBuffer(d) && d[0] === 0 && d.length === 4801), 'audio frame with its generation byte')
  assert.ok(!ws.out.some((d) => String(d).includes('Not this one')))
  ws.close()
  const call = db.prepare('select * from voice_calls').get() as { stt_seconds: number; tts_chars: number; cost_usd: number }
  assert.equal(call.stt_seconds, 1)
  assert.equal(call.tts_chars, 3) // "Hi.": no acknowledgement clips unless they turned waiting talk on
  assert.ok(call.cost_usd > 0)
  assert.ok(!ws.out.some((d) => String(d).includes(KEY)))

  // One of their own coding sessions: its messages carry the voice rules; a permission prompt gets a spoken heads-up.
  const cs = socket()
  await voice.talk(ann, cs as never, 'hands-free', SESSION)
  hear!({ type: 'tokens', final: [{ text: 'run the tests', language: 'en' }], partial: [] })
  hear!({ type: 'endpoint' })
  cs.emit('message', Buffer.from(JSON.stringify({ type: 'send' })), false)
  await new Promise((r) => setImmediate(r))
  assert.match(sent.at(-1)!, new RegExp(`^${SESSION}:<devdash-voice lang="en"/>\\n<system-reminder>They said this out loud`))
  prompt!({ id: SESSION }, { toolName: 'Bash' })
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.ok(cs.out.some((d) => String(d).includes('needs your permission')))
  cs.close()
  // A session they only watch: no voice, and the reason.
  const no = socket()
  await voice.talk(ann, no as never, 'hands-free', OTHERS)
  assert.match(String(no.out[0]), /only watch this session/)
})
