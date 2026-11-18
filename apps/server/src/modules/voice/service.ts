// Voice mode for each member's personal agent: their settings, their own provider keys (sealed with the server's master
// key, shown again only as their last four characters), what it costs, and the live conversations. It runs in the
// DevDash server, not in the member's account: the keys never reach their home folder, where any session they run (or
// share) could read them.
import type { WebSocket } from 'ws'
import { seal, unseal } from '../../core/crypto.ts'
import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'
import type { AssistantService } from '../assistant/service.ts'
import type { ClaudeService } from '../claude/service.ts'
import { END_WAITS, voiceConversation, type EndWait, type Mode, type Raw, type Usage, type VoiceConversation } from './pipeline.ts'
import { stripExpressions } from './speech.ts'
import { KEYED, pcmToWav, redact, SAMPLE_RATE_OUT, STT, TTS, type SttProvider, type TtsProvider } from './providers.ts'

type Row = {
  user_id: number; enabled: number; stt: string; tts: string; voices: string; voice_per_language: number; languages: string; monthly_cap_usd: number | null; speed: number; wait_talk: number; end_wait: string
}
export type VoicePatch = { enabled?: boolean; stt?: string; tts?: string; perLanguage?: boolean; languages?: string[]; monthlyCapUsd?: number | null; speed?: number; waitTalk?: boolean; endWait?: string }
/** A chosen voice: its id for the provider, its name for people. */
export type Picked = { id: string; name: string }

/** A longer, natural paragraph per language: to judge the voice itself, apart from how replies are cut. */
export const PARAGRAPHS: Record<string, string> = {
  ar: '[chuckling] صباح الفل يا باشا، بص أنا بصيت على الشغل بتاع النهارده ولقيت إن الـ deploy بتاع الـ shop خلص من حوالي ساعة وكله شغال تمام، وفي session واحدة بس مستنياك توافق على حاجة صغيرة، فلما تفضى قولي وأنا أكمل معاك على طول.',
  en: '[chuckling] Morning! I went through today\'s work and the shop deploy finished about an hour ago with everything running fine, and there\'s just one session waiting for you to approve a small change, so whenever you have a minute just tell me and we\'ll pick it up from there.',
  de: '[chuckling] Guten Morgen! Ich habe mir die Arbeit von heute angeschaut, das Deployment vom Shop ist vor etwa einer Stunde fertig geworden und alles läuft, und es wartet nur eine Session auf deine Freigabe, also sag einfach Bescheid, wenn du kurz Zeit hast.',
}
/** What a preview says, in each language (others hear the English one). */
export const SAMPLES: Record<string, string> = {
  ar: 'أهلاً، أنا حماسة. قولّي محتاج إيه النهارده وأنا أظبطهولك.',
  en: 'Hi, I\'m Hamasa. Tell me what you need today and I\'ll take care of it.',
  de: 'Hallo, ich bin Hamasa. Sag mir, was du heute brauchst, und ich kümmere mich darum.',
}

/** Languages to offer (Soniox recognises 60+; these are the hints it gets). */
export const LANGUAGES = ['ar', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'hi', 'ur', 'fa', 'zh', 'ja', 'ko']
const KEY_RE = /^[\x21-\x7e]{8,512}$/
/** How a saved key is shown: its last four characters. Pure, tested. */
export const maskKey = (hint: string) => `••••${hint}`
/** About how much of a conversation Hamasa is talking, for the estimate before there's any history. */
const SPOKEN_SHARE = 0.3
const CHARS_PER_SECOND = 15

const monthStart = (now = new Date()) => Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)

export function voiceService({ db, masterKey, claude, assistant, stt = STT, tts = TTS }: {
  db: Db; masterKey: Buffer; claude: ClaudeService; assistant: AssistantService
  /** The providers (tests swap in fakes). */
  stt?: Record<string, SttProvider>; tts?: Record<string, TtsProvider>
}) {
  const q = {
    get: db.prepare('select * from voice_settings where user_id = ?'),
    ensure: db.prepare('insert into voice_settings (user_id) values (?) on conflict (user_id) do nothing'),
    put: db.prepare(`update voice_settings set enabled = ?, stt = ?, tts = ?, voice_per_language = ?, languages = ?, monthly_cap_usd = ?, speed = ?, wait_talk = ?, end_wait = ?, updated_at = unixepoch()
      where user_id = ?`),
    putVoices: db.prepare('update voice_settings set voices = ?, updated_at = unixepoch() where user_id = ?'),
    keys: db.prepare('select provider, hint, updated_at from voice_keys where user_id = ?'),
    key: db.prepare('select sealed from voice_keys where user_id = ? and provider = ?'),
    putKey: db.prepare(`insert into voice_keys (user_id, provider, sealed, hint) values (?1, ?2, ?3, ?4)
      on conflict (user_id, provider) do update set sealed = ?3, hint = ?4, updated_at = unixepoch()`),
    dropKey: db.prepare('delete from voice_keys where user_id = ? and provider = ?'),
    month: db.prepare(`select count(*) as n, coalesce(sum(cost_usd), 0) as usd, coalesce(sum(stt_seconds), 0) as seconds
      from voice_calls where user_id = ? and started_at >= ?`),
    call: db.prepare('insert into voice_calls (user_id, stt, tts) values (?, ?, ?) returning id'),
    event: db.prepare('insert into voice_events (call_id, user_id, at, kind, data) values (?, ?, ?, ?, ?)'),
    prune: db.prepare('delete from voice_events where at < ?'),
    events: db.prepare('select call_id as call, at, kind, data from voice_events where user_id = ? and at >= ? order by id'),
    used: db.prepare('update voice_calls set stt_seconds = stt_seconds + ?, tts_chars = tts_chars + ?, cost_usd = cost_usd + ?, ended_at = unixepoch() where id = ?'),
  }
  const aad = (userId: number, provider: string) => `voice-key:${userId}:${provider}`
  const row = (userId: number) => {
    q.ensure.run(userId)
    return q.get.get(userId) as Row
  }
  const secret = (userId: number, provider: string) => {
    const r = q.key.get(userId, provider) as { sealed: string } | undefined
    return r ? unseal(masterKey, r.sealed, aad(userId, provider)).toString('utf8') : null
  }
  const live = new Map<number, VoiceConversation>()
  const voicesOf = (s: Row) => JSON.parse(s.voices) as Record<string, Picked | undefined>
  /** The voice it speaks a language in: that language's own when they set one (and asked for that), else theirs. */
  function voiceFor(s: Row, lang?: string): Picked | null {
    const v = voicesOf(s)
    const own = s.voice_per_language && lang ? v[`${s.tts}:${lang}`] : undefined
    const d = tts[s.tts]?.defaultVoice
    return own ?? v[s.tts] ?? (d ? { id: d, name: tts[s.tts]!.voices?.find((x) => x.id === d)?.label ?? d } : null)
  }
  const ttsKey = (user: User, s: Row) => {
    const k = secret(user.id, s.tts)
    if (!k) throw new AppError(409, 'no_key', `Add your ${tts[s.tts]?.label ?? s.tts} key first.`)
    return k
  }

  /** What a minute costs: STT for all of it, TTS for the part Hamasa talks. */
  function perMinute(s: Row) {
    const t = tts[s.tts], r = stt[s.stt]
    if (!t || !r) return 0
    const seconds = 60 * SPOKEN_SHARE
    const sample = 'x'.repeat(seconds * CHARS_PER_SECOND * (JSON.parse(s.languages).includes('ar') ? 1.5 : 1)) // Arabic is two bytes a letter for byte-priced TTS: half its speech on average
    return r.perMinute + t.cost(sample, seconds)
  }
  function usage(userId: number, s: Row) {
    const m = q.month.get(userId, monthStart()) as { n: number; usd: number; seconds: number }
    const now = new Date()
    const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
    const elapsed = Math.max(1, (Date.now() / 1000 - monthStart()) / 86_400)
    return {
      monthUsd: m.usd, monthMinutes: m.seconds / 60, conversations: m.n,
      perMinuteUsd: perMinute(s),
      // Their own average once they've talked a bit, else a ten-minute conversation at the estimate.
      perConversationUsd: m.n >= 3 ? m.usd / m.n : perMinute(s) * 10,
      projectedMonthUsd: m.n ? (m.usd / elapsed) * days : null,
    }
  }

  function state(user: User) {
    const s = row(user.id)
    const keys = Object.fromEntries(KEYED.map((p) => [p, null as string | null]))
    for (const k of q.keys.all(user.id) as { provider: string; hint: string }[]) keys[k.provider] = maskKey(k.hint)
    const u = usage(user.id, s)
    const languages = JSON.parse(s.languages) as string[]
    const voice = voiceFor(s)
    return {
      enabled: !!s.enabled, stt: s.stt, tts: s.tts, voice, perLanguage: !!s.voice_per_language,
      // Each language's own voice, when they set one (used only with perLanguage).
      languageVoices: Object.fromEntries(languages.map((l) => [l, voicesOf(s)[`${s.tts}:${l}`] ?? null])),
      languages, monthlyCapUsd: s.monthly_cap_usd, speed: s.speed, waitTalk: !!s.wait_talk, endWait: s.end_wait as EndWait,
      keys,
      // Ready to talk: on, with keys for both of its providers, a voice, and under its cap.
      missing: [...[s.stt, s.tts].filter((p) => !keys[p]), ...(voice ? [] : ['voice'])],
      overCap: s.monthly_cap_usd != null && u.monthUsd >= s.monthly_cap_usd,
      usage: u,
      providers: {
        stt: Object.values(stt).map((p) => ({ id: p.id, label: p.label })),
        tts: Object.values(tts).map((p) => ({ id: p.id, label: p.label, voices: p.voices, library: !!p.library, defaultVoice: p.defaultVoice, note: p.note ?? null })),
      },
      languageChoices: LANGUAGES,
    }
  }
  const provider = (id: string) => {
    if (!KEYED.includes(id)) throw new AppError(404, 'not_found', 'Unknown provider.')
    return id
  }
  const check = (id: string, key: string) => (stt[id] ?? tts[id])!.check(key)

  return {
    state,

    update(user: User, p: VoicePatch) {
      const s = row(user.id)
      if (p.stt !== undefined && !stt[p.stt]) throw new AppError(400, 'bad_provider', 'Unknown speech recognition provider.')
      if (p.tts !== undefined && !tts[p.tts]) throw new AppError(400, 'bad_provider', 'Unknown voice provider.')
      const ttsId = p.tts ?? s.tts
      const perLanguage = p.perLanguage === undefined ? s.voice_per_language : p.perLanguage ? 1 : 0
      const languages = p.languages === undefined ? JSON.parse(s.languages) as string[] : [...new Set(p.languages.filter((l) => LANGUAGES.includes(l)))]
      if (!languages.length) throw new AppError(400, 'bad_languages', 'Pick at least one language you speak.')
      const cap = p.monthlyCapUsd === undefined ? s.monthly_cap_usd : p.monthlyCapUsd
      if (cap != null && (!Number.isFinite(cap) || cap < 0 || cap > 10_000)) throw new AppError(400, 'bad_cap', 'The cap is a number of dollars.')
      const endWait = p.endWait ?? s.end_wait
      if (!(endWait in END_WAITS)) throw new AppError(400, 'bad_wait', 'Quick, normal or patient.')
      const speed = p.speed === undefined ? s.speed : p.speed
      if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.5) throw new AppError(400, 'bad_speed', 'Speed is between 0.7 and 1.5.')
      q.put.run(p.enabled === undefined ? s.enabled : p.enabled ? 1 : 0, p.stt ?? s.stt, ttsId, perLanguage, JSON.stringify(languages), cap, speed, p.waitTalk === undefined ? s.wait_talk : p.waitTalk ? 1 : 0, endWait, user.id)
      return state(user)
    },

    /**
     * Picks the voice (or, with `language`, that language's own): an id from the provider's list, or for a library
     * provider an id or a link to the voice's page, looked up there for its name. null clears it.
     */
    async setVoice(user: User, p: { voice: string | null; language?: string }) {
      const s = row(user.id)
      const t = tts[s.tts]!
      if (p.language !== undefined && !LANGUAGES.includes(p.language)) throw new AppError(400, 'bad_language', 'Unknown language.')
      const slot = p.language ? `${s.tts}:${p.language}` : s.tts
      const voices = voicesOf(s)
      if (p.voice === null) delete voices[slot]
      else if (t.voices) {
        const v = t.voices.find((x) => x.id === p.voice)
        if (!v) throw new AppError(400, 'bad_voice', 'Unknown voice.')
        voices[slot] = { id: v.id, name: v.label }
      } else {
        const id = t.library?.idOf(p.voice)
        if (!id) throw new AppError(400, 'bad_voice', `That isn't a ${t.label} voice id or link.`)
        const key = ttsKey(user, s)
        try {
          const v = await t.library!.get(key, id)
          voices[slot] = { id: v.id, name: v.name.slice(0, 80) }
        } catch (err) {
          throw new AppError(400, 'bad_voice', redact((err as Error).message, key))
        }
      }
      q.putVoices.run(JSON.stringify(voices), user.id)
      return state(user)
    },

    /** Searches the voice provider's library with their key: most used first, optionally in one language. */
    async searchVoices(user: User, o: { q?: string; language?: string; page?: number }) {
      const s = row(user.id)
      const t = tts[s.tts]!
      if (!t.library) throw new AppError(400, 'no_library', `${t.label} has a fixed list of voices.`)
      const key = ttsKey(user, s)
      // An id or a link to a voice's page in the search box: that voice, looked up directly, or why not.
      const id = o.q ? t.library.idOf(o.q) : null
      if (id) {
        try {
          return { items: [await t.library.get(key, id)], total: 1, notice: null as string | null }
        } catch (err) {
          const e = err as Error & { status?: number }
          const notice = e.status === 404 ? `No ${t.label} voice has the id ${id}.`
            : e.status === 403 ? `That voice (${id}) is private, or your ${t.label} key can't use it.`
            : redact(e.message, key)
          return { items: [], total: 0, notice }
        }
      }
      try {
        return { ...(await t.library.search(key, o)), notice: null as string | null }
      } catch (err) {
        throw new AppError(400, 'provider', redact((err as Error).message, key))
      }
    },

    /**
     * A short sample in one language, in a voice (one from the library they're trying, or the one they picked), with
     * their key: a WAV file. It costs a fraction of a cent and counts toward their month.
     */
    async preview(user: User, p: { voice?: string; language: string; long?: boolean }) {
      const s = row(user.id)
      const t = tts[s.tts]!
      const key = ttsKey(user, s)
      const voice = p.voice ? (t.voices ? t.voices.find((x) => x.id === p.voice)?.id : t.library?.idOf(p.voice)) : voiceFor(s, p.language)?.id
      if (p.voice && !voice) throw new AppError(400, 'bad_voice', 'Unknown voice.')
      const raw = (p.long ? PARAGRAPHS[p.language] ?? PARAGRAPHS.en : SAMPLES[p.language] ?? SAMPLES.en)!
      const text = t.expressions ? raw : stripExpressions(raw)
      const chunks: Uint8Array[] = []
      try {
        for await (const c of t.speak(key, { text, voice: voice ?? null, lang: p.language, speed: s.speed, signal: AbortSignal.timeout(30_000) })) chunks.push(c)
      } catch (err) {
        throw new AppError(400, 'provider', redact((err as Error).message, key))
      }
      const pcm = Buffer.concat(chunks)
      const { id } = q.call.get(user.id, s.stt, s.tts) as { id: number }
      q.used.run(0, text.length, t.cost(text, pcm.length / 2 / SAMPLE_RATE_OUT), id)
      return pcmToWav(pcm.subarray(0, pcm.length - (pcm.length % 2)))
    },

    /** Saves a key after checking it with the provider (a free call), so a typo shows up now, not mid-sentence. */
    async setKey(user: User, id: string, raw: string) {
      provider(id)
      const key = raw.trim()
      if (!KEY_RE.test(key)) throw new AppError(400, 'bad_key', 'That doesn\'t look like an API key.')
      try {
        await check(id, key)
      } catch (err) {
        throw new AppError(400, 'key_refused', redact((err as Error).message, key))
      }
      q.putKey.run(user.id, id, seal(masterKey, Buffer.from(key), aad(user.id, id)), key.slice(-4))
      return state(user)
    },
    removeKey(user: User, id: string) {
      q.dropKey.run(user.id, provider(id))
      return state(user)
    },
    /** Tries a saved key again (it may have run out of credit since). */
    async checkKey(user: User, id: string) {
      const key = secret(user.id, provider(id))
      if (!key) throw new AppError(404, 'no_key', 'No key saved.')
      try {
        await check(id, key)
      } catch (err) {
        throw new AppError(400, 'key_refused', redact((err as Error).message, key))
      }
      return { ok: true }
    },

    /** Before the WebSocket upgrade: whether this member can start talking now. */
    ready(user: User) {
      const st = state(user)
      if (!st.enabled) throw new AppError(409, 'voice_off', 'Turn on voice mode in Hamasa\'s settings first.')
      if (st.missing.some((m) => m !== 'voice')) throw new AppError(409, 'no_key', 'Add your voice provider keys in Hamasa\'s settings first.')
      if (st.missing.includes('voice')) throw new AppError(409, 'no_voice', 'Pick a voice in Hamasa\'s voice settings first.')
      if (st.overCap) throw new AppError(409, 'over_cap', 'This month\'s voice cap is reached.')
    },

    /** A voice conversation on this socket, in the member's chat with Hamasa. One per member: a new one ends the last. */
    async talk(user: User, ws: WebSocket, mode: Mode, sessionId: string | null = null) {
      const send = (m: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
      let closed = false
      ws.on('close', () => { closed = true })
      let s: Row, chat: string, sttKey: string | null, ttsKey: string | null, coding = false
      try {
        this.ready(user)
        s = row(user.id)
        sttKey = secret(user.id, s.stt)
        ttsKey = secret(user.id, s.tts)
        // One of their own sessions, or (by default) their chat with Hamasa.
        coding = !!sessionId && !claude.voiceAccess(user, sessionId).assistant
        chat = sessionId ?? await assistant.current(user)
      } catch (err) {
        send({ type: 'error', message: (err as Error).message })
        send({ type: 'ended', reason: 'error' })
        return ws.close(1000)
      }
      live.get(user.id)?.end('closed')
      const { id: call } = q.call.get(user.id, s.stt, s.tts) as { id: number }
      q.prune.run(Date.now() - 86_400_000) // kept a day
      q.event.run(call, user.id, Date.now(), 'start', JSON.stringify({ stt: s.stt, tts: s.tts, speed: s.speed, perLanguage: !!s.voice_per_language }))
      const cap = s.monthly_cap_usd
      let spent = (q.month.get(user.id, monthStart()) as { usd: number }).usd
      const conv = voiceConversation({
        stt: stt[s.stt]!, sttKey: sttKey!, tts: tts[s.tts]!, ttsKey: ttsKey!,
        voice: (lang) => voiceFor(s, lang)?.id ?? null,
        speed: s.speed,
        waitTalk: !!s.wait_talk,
        coding,
        endWait: s.end_wait as EndWait,
        // Timings only (ms after they stopped talking): what to look at when a turn feels slow.
        log: (t) => {
          console.log(`voice turn user=${user.id} ${s.tts} ${JSON.stringify(t)}`)
          q.event.run(call, user.id, Date.now(), 'turn', JSON.stringify({ ...t, tts: s.tts, speed: s.speed }))
        },
        event: (kind, data) => void q.event.run(call, user.id, Date.now(), kind, data ? JSON.stringify(data) : null),
        languages: JSON.parse(s.languages) as string[], mode,
        chat: {
          send: async (text) => void await claude.send(user, chat, text, [], [], [], { typed: true }),
          interrupt: () => claude.interrupt(user, chat),
          onMessage: (fn: (m: Raw) => void) => claude.onMessage((id, m) => { if (id === chat) fn(m as Raw) }),
        },
        client: {
          json: send,
          audio: (gen, pcm) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.of(gen & 255), pcm])) },
        },
        meter: (u: Usage) => {
          q.used.run(u.sttSeconds, u.ttsChars, u.costUsd, call)
          spent += u.costUsd
          if (spent - u.costUsd < (cap ?? Infinity) && spent >= (cap ?? Infinity)) send({ type: 'error', message: 'This month\'s voice cap is reached: voice mode stops here.' })
          return cap == null || spent < cap
        },
        onEnd: () => {
          if (live.get(user.id) === conv) live.delete(user.id)
          if (ws.readyState === ws.OPEN) ws.close(1000)
        },
      })
      live.set(user.id, conv)
      // The session asks them something (a permission, a question): a short heads-up, then quiet until they act.
      const off = claude.onPrompt((sess, r) => { if (sess.id === chat) conv.headsUp(r.toolName === 'AskUserQuestion' ? 'question' : 'permission') })
      ws.on('close', off)
      send({ type: 'ready', sessionId: chat })
      ws.on('message', (data, binary) => {
        if (binary) return conv.audio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        try { conv.control(JSON.parse(String(data)) as Record<string, unknown>) } catch { /* not JSON: ignored */ }
      })
      ws.on('close', () => conv.end('closed'))
      if (closed) conv.end('closed') // they hung up while it was starting
    },

    /** Their voice conversations' events of the last day, for diagnosing (timings and names, never what was said). */
    events(user: User) {
      return (q.events.all(user.id, Date.now() - 86_400_000) as { call: number; at: number; kind: string; data: string | null }[])
        .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) as unknown : null }))
    },

    /** A member left: their live conversation ends (their rows go with the user). */
    memberRemoved(userId: number) {
      live.get(userId)?.end('closed')
    },
  }
}
export type VoiceService = ReturnType<typeof voiceService>
