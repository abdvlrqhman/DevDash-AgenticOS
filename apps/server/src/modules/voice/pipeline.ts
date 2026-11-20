// One voice conversation with Hamasa: the member's speech comes in (STT), what they said goes into their chat as a
// message, the spoken parts of the reply come back as audio (TTS). It owns turn-taking: endpointing, barge-in, the
// acknowledgement while tools run, push-to-talk, and going quiet when nobody talks. Everything it needs comes in as
// arguments (providers, keys, the chat, the browser), so it's tested without a network.
import { VOICE_TAG } from '../assistant/prompt.ts'
import { EXPRESSIONS, fallbackSpeech, isArabic, keepExpressions, sentenceChunker, speakable, stripExpressions, voiceExtractor } from './speech.ts'
import { SAMPLE_RATE_IN, SAMPLE_RATE_OUT, trimSilence, type SttProvider, type Token, type TtsProvider } from './providers.ts'

export type VoiceState = 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking'
export type Mode = 'hands-free' | 'ptt'
export type EndReason = 'stopped' | 'idle' | 'cap' | 'error' | 'closed'
/** A message from the chat's stream, as the session publishes it. */
export type Raw = {
  type?: string; subtype?: string; is_error?: boolean; terminal_reason?: string; result?: unknown; parent_tool_use_id?: string | null
  event?: { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } }
  message?: { content?: unknown }
}
/** Their chat with Hamasa. */
export type Chat = {
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  onMessage(fn: (m: Raw) => void): () => void
}
export type ToClient = { json(m: Record<string, unknown>): void; audio(gen: number, pcm: Uint8Array): void }
export type Usage = { sttSeconds: number; ttsChars: number; costUsd: number }

/**
 * What a coding session is told with each spoken message (Hamasa has its own voice rules): hidden in the transcript, like
 * every system reminder. Works the same for Claude Code and OpenCode: it's part of the message.
 */
export const CODING_VOICE = `<system-reminder>They said this out loud in voice mode and hear your reply. Put what you say aloud in <voice>…</voice>, in the language of lang, one or two plain sentences: a short human summary of what you did or found, like "I changed three files and the tests pass, the details are on screen". Never say code, paths, diffs, ids, commands or tool names. Everything else is written as usual, in the same language. Say nothing aloud while you work; speak when you have the result or a question. If the tag lists expressions, you may use one, rarely, in square brackets exactly as listed.</system-reminder>`
const HEADS_UP: Record<'permission' | 'question', Record<string, string>> = {
  permission: { en: 'It needs your permission for something, it\'s on screen.', ar: 'محتاج إذنك في حاجة، هي على الشاشة.', de: 'Es braucht deine Erlaubnis, das steht auf dem Bildschirm.' },
  question: { en: 'It has a question for you, it\'s on screen.', ar: 'عنده سؤال ليك، على الشاشة.', de: 'Es hat eine Frage an dich, sie steht auf dem Bildschirm.' },
}

/** Hands-free goes quiet after this long without anyone talking. */
export const IDLE_MS = 120_000
/** A word or two that isn't followed by more within this long was a cough or an "mm": the reply carries on. */
export const FALSE_BARGE_MS = 2_000
/** A tool running this long with nothing said: a short acknowledgement. */
export const FILLER_MS = 2_500
/** Nothing said for this long since the acknowledgement: "still on it" (the model may think for 10 s or more). */
export const STILL_MS = 5_000
/** Sent audio not heard this long after it should have finished: the browser's player is reset and it's sent again. */
export const STUCK_MS = 3_000
/** One TTS request may take this long before it's tried again. */
export const TTS_TIMEOUT_MS = 20_000
const KEEPALIVE_MS = 10_000
const TICK_MS = 5_000
/** How many pieces are synthesized at once: the next sentence is ready when the one playing ends. */
const PREFETCH = 2
/**
 * Said when the real answer hasn't started ACK_MS after they stopped talking: a person's "hmm, let me check" for a
 * request that takes a while. One picked at random, never the same twice in a row.
 */
export const ACKS: Record<string, string[]> = {
  ar: ['ممم، ثانية.', 'طيب، بشوف.', 'ثواني بشوفلك.', 'ماشي، لحظة.'],
  en: ['Let me check.', 'Hmm, one sec.', 'Let me see.', 'One moment, checking.'],
  de: ['Moment, ich schau.', 'Hmm, Sekunde.', 'Lass mich kurz schauen.', 'Einen Moment.'],
}
/** How long after they stop talking the acknowledgement waits for the real answer to start. */
export const ACK_MS = 1_200
// What people say to be social (hello, thanks, yes): answered by the reply itself, never with "let me check".
const SOCIAL = new Set(('hi hello hey yo thanks thank you ok okay sure yes yeah yep no nope cool great nice good morning evening night bye '
  + 'hallo moin servus danke ja nein gut guten morgen abend tschüss super '
  + 'اهلا أهلا هاي هلو مرحبا السلام عليكم صباح مساء الخير النور شكرا ميرسي تسلم اه أه ايوه أيوه لا تمام ماشي حلو جميل باي').split(' '))
/** A short social turn (a greeting, thanks, a yes or no): no acknowledgement before the reply. Pure, tested. */
export const socialTurn = (t: string) => { const w = words(t); return w.length > 0 && w.length < 5 && w.every((x) => SOCIAL.has(x)) }
export const FILLERS: Record<string, string[]> = {
  en: ['Still on it.', 'Almost there.'], de: ['Bin noch dran.', 'Gleich.'], ar: ['لسه شغال عليها.', 'خلاص قربت.'],
}
// Hesitations in their languages (أمم, ähm, uh...): never an interruption, and never a message by themselves.
const HESITATION = /^(?:[اأإآ]*م+|[اأإآ]+ه+|ه+م*|u+[hm]+|h+m+|m+h*m+|e+r+m*|a+h+|ä+h*m*|ö+h*m*)$/u
// "Stop" in their languages, said on its own (a short command, not a sentence that mentions stopping).
const STOP = /^(?:stop|stopp|cancel|halt|abort|abbrechen|hör auf|vergiss es|وقف|اوقف|بطل|الغي|إلغي|كنسل)(?: (?:it|that|now|please|bitte|خلاص|بقى|دلوقتي))*$/u
/** An explicit order to cancel the work. Pure, tested. */
export const stopCommand = (t: string) => STOP.test(words(t).join(' '))

// How long to wait, after their last word, before what they said becomes a message: shorter when it plainly ended (a
// question, a command, "send"), longer when it plainly didn't (a connector, a filler, a comma, a short fragment).
export type EndWait = 'quick' | 'normal' | 'patient'
export const END_WAITS: Record<EndWait, { done: number; normal: number; unfinished: number }> = {
  quick: { done: 500, normal: 900, unfinished: 1_800 },
  normal: { done: 750, normal: 1_400, unfinished: 2_500 },
  patient: { done: 1_100, normal: 2_200, unfinished: 3_500 },
}
const CONNECTOR = /(?:^|\s)(?:و|بس|يعني|لأن|لان|عشان|علشان|لو|ولا|او|أو|بعدين|اللي|إن|ان|and|but|so|because|or|if|then|that|um|uh|und|aber|weil|oder|dass|wenn|also|ähm|äh)\s*$/iu
const SEND = /(?:^|[\s،,.])(?:send it|send|go ahead|ابعتها|ابعت|خلاص ابعت|schick ab|abschicken|schick)[.!?؟]*$/iu
/** Whether what they said so far sounds finished, unfinished, or neither. Pure, tested. */
export function endKind(t: string): 'done' | 'unfinished' | 'normal' {
  const s = t.trim()
  if (/[?؟!]$/.test(s) || SEND.test(s) || stopCommand(s)) return 'done'
  if (/[,،:;…-]$/.test(s) || CONNECTOR.test(s.replace(/[.،,]+$/, '')) || hesitationOnly(words(s).at(-1) ?? '')) return 'unfinished'
  if (!/[.!?؟]$/.test(s) && words(s).length <= 3) return 'unfinished'
  return 'normal'
}

/** Only hesitation sounds, no words. Pure, tested. */
export const hesitationOnly = (t: string) => {
  const w = words(t.replace(/[\u064B-\u0652\u0640]/g, ''))
  return w.length > 0 && w.every((x) => HESITATION.test(x))
}
const PAGE = /^<devdash-page\b[^<>]{0,600}\/>$/

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim()
/**
 * Marks a message as spoken (Hamasa answers in voice form), in the language they spoke, and, when they cut the last
 * reply off, the last thing they heard. Pure, tested.
 */
export const voiceTag = (lang: string, cutOffAfter?: string | null, expressions?: string[]) =>
  `<${VOICE_TAG} lang="${esc(lang)}"${expressions?.length ? ` expressions="${expressions.join(' ')}"` : ''}${cutOffAfter ? ` cut-off-after="${esc(stripExpressions(cutOffAfter)).slice(-160)}"` : ''}/>`

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
const text = (t: Token[]) => t.map((x) => x.text).join('')
/** The language most of the speech was in. */
function mainLanguage(t: Token[], fallback: string) {
  const n = new Map<string, number>()
  for (const x of t) if (x.language) n.set(x.language, (n.get(x.language) ?? 0) + x.text.trim().length)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
}

export function voiceConversation(o: {
  stt: SttProvider; sttKey: string; tts: TtsProvider; ttsKey: string
  /** The voice for a language (a member may give each language its own). */
  voice: (lang: string) => string | null
  languages: string[]
  chat: Chat; client: ToClient; mode: Mode
  /** Adds what was used; false when the month's cap is reached. */
  meter: (u: Usage) => boolean
  onEnd?: (reason: EndReason) => void
  /** How fast it talks (1 is the provider's normal). */
  speed?: number
  /** How long it waits after they stop talking before the words become a message. */
  endWait?: EndWait
  /** A coding session, not Hamasa: each spoken message carries the voice rules (Hamasa has them in its prompt). */
  coding?: boolean
  /** Says something while the answer is slow (a "let me check", "still on it"): off unless the member turns it on. */
  waitTalk?: boolean
  /** One line per turn: when each step happened, in ms after they stopped talking. Timings only, never what was said. */
  log?: (t: Record<string, unknown>) => void
  /** What happened, as it happens (states, pieces sent and heard, barge-ins, recoveries), for the diagnostics: never text. */
  event?: (kind: string, data?: Record<string, number | string | boolean>) => void
}) {
  let mode = o.mode
  let page = ''
  let ended = false
  let state: VoiceState | null = null
  const ev = (kind: string, data?: Record<string, number | string | boolean>) => o.event?.(kind, data)
  const set = (s: VoiceState) => { if (s !== state) { o.client.json({ type: 'state', state: (state = s) }); ev('state', { state: s }) } }

  // What they're saying.
  let heard: Token[] = []
  let partial: Token[] = []
  let lang = o.languages[0] ?? 'en'
  let pttDown = false
  let lastActivity = Date.now()
  let lastAudio = Date.now()
  let sttBytes = 0, meteredBytes = 0

  // Hamasa's answer to what they said.
  // Their messages Hamasa hasn't finished answering. A message while it works joins the running turn (like a typed one),
  // so this counts them; voice text is spoken whenever it streams in, never tied to one particular turn.
  let outstanding = 0
  const answering = () => outstanding > 0
  let deltas = false
  let lastText = ''
  let spoke = false
  let quiet = false // they cut it off: the rest of this answer stays in the chat
  let cutOff: string | null = null
  let extract = voiceExtractor()
  let chunk = sentenceChunker()
  let filler: ReturnType<typeof setTimeout> | undefined
  let fillers = 0
  let lastSaid = 0

  // Speaking: each piece is synthesized ahead (PREFETCH at a time) and sent in order; the browser says when each one
  // finished playing. Acknowledgements and fillers come ready-made (clips), so they play at once.
  type Piece = {
    id: number; text: string; lang: string; kind: 'answer' | 'ack' | 'filler'
    chunks: Uint8Array[]; done: boolean; started: boolean; failed?: Error; wake?: () => void; ac: AbortController
  }
  let gen = 0
  let nextId = 0
  const queue: Piece[] = []
  const said = new Map<number, Piece>() // sent, not played yet
  let pumping = false
  let lastPlayed: string | null = null // the last sentence of this answer they heard (acknowledgements don't count)
  let paused = false
  let resume: ReturnType<typeof setTimeout> | undefined
  const speaking = () => queue.length > 0 || said.size > 0

  // Ready-made audio for the short things said without the model: made once per conversation, in the background.
  const clips = new Map<string, Promise<Uint8Array[] | null>>()
  const clip = (text: string, l: string) => {
    if (!clips.has(text)) {
      clips.set(text, (async () => {
        const out: Uint8Array[] = []
        try {
          for await (const c of o.tts.speak(o.ttsKey, { text, voice: o.voice(l), lang: l, speed: o.speed, signal: AbortSignal.timeout(20_000) })) out.push(c)
          o.meter({ sttSeconds: 0, ttsChars: text.length, costUsd: o.tts.cost(text, out.reduce((n, c) => n + c.length, 0) / 2 / SAMPLE_RATE_OUT) })
          return out
        } catch { return null }
      })())
    }
    return clips.get(text)!
  }
  if (o.waitTalk) for (const l of o.languages) for (const t of [...(ACKS[l] ?? []), ...(FILLERS[l] ?? [])]) void clip(t, l)
  let lastAck = ''
  let ack: ReturnType<typeof setTimeout> | undefined
  let answerStarted = false // the real answer to their last message started: no acknowledgement any more
  const pick = (list: string[]) => {
    const choices = list.filter((x) => x !== lastAck)
    return (lastAck = choices[Math.floor(Math.random() * choices.length)] ?? list[0]!)
  }

  // Timings of the turn in progress (ms since they stopped talking).
  type Turn = Record<string, unknown> & { at: number; tts: number[]; ttfb: number[]; gaps: number[]; errors: string[] }
  const fresh = (): Turn => ({ at: 0, tts: [], ttfb: [], gaps: [], errors: [] })
  let T: Turn = fresh()
  let lastWordAt = 0
  const ms = () => Date.now() - T.at
  const mark = (k: string) => { if (T.at && T[k] === undefined) T[k] = ms() }
  function flushTimings() {
    if (!T.at || !o.log) return
    const { at: _at, ...t } = T
    o.log({ ...t, stateAfter: state })
    T = fresh()
  }

  const stt = o.stt.connect(o.sttKey, { languages: o.languages }, (e) => {
    if (ended) return
    if (e.type === 'tokens') return tokens(e.final, e.partial)
    if (e.type === 'endpoint') return void (mode === 'hands-free' && endpoint())
    if (e.type === 'finalized') return void (mode === 'ptt' && !pttDown && commit())
    o.client.json({ type: 'error', message: e.type === 'error' ? e.message : 'Speech recognition disconnected.' })
    end('error')
  })
  const unsubscribe = o.chat.onMessage((m) => { if (!ended) message(m) })

  // ---------- speaking ----------

  function say(raw: string, kind: Piece['kind'] = 'answer') {
    // [laughing]-style cues: acted out by a voice that can, never read out by one that can't.
    const t = o.tts.expressions ? keepExpressions(speakable(raw)) : stripExpressions(speakable(raw))
    if (!t || ended) return
    if (kind === 'answer') { answerStarted = true; clearTimeout(ack) }
    const l = isArabic(t) ? 'ar' : lang
    queue.push({ id: ++nextId, text: t, lang: l, kind, chunks: [], done: false, started: false, ac: new AbortController() })
    lastSaid = Date.now()
    fill()
    void pump()
  }
  /** Starts synthesis for the next pieces in line, up to PREFETCH at once. */
  function fill() {
    let busy = queue.filter((p) => p.started && !p.done).length
    for (const p of queue) {
      if (busy >= PREFETCH) break
      if (p.started) continue
      p.started = true
      busy++
      void synthesize(p, gen)
    }
  }
  async function synthesize(p: Piece, g: number) {
    const wake = () => { const w = p.wake; p.wake = undefined; w?.() }
    if (p.kind !== 'answer') {
      const ready = await clip(p.text, p.lang)
      if (ready) { p.chunks.push(...ready); p.done = true; wake(); return void fill() }
    }
    // Tried twice before giving up (a voice service hiccup shouldn't cost the reply), each within TTS_TIMEOUT_MS.
    for (let attempt = 1; attempt <= 2 && g === gen && !ended; attempt++) {
      p.chunks = []
      p.failed = undefined
      const sent = Date.now()
      if (T.at) T.tts.push(ms())
      let first = true
      try {
        const signal = AbortSignal.any([p.ac.signal, AbortSignal.timeout(TTS_TIMEOUT_MS)])
        for await (const c of o.tts.speak(o.ttsKey, { text: p.text, voice: o.voice(p.lang), lang: p.lang, speed: o.speed, signal })) {
          if (g !== gen || ended) break
          if (first && T.at) { T.ttfb.push(Date.now() - sent); first = false }
          p.chunks.push(c)
        }
      } catch (err) {
        if (p.ac.signal.aborted) break
        const e = err as Error
        p.failed = e.name === 'TimeoutError' ? new Error('the voice service didn\'t answer in time') : e
        ev('tts_failed', { attempt, kind: p.kind })
        if (T.at) T.errors.push(`tts:${attempt}`)
        continue
      }
      if (!p.chunks.length && !p.ac.signal.aborted) { p.failed = new Error('the voice service sent no audio'); if (T.at) T.errors.push(`empty:${attempt}`); continue }
      break
    }
    const bytes = p.chunks.reduce((n, c) => n + c.length, 0)
    // Whole now: without the silence the TTS put around it, so pieces follow each other like one voice.
    if (!p.failed && bytes) { const all = Buffer.concat(p.chunks); p.chunks = [trimSilence(all.subarray(0, all.length - (all.length % 2)))] }
    p.done = true
    wake()
    if (!o.meter({ sttSeconds: 0, ttsChars: p.text.length, costUsd: o.tts.cost(p.text, bytes / 2 / SAMPLE_RATE_OUT) })) end('cap')
    fill()
  }
  /** Sends the head piece's audio as it arrives, then the next one's (already synthesized, or on its way). */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && !ended) {
        const p = queue[0]!
        const g = gen
        set('speaking')
        if (p.kind === 'answer') mark('firstVoiceSent')
        stt.agentText(stripExpressions(p.text), true)
        // A sentence goes out whole, the way a preview plays: streamed piece by piece, a TTS that generates slower than
        // real time leaves the speaker waiting between words. The next sentences are synthesized meanwhile (fill).
        while (!p.done && g === gen && !ended) await new Promise<void>((r) => { p.wake = r })
        let i = 0
        let odd: number | null = null // PCM samples are two bytes: never split one between frames
        for (;;) {
          if (g !== gen || ended) break
          if (i < p.chunks.length) {
            const c = p.chunks[i++]!
            let b: Uint8Array = odd === null ? c : Buffer.concat([Buffer.of(odd), c])
            odd = b.length % 2 ? b[b.length - 1]! : null
            if (odd !== null) b = b.subarray(0, b.length - 1)
            if (b.length) { mark('firstAudio'); if (p.kind === 'answer') mark('firstAnswerAudio'); o.client.audio(g, b) }
            continue
          }
          if (p.done) break
          await new Promise<void>((r) => { p.wake = r })
        }
        if (g !== gen || ended) continue // flushed: the queue was cleared with it
        queue.shift()
        if (p.failed) o.client.json({ type: 'error', message: `Couldn't speak this reply: ${p.failed.message.replace(/^[^:]{1,20}: /, '')}` })
        else {
          said.set(p.id, p)
          o.client.json({ type: 'mark', id: p.id, text: stripExpressions(p.text) })
          ev('sent', { id: p.id, kind: p.kind, ms: Math.round(duration(p)) })
          if (T.at) T.pieces = ((T.pieces as number | undefined) ?? 0) + 1
          watch(p)
        }
      }
    } finally {
      pumping = false
    }
    if (!speaking()) quietAgain()
  }
  const duration = (p: Piece) => (p.chunks.reduce((n, c) => n + c.length, 0) / 2 / SAMPLE_RATE_OUT) * 1000
  // When the browser should have played what's been sent: if it says nothing by then (plus STUCK_MS), its player is
  // stuck (a pause left on, a suspended context): reset it and send the unheard pieces again. Never silence.
  let playUntil = 0
  let recoveries = 0
  function watch(p: Piece) {
    playUntil = Math.max(playUntil, Date.now()) + duration(p)
    const g = gen
    later(() => {
      if (ended || g !== gen || !said.has(p.id)) return
      if (recoveries >= 2) {
        // Still not heard: say so where they look, instead of going quiet. The next reply tries again from scratch.
        ev('stuck_gave_up', { id: p.id })
        if (T.at) T.errors.push('player_stuck')
        said.delete(p.id)
        o.client.json({ type: 'error', message: 'Couldn\'t play this reply: the speaker didn\'t start. It\'s in the chat; end voice mode and start it again if it keeps happening.' })
        if (!speaking()) quietAgain()
        return
      }
      recoveries++
      ev('stuck', { id: p.id, unheard: said.size })
      if (T.at) T.errors.push('stuck')
      const again = [...said.values()].map((x) => ({ ...x, id: ++nextId, ac: new AbortController(), started: true, done: true }))
      gen++
      said.clear()
      o.client.json({ type: 'flush', gen })
      queue.unshift(...again)
      playUntil = 0
      void pump()
    }, playUntil - Date.now() + STUCK_MS)
  }

  /** Nothing left to say: back to listening, or to waiting for the rest of the answer. */
  function quietAgain() {
    if (ended) return
    if (!answering() && T.turnEnd !== undefined) { mark('speechEnd'); flushTimings() }
    lastActivity = Date.now()
    set(!answering() ? 'listening' : state === 'working' || filler ? 'working' : 'thinking')
  }
  function stopSpeaking() {
    ev('flush', { unsent: queue.length, unheard: said.size })
    gen++
    for (const p of queue) { p.ac.abort(); p.wake?.() }
    queue.length = 0
    said.clear()
    paused = false
    clearTimeout(resume)
    o.client.json({ type: 'flush', gen })
  }
  /** They talked over the reply: it stops, and the rest of this answer is only written. */
  function bargeIn() {
    if (!speaking()) return
    ev('barge_in', { answering: answering() })
    cutOff = lastPlayed // null when nothing of this answer was heard yet
    if (answering()) quiet = true // the rest of this answer is only written; the work itself carries on
    stopSpeaking()
  }

  // ---------- listening ----------

  function tokens(final: Token[], next: Token[]) {
    if (final.some((t) => t.text.trim())) lastWordAt = Date.now()
    heard.push(...final)
    partial = next
    const now = text([...heard, ...partial])
    if (!now.trim()) return
    lastActivity = Date.now()
    if (speaking() && mode === 'hands-free') {
      // Its own voice coming back through the mic isn't them: only words it isn't saying count.
      const echo = new Set(words([...queue.map((p) => p.text), ...[...said.values()].map((p) => p.text), lastPlayed ?? ''].join(' ')))
      const mine = words(now).filter((w) => !echo.has(w))
      if (!mine.length) { heard = []; partial = []; return }
      // "أمم" or "ähm" while it talks: not an interruption; it waits to join what they say next.
      const theirs = mine.filter((w) => !hesitationOnly(w))
      if (!theirs.length) return
      keepHolding()
      o.client.json({ type: 'transcript', text: now })
      // Two words of their own: an interruption. One: hold the reply a moment (LiveKit's false-interruption pause).
      if (theirs.length >= 2) return bargeIn()
      if (!paused) { paused = true; o.client.json({ type: 'pause' }); ev('pause') }
      clearTimeout(resume)
      resume = setTimeout(() => {
        if (!paused || ended) return
        paused = false
        heard = []; partial = []
        o.client.json({ type: 'resume' })
        ev('resume')
        o.client.json({ type: 'transcript', text: '' })
      }, FALSE_BARGE_MS)
      return
    }
    if (final.length || next.length) keepHolding()
    o.client.json({ type: 'transcript', text: now })
    if (!answering() || state === 'listening') set('hearing')
  }

  // ---------- the end of what they said ----------

  let hold: ReturnType<typeof setTimeout> | undefined
  /** Soniox thinks they stopped: wait a moment longer (from their last word) before it's a message. */
  function endpoint() {
    const said = text([...heard, ...partial]).trim()
    if (!said) return commit()
    const kind = endKind(said)
    const wait = END_WAITS[o.endWait ?? 'normal'][kind]
    const left = Math.max(0, (lastWordAt || Date.now()) + wait - Date.now())
    clearTimeout(hold)
    if (kind === 'done' && stopCommand(said)) return commit() // "stop" never waits
    ev('hold', { kind, ms: left })
    o.client.json({ type: 'holding', ms: left })
    hold = later(() => { hold = undefined; commit() }, left)
  }
  /** Their words arrive during the hold: it's the same message, still going. */
  const keepHolding = () => {
    if (!hold) return
    clearTimeout(hold)
    hold = undefined
    o.client.json({ type: 'holding', ms: 0 })
  }

  /** They finished a sentence (hands-free) or let go of the button (push-to-talk): it goes to the chat. */
  function commit() {
    clearTimeout(hold)
    hold = undefined
    const all = [...heard, ...partial]
    const utterance = text(all).trim()
    if (hesitationOnly(utterance)) {
      // Just "أمم": they're still thinking. Nothing is sent or stopped; it joins their next words.
      heard = all; partial = []
      return
    }
    heard = []; partial = []
    if (!utterance) {
      if (!speaking()) quietAgain()
      return
    }
    // "…, send": the word that sent it isn't part of the message.
    const message = utterance.replace(SEND, '').replace(/[\s،,]+$/, '').trim() || utterance
    flushTimings()
    T = { ...fresh(), at: Date.now(), endpointDelay: lastWordAt ? Date.now() - lastWordAt : null, stateBefore: state, voiceChars: 0, pieces: 0, pageChanges: 0 }
    recoveries = 0
    bargeIn() // a whole sentence while it speaks is an interruption, even a one-word "stop"
    lang = mainLanguage(all, lang)
    void deliver(message)
  }

  async function deliver(utterance: string) {
    const tag = voiceTag(lang, cutOff, o.tts.expressions ? EXPRESSIONS : undefined)
    cutOff = null
    lastPlayed = null // a cut-off from now on is into the answer to this message, not an older one
    set('thinking')
    o.client.json({ type: 'utterance', text: utterance })
    // Only an explicit "stop" cancels the work, like the stop button. Anything else joins the running turn.
    if (stopCommand(utterance)) {
      if (answering()) await o.chat.interrupt().catch(() => {})
      mark('stopped')
      return quietAgain()
    }
    // The model often thinks 8–14 s before its first word: if its answer hasn't started ACK_MS after they stopped,
    // a short "let me check" (never after "hello" or "thanks", which the answer itself handles).
    clearTimeout(ack)
    if (o.waitTalk && !socialTurn(utterance)) {
      const since = T.at ? Date.now() - T.at : 0
      ack = later(() => {
        if (ended || !answering() || answerStarted || quiet) return
        say(pick(ACKS[lang] ?? ACKS.en!), 'ack')
        mark('ack')
      }, Math.max(0, ACK_MS - since))
    }
    answerStarted = false
    outstanding++
    quiet = false
    spoke = false
    lastText = ''
    fillers = 0
    try {
      await o.chat.send(o.coding ? `${tag}\n${CODING_VOICE}\n\n${utterance}` : `${page ? `${page}\n` : ''}${tag}\n\n${utterance}`)
      mark('sent')
      ev('message', { answering: outstanding > 1, cutOff: tag.includes('cut-off-after') })
      if (o.waitTalk) stillOnIt(STILL_MS)
    } catch (err) {
      outstanding = Math.max(0, outstanding - 1)
      o.client.json({ type: 'error', message: (err as Error).message })
      quietAgain()
    }
  }

  // ---------- the answer ----------

  function message(m: Raw) {
    if (m.parent_tool_use_id) return
    if (m.type === 'stream_event' || m.type === 'assistant') mark('firstToken')
    if (m.type === 'stream_event') {
      const e = m.event
      if (e?.type === 'message_start') { extract.reset(); deltas = false }
      else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') toolStarted()
      else if (e?.delta?.type === 'text_delta') {
        deltas = true
        const was = extract.inside
        spoken(extract.feed(e.delta.text ?? ''))
        // The block closed in this delta (maybe with no new words): what's left of it goes now, not when the whole
        // message has landed.
        if (was && !extract.inside && !quiet) for (const x of chunk.flush()) say(x)
      }
      return
    }
    if (m.type === 'assistant') {
      const blocks = Array.isArray(m.message?.content) ? (m.message.content as { type?: string; text?: string }[]) : []
      const t = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (t.trim()) lastText = t
      // An agent that doesn't stream (or a message that came whole) is read from the message itself.
      if (!deltas && t) { extract.reset(); spoken(extract.feed(t)) }
      deltas = false
      for (const s of chunk.flush()) if (!quiet) say(s)
      if (blocks.some((b) => b.type === 'tool_use')) toolStarted()
      return
    }
    if (m.type === 'result') turnDone(m)
  }
  function spoken(t: string) {
    if (!t) return
    if (T.firstVoiceText === undefined) ev('voice_text', { quiet })
    mark('firstVoiceText')
    if (T.at) T.voiceChars = (T.voiceChars as number) + t.length
    spoke = true
    if (quiet) return
    for (const s of chunk.push(t)) say(s)
    if (!extract.inside) for (const s of chunk.flush()) say(s)
  }
  function toolStarted() {
    mark('firstTool')
    for (const s of chunk.flush()) if (!quiet) say(s)
    if (!speaking()) set('working')
    if (o.waitTalk) stillOnIt(FILLER_MS)
  }
  /** Says it's still on it when nothing was said for `wait` ms while the answer is still coming (twice at most). */
  function stillOnIt(wait: number) {
    clearTimeout(filler)
    filler = setTimeout(function tick() {
      filler = undefined
      if (!answering() || ended || quiet) return
      const left = wait - (Date.now() - lastSaid)
      if (speaking() || partial.length || left > 0) return void (filler = later(tick, Math.max(left, 500)))
      const f = FILLERS[lang] ?? FILLERS.en!
      if (fillers < f.length) say(f[fillers++]!, 'filler')
      if (fillers < f.length) filler = later(tick, 12_000)
    }, wait)
    filler.unref?.()
  }
  const later = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t }
  function turnDone(m: Raw) {
    ev('result', { aborted: !!m.terminal_reason?.startsWith('aborted'), spoke })
    // One result can answer several of their messages (the ones sent while it worked joined that turn).
    const was = outstanding
    outstanding = 0
    clearTimeout(filler)
    filler = undefined
    const aborted = !!m.terminal_reason?.startsWith('aborted')
    if (!quiet && !aborted) {
      for (const s of chunk.flush()) say(s)
      // It forgot to say anything: the start of what it wrote, so a spoken question never goes unanswered.
      if (!spoke && was) {
        const f = fallbackSpeech(typeof m.result === 'string' && m.result.trim() ? m.result : lastText)
        if (f) say(f)
      }
    }
    mark('turnEnd')
    if (!speaking()) quietAgain()
  }

  // ---------- housekeeping ----------

  const tick = setInterval(() => {
    if (ended) return
    if (Date.now() - lastAudio > KEEPALIVE_MS) stt.keepalive()
    meterAudio()
    if (mode === 'hands-free' && !answering() && !speaking() && Date.now() - lastActivity > IDLE_MS) end('idle')
  }, TICK_MS)
  tick.unref?.() // a conversation never keeps the server (or a test) running by itself
  function meterAudio() {
    const s = (sttBytes - meteredBytes) / 2 / SAMPLE_RATE_IN
    meteredBytes = sttBytes
    // Billed from the moment it connects, silence too: the time it was open is what counts.
    if (s > 0 && !o.meter({ sttSeconds: s, ttsChars: 0, costUsd: (s / 60) * o.stt.perMinute })) end('cap')
  }
  function end(reason: EndReason) {
    if (ended) return
    meterAudio()
    ended = true
    clearInterval(tick)
    clearTimeout(filler)
    clearTimeout(resume)
    clearTimeout(ack)
    clearTimeout(hold)
    for (const p of queue) p.ac.abort()
    flushTimings()
    stt.close()
    unsubscribe()
    o.client.json({ type: 'ended', reason })
    o.onEnd?.(reason)
  }

  set('listening')
  return {
    /** Mic audio from the browser: 16 kHz mono PCM. */
    audio(pcm: Buffer) {
      if (ended || (mode === 'ptt' && !pttDown)) return
      lastAudio = Date.now()
      sttBytes += pcm.length
      stt.audio(pcm)
    },
    /** A control message from the browser. Anything else is ignored. */
    control(m: Record<string, unknown>) {
      if (ended) return
      if (m.type === 'page' && typeof m.page === 'string') {
        const next = PAGE.test(m.page) ? m.page : ''
        if (next !== page && T.at) T.pageChanges = ((T.pageChanges as number | undefined) ?? 0) + 1
        page = next
      }
      else if (m.type === 'mode' && (m.mode === 'hands-free' || m.mode === 'ptt')) {
        mode = m.mode
        pttDown = false
      } else if (m.type === 'ptt' && mode === 'ptt') {
        if (m.down === true) {
          pttDown = true
          bargeIn()
          set('hearing')
        } else if (pttDown) {
          pttDown = false
          stt.finalize()
        }
      } else if (m.type === 'played' && typeof m.id === 'number') {
        const p = said.get(m.id)
        if (p === undefined) return
        said.delete(m.id)
        recoveries = 0
        if (T.at) T.playEnd = ms()
        ev('played', { id: m.id })
        if (p.kind === 'answer') lastPlayed = p.text
        if (!speaking()) quietAgain()
      } else if (m.type === 'playing' && typeof m.idleMs === 'number') {
        // The speaker started again after idling: the first time this turn is when they heard something; later ones
        // while it's still talking are gaps.
        if (T.at && T.playStart === undefined) T.playStart = ms()
        else if (T.at && speaking() && m.idleMs > 0) T.gaps.push(Math.round(m.idleMs))
        ev('playing', { idleMs: Math.round(m.idleMs) })
      } else if (m.type === 'underrun') {
        if (T.at) T.underruns = ((T.underruns as number | undefined) ?? 0) + 1
        ev('underrun')
      } else if (m.type === 'events' && Array.isArray(m.list)) {
        // The browser's own events (its states, playback, dropped audio): numbers and short names only.
        for (const x of m.list.slice(0, 100) as Record<string, unknown>[]) {
          if (typeof x?.kind !== 'string' || x.kind.length > 40) continue
          const data: Record<string, number | string | boolean> = { at: typeof x.at === 'number' ? x.at : 0 }
          for (const [k, v] of Object.entries(x)) if (k !== 'kind' && k.length <= 20 && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 40))) data[k] = v
          ev(`client:${x.kind}`, data)
        }
      } else if (m.type === 'send') { if (hold) commit() }
      else if (m.type === 'interrupt') bargeIn()
      else if (m.type === 'stop') end('stopped')
    },
    /** The session asks them something: say so briefly; the rest is on screen and waits for them. */
    headsUp(kind: 'permission' | 'question') {
      if (ended) return
      ev('heads_up', { kind })
      say(HEADS_UP[kind][lang] ?? HEADS_UP[kind].en!)
    },
    end,
    get state() { return state },
    get ended() { return ended },
  }
}
export type VoiceConversation = ReturnType<typeof voiceConversation>
