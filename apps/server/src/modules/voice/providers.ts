// Speech providers behind two small interfaces, so another one (Google TTS, say) is one more file. The server talks to
// them with the member's own key; the browser never sees a key or a provider. Prices are per the providers' pages on
// 2026-11-18 and only estimate what a conversation costs.
import WebSocket from 'ws'

/** One recognised piece of speech. `language` is the provider's guess for it ("ar", "de"...). */
export type Token = { text: string; language?: string }
export type SttEvent =
  /** `final` is settled text since the last event; `partial` is the current guess for what follows (replaced each time). */
  | { type: 'tokens'; final: Token[]; partial: Token[] }
  /** They stopped talking (the provider's endpoint detection). */
  | { type: 'endpoint' }
  /** Everything sent so far is final (after `finalize`, e.g. push-to-talk released). */
  | { type: 'finalized' }
  | { type: 'error'; message: string }
  | { type: 'closed' }
export type SttStream = {
  /** 16 kHz mono 16-bit little-endian PCM. */
  audio(pcm: Buffer): void
  finalize(): void
  keepalive(): void
  /** What the agent says, so the recogniser can tell it from the person (and its echo). */
  agentText(text: string, end: boolean): void
  close(): void
}
export type SttProvider = {
  id: string
  label: string
  /** USD per minute of audio streamed (silence included: it's billed too). */
  perMinute: number
  connect(key: string, o: { languages: string[] }, on: (e: SttEvent) => void): SttStream
  check(key: string): Promise<void>
}

/** A voice in a provider's library. */
export type LibraryVoice = { id: string; name: string; languages: string[]; likes: number; uses: number; author: string | null }

export type TtsProvider = {
  id: string
  label: string
  /** A fixed list of voices to pick from; null: the provider has a library to search (`library`). */
  voices: { id: string; label: string }[] | null
  library?: {
    search(key: string, o: { q?: string; language?: string; page?: number }): Promise<{ items: LibraryVoice[]; total: number }>
    get(key: string, id: string): Promise<LibraryVoice>
    /** The voice id in what the member pasted (an id or a link), or null. */
    idOf(raw: string): string | null
  }
  defaultVoice: string | null
  /** Something to tell members about it (shown in settings). */
  note?: string
  /** It acts out [laughing]-style cues (speech.ts EXPRESSIONS); for others they're taken out before it speaks. */
  expressions?: boolean
  /** Streams 24 kHz mono 16-bit little-endian PCM. */
  /** `speed`: 1 is the provider's normal pace. */
  speak(key: string, o: { text: string; voice: string | null; lang: string; speed?: number; signal: AbortSignal }): AsyncIterable<Uint8Array>
  /** USD for one piece of speech: its text and how long the audio was. */
  cost(text: string, seconds: number): number
  check(key: string): Promise<void>
}

export const SAMPLE_RATE_IN = 16_000
export const SAMPLE_RATE_OUT = 24_000

/** A provider's error, with the member's key taken out of whatever came back. */
export class ProviderError extends Error {
  status: number
  constructor(provider: string, status: number, message: string) {
    super(`${provider}: ${message}`)
    this.status = status
  }
}
/** Never let a key into a message, a log line or a response. Pure, tested. */
export const redact = (text: string, key: string) => (key.length >= 6 ? text.split(key).join('••••') : text)

async function failure(label: string, key: string, r: Response) {
  const body = await r.text().catch(() => '')
  let msg = body
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; error_message?: string }
    msg = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? j.error_message ?? body
  } catch { /* not JSON */ }
  const why = r.status === 401 || r.status === 403 ? 'the key was refused. Check it in voice settings.'
    : r.status === 402 ? 'the account is out of credit.'
    : r.status === 429 ? 'too many requests right now (rate limit).'
    : `${r.status} ${msg.slice(0, 200)}`.trim()
  return new ProviderError(label, r.status, redact(why, key))
}
async function checkGet(label: string, url: string, key: string) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw await failure(label, key, r)
}
async function* body(label: string, key: string, r: Response): AsyncIterable<Uint8Array> {
  if (!r.ok || !r.body) throw await failure(label, key, r)
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) yield chunk
}

// ---------- Soniox: real-time STT (https://docs.soniox.com/stt/api-reference/websocket-api) ----------

export const soniox: SttProvider = {
  id: 'soniox',
  label: 'Soniox',
  perMinute: 0.12 / 60, // ~$0.12 per hour of real-time audio (soniox.com/pricing)
  connect(key, o, on) {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { headers: { authorization: `Bearer ${key}` } })
    const early: (Buffer | string)[] = [] // what's sent before the socket opens
    let done = false
    const send = (d: Buffer | string) => (ws.readyState === WebSocket.OPEN ? ws.send(d) : ws.readyState === WebSocket.CONNECTING && early.push(d))
    ws.on('open', () => {
      ws.send(JSON.stringify({
        model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: SAMPLE_RATE_IN, num_channels: 1,
        language_hints: o.languages, enable_language_identification: true,
        // The acknowledgement waits on the endpoint: at most a second after they stop.
        enable_endpoint_detection: true, max_endpoint_delay_ms: 1000, enable_agent_text_input: true,
      }))
      for (const d of early.splice(0)) ws.send(d)
    })
    ws.on('message', (data) => {
      let m: { tokens?: { text: string; is_final?: boolean; language?: string }[]; finished?: boolean; error_code?: number; error_message?: string }
      try { m = JSON.parse(String(data)) } catch { return }
      if (m.error_code) return on({ type: 'error', message: redact(sonioxError(m.error_code, m.error_message ?? ''), key) })
      const final: Token[] = [], partial: Token[] = []
      let endpoint = false, fin = false
      for (const t of m.tokens ?? []) {
        if (t.text === '<end>') endpoint = true
        else if (t.text === '<fin>') fin = true
        else (t.is_final ? final : partial).push({ text: t.text, language: t.language })
      }
      if (final.length || partial.length || m.tokens?.length === 0) on({ type: 'tokens', final, partial })
      if (endpoint) on({ type: 'endpoint' })
      if (fin) on({ type: 'finalized' })
    })
    ws.on('error', (err) => on({ type: 'error', message: redact(`Soniox: ${err.message}`, key) }))
    ws.on('close', () => { if (!done) on({ type: 'closed' }); done = true })
    return {
      audio: (pcm) => send(pcm),
      finalize: () => send(JSON.stringify({ type: 'finalize' })),
      keepalive: () => send(JSON.stringify({ type: 'keepalive' })),
      agentText: (text, end) => send(JSON.stringify({ type: 'agent_text', text, ...(end ? { end_of_segment: true } : {}) })),
      close() {
        done = true
        if (ws.readyState === WebSocket.OPEN) ws.send('') // an empty text frame ends the stream
        ws.close()
      },
    }
  },
  check: (key) => checkGet('Soniox', 'https://api.soniox.com/v1/models', key),
}
function sonioxError(code: number, message: string) {
  if (code === 401) return 'Soniox refused the key. Check it in voice settings.'
  if (code === 402) return 'Soniox: the account is out of credit.'
  if (code === 429) return 'Soniox: too many conversations at once on this account.'
  return `Soniox: ${message || `error ${code}`}`
}

// ---------- OpenAI: gpt-4o-mini-tts (https://developers.openai.com/api/docs/guides/text-to-speech) ----------

const OPENAI_VOICES = ['marin', 'cedar', 'coral', 'sage', 'nova', 'shimmer', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse']
/** How it should sound; Arabic text is said with an Egyptian accent unless the words say otherwise. Pure, tested. */
export function openaiInstructions(lang: string) {
  const base = 'Speak naturally, like a calm, friendly colleague on a call, at a relaxed conversational pace. Never spell out symbols.'
  return lang === 'ar' ? `${base} The text is colloquial Arabic: say it with a natural Egyptian (Cairene) accent, the way it's written.` : base
}
export const openai: TtsProvider = {
  id: 'openai',
  label: 'OpenAI (retiring 6 Jan 2027)',
  voices: OPENAI_VOICES.map((v) => ({ id: v, label: v[0]!.toUpperCase() + v.slice(1) })),
  defaultVoice: 'marin',
  note: 'Retiring: OpenAI shuts down this voice model (gpt-4o-mini-tts) on 6 January 2027. Fish Audio is the one to use.',
  async *speak(key, o) {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', signal: o.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: o.voice ?? 'marin', input: o.text, instructions: openaiInstructions(o.lang), response_format: 'pcm', ...(o.speed ? { speed: o.speed } : {}) }),
    })
    yield* body('OpenAI', key, r)
  },
  // $0.60/1M text tokens + $12/1M audio tokens; OpenAI's own estimate was ~$0.015 per minute of speech.
  cost: (_text, seconds) => (seconds / 60) * 0.015,
  check: (key) => checkGet('OpenAI', 'https://api.openai.com/v1/models', key),
}

// ---------- Fish Audio: s2.1-pro (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) ----------

type FishModel = { _id: string; type?: string; title?: string; languages?: string[]; like_count?: number; task_count?: number; author?: { nickname?: string } }
const fishVoice = (m: FishModel): LibraryVoice => ({
  id: m._id, name: m.title?.trim() || m._id, languages: m.languages ?? [], likes: m.like_count ?? 0, uses: m.task_count ?? 0, author: m.author?.nickname ?? null,
})
/** A Fish Audio voice id, from the id itself or any link to the voice's page. Pure, tested. */
export const fishVoiceId = (raw: string) => /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i.exec(raw.trim())?.[1]?.toLowerCase() ?? null

/**
 * A WAV file as 24 kHz mono 16-bit PCM, whatever rate, channels or depth (16-bit or 32-bit float) it came in. Throws
 * on anything that isn't PCM WAV, so a format change at the provider shows up as an error, not as robot speech.
 * Pure, tested.
 */
export function wavToPcm24k(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Fish Audio: the audio wasn\'t a WAV file.')
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  let data: Buffer | null = null
  for (let i = 12; i + 8 <= wav.length;) {
    const id = wav.toString('ascii', i, i + 4)
    // A streamed WAV may say 0 or 0xffffffff for its data length: then it's the rest of the file.
    let size = wav.readUInt32LE(i + 4)
    if (id === 'data' && (size === 0 || size === 0xffffffff || i + 8 + size > wav.length)) size = wav.length - i - 8
    if (id === 'fmt ') fmt = { format: wav.readUInt16LE(i + 8), channels: wav.readUInt16LE(i + 10), rate: wav.readUInt32LE(i + 12), bits: wav.readUInt16LE(i + 22) }
    if (id === 'data') { data = wav.subarray(i + 8, i + 8 + size); break }
    i += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('Fish Audio: the WAV file had no audio.')
  const float = fmt.format === 3 && fmt.bits === 32
  if (!(fmt.format === 1 && fmt.bits === 16) && !float && !(fmt.format === 0xfffe && (fmt.bits === 16 || fmt.bits === 32))) throw new Error(`Fish Audio: unexpected audio format (${fmt.format}, ${fmt.bits}-bit).`)
  const bytes = fmt.bits / 8, frame = bytes * fmt.channels
  const n = Math.floor(data.length / frame)
  const sample = (k: number) => {
    let sum = 0
    for (let c = 0; c < fmt!.channels; c++) {
      const at = k * frame + c * bytes
      sum += fmt!.bits === 32 ? (float || fmt!.format === 0xfffe ? data!.readFloatLE(at) : data!.readInt32LE(at) / 2 ** 31) : data!.readInt16LE(at) / 32768
    }
    return sum / fmt!.channels
  }
  if (fmt.rate === SAMPLE_RATE_OUT && fmt.channels === 1 && fmt.bits === 16 && fmt.format === 1) return Buffer.from(data.subarray(0, n * 2))
  const out = Buffer.alloc(Math.floor((n * SAMPLE_RATE_OUT) / fmt.rate) * 2)
  for (let j = 0; j < out.length / 2; j++) {
    const x = (j * fmt.rate) / SAMPLE_RATE_OUT, k = Math.floor(x), f = x - k
    const v = k + 1 < n ? sample(k) * (1 - f) + sample(k + 1) * f : sample(Math.min(k, n - 1))
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), j * 2)
  }
  return out
}

/**
 * Cuts the silence a TTS puts before and after each piece (24 kHz 16-bit), keeping a natural breath: otherwise the
 * pause between two pieces is the first one's trailing silence plus the next one's leading one. Pure, tested.
 */
export function trimSilence(pcm: Buffer, o = { threshold: 400, leadMs: 40, tailMs: 120 }): Buffer {
  const n = Math.floor(pcm.length / 2)
  let a = 0, b = n - 1
  while (a < n && Math.abs(pcm.readInt16LE(a * 2)) < o.threshold) a++
  if (a >= n) return pcm.subarray(0, 0)
  while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < o.threshold) b--
  const from = Math.max(0, a - Math.round((o.leadMs * SAMPLE_RATE_OUT) / 1000))
  const to = Math.min(n, b + 1 + Math.round((o.tailMs * SAMPLE_RATE_OUT) / 1000))
  return pcm.subarray(from * 2, to * 2)
}

/** Raw PCM as a WAV file, for a preview the browser plays as it is. Pure, tested. */
export function pcmToWav(pcm: Buffer, rate = SAMPLE_RATE_OUT) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export const fish: TtsProvider = {
  id: 'fish',
  label: 'Fish Audio',
  voices: null,
  defaultVoice: null,
  expressions: true,
  library: {
    // https://docs.fish.audio/api-reference/endpoint/model/list-models
    async search(key, o) {
      const u = new URL('https://api.fish.audio/model')
      u.searchParams.set('page_size', '20')
      u.searchParams.set('page_number', String(o.page ?? 1))
      u.searchParams.set('sort_by', 'task_count') // the most used first: popular voices are the tried ones
      if (o.q?.trim()) u.searchParams.set('title', o.q.trim())
      if (o.language) u.searchParams.set('language', o.language)
      const r = await fetch(u, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw await failure('Fish Audio', key, r)
      const j = (await r.json()) as { total?: number; items?: FishModel[] }
      // Only voices to speak with (the library also has voice-conversion models).
      return { items: (j.items ?? []).filter((m) => (m.type ?? 'tts') === 'tts').map(fishVoice), total: j.total ?? 0 }
    },
    async get(key, id) {
      const r = await fetch(`https://api.fish.audio/model/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (r.status === 404) throw new ProviderError('Fish Audio', 404, 'no voice with that id.')
      if (r.status === 403) throw new ProviderError('Fish Audio', 403, 'that voice is private, or not usable with your key.')
      if (!r.ok) throw await failure('Fish Audio', key, r)
      return fishVoice((await r.json()) as FishModel)
    },
    idOf: (raw) => fishVoiceId(raw),
  },
  async *speak(key, o) {
    const r = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST', signal: o.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: 's2.1-pro' },
      // WAV, not raw PCM: its header says what really came back (rate, channels, bits), so it's checked and converted
      // instead of assumed. Played at the wrong rate it would sound slow, low and robotic.
      body: JSON.stringify({ text: o.text, ...(o.voice ? { reference_id: o.voice } : {}), format: 'wav', sample_rate: SAMPLE_RATE_OUT, latency: 'normal', normalize: true, ...(o.speed ? { prosody: { speed: o.speed } } : {}) }),
    })
    const parts: Uint8Array[] = []
    for await (const c of body('Fish Audio', key, r)) parts.push(c)
    yield wavToPcm24k(Buffer.concat(parts))
  },
  cost: (text) => (Buffer.byteLength(text, 'utf8') / 1e6) * 15, // $15 per million UTF-8 bytes: Arabic letters are two
  check: (key) => checkGet('Fish Audio', 'https://api.fish.audio/wallet/self/api-credit', key),
}

export const STT: Record<string, SttProvider> = { soniox }
/** Fish Audio first: the default (OpenAI's voice model retires in January 2027). */
export const TTS: Record<string, TtsProvider> = { fish, openai }
/** Every provider a key can be saved for. */
export const KEYED = [...Object.keys(STT), ...Object.keys(TTS)]
