// What Hamasa says out loud, taken from what it writes. In voice mode it writes one reply: what to say goes in
// <voice>…</voice> blocks (an acknowledgement before a tool, the short spoken answer), the rest is the written reply
// with links and detail that stays in the chat. These pure helpers find the spoken parts as the reply streams in,
// cut them into sentences for TTS, and make anything said out loud safe to say.

export const VOICE_OPEN = '<voice>'
export const VOICE_CLOSE = '</voice>'

/**
 * Feeds streamed text, returns the text inside <voice> blocks as soon as it arrives. A tag split across two deltas
 * waits in the buffer until it's complete. Pure, tested.
 */
export function voiceExtractor() {
  let inside = false
  let buf = ''
  let saw = false
  return {
    /** Spoken text found in this delta (may be empty). */
    feed(delta: string): string {
      buf += delta
      let out = ''
      for (;;) {
        const tag = inside ? VOICE_CLOSE : VOICE_OPEN
        const i = buf.indexOf(tag)
        if (i >= 0) {
          if (inside) out += buf.slice(0, i)
          buf = buf.slice(i + tag.length)
          inside = !inside
          if (inside) saw = true
          continue
        }
        // Keep a tail that could be the start of the tag; the rest is settled.
        let keep = 0
        for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) if (tag.startsWith(buf.slice(-n))) { keep = n; break }
        if (inside) out += buf.slice(0, buf.length - keep)
        buf = buf.slice(buf.length - keep)
        return out
      }
    },
    /** Whether any <voice> block opened so far. */
    get spoke() { return saw },
    /** Inside an open block: what's spoken so far isn't the whole thought yet. */
    get inside() { return inside },
    /** A new message starts: an unclosed block doesn't carry over. */
    reset() { inside = false; buf = '' },
  }
}

// Sentence ends: . ! ? and the Arabic question mark, then a space; or a line break. Never an ellipsis.
const END = /([.!?؟]+["'”’)\]]*)(\s+)|\n+/g
// A clause end (comma, Arabic comma, semicolon), used only for the first piece of a long first sentence.
const CLAUSE = /[,،;]\s+/g
/** The first piece goes at its first sentence end once it's this long: the answer starts while the rest streams. */
export const MIN_FIRST = 25
/** No sentence end yet: the first piece may end at a clause once it's this long. */
export const FIRST_CLAUSE = 40
/** After the first, pieces end at sentence ends and are at least this long (shorter ones join the next). */
export const MIN_PIECE = 60

/**
 * Cuts streamed spoken text for TTS. The first piece goes as soon as a sentence of MIN_FIRST is complete (or, in a
 * long first sentence, a clause of FIRST_CLAUSE), so speech starts while the reply is still arriving; after that only
 * sentence ends, in pieces of at least MIN_PIECE so each one keeps a natural intonation. Decimal points ("3.5")
 * aren't sentence ends. Pure, tested.
 */
export function sentenceChunker() {
  let buf = ''
  let first = true
  return {
    push(text: string): string[] {
      buf += text
      const out: string[] = []
      let start = 0
      END.lastIndex = 0
      for (let m; (m = END.exec(buf));) {
        const end = m.index + m[0].length
        if (buf.slice(start, end).trim().length < (first ? MIN_FIRST : MIN_PIECE)) continue
        out.push(buf.slice(start, end).trim())
        first = false
        start = end
      }
      if (first && start === 0 && buf.length >= FIRST_CLAUSE) {
        let cut = -1
        CLAUSE.lastIndex = 0
        for (let m; (m = CLAUSE.exec(buf));) if (m.index >= FIRST_CLAUSE) { cut = m.index + m[0].length; break }
        if (cut > 0) { out.push(buf.slice(0, cut).trim()); first = false; start = cut }
      }
      buf = buf.slice(start)
      return out
    },
    /** The rest, when the block or the reply ends. */
    flush(): string[] {
      const rest = buf.trim()
      buf = ''
      if (!rest) return []
      first = false
      return [rest]
    },
  }
}

/**
 * Makes text safe to say: no markdown, code, links or paths read out. Links keep their words; bare URLs and file
 * paths go. Pure, tested.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, (_, c: string) => (/[/\\]|\w\.\w+$/.test(c) ? ' ' : c))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][\w-]*\b[^>]*>/gi, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/(^|\s)~?\/[\w.@-]+(\/[\w.@-]*)+/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * When a reply in voice mode came without a <voice> block: its first sentence or two, made speakable, so it's never
 * silent. Long replies point to the chat. Pure, tested.
 */
export function fallbackSpeech(written: string, max = 220): string {
  const s = speakable(written.replace(/<voice>[\s\S]*?<\/voice>/g, ' '))
  if (!s) return ''
  if (s.length <= max) return s
  const out: string[] = []
  for (const piece of s.split(/(?<=[.!?؟])\s+/)) {
    if (out.join(' ').length + piece.length > max) break
    out.push(piece)
  }
  return out.length ? out.join(' ') : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`
}

/** Arabic script in the sentence: it's said in Arabic, whatever the conversation was in. */
export const isArabic = (s: string) => /[؀-ۿ]/.test(s)

/**
 * Expression cues Fish Audio's S2 models act out inline ("[laughing] that's funny"): a small allowed set, used sparingly.
 * https://docs.fish.audio/developer-guide/core-features/emotions
 */
export const EXPRESSIONS = ['laughing', 'chuckling', 'sighing', 'whispering', 'break']
// A [cue]: short, no link after it. Also an unclosed "[laugh" at the end, still streaming or cut off.
const CUE = /\[([^\]\[\n]{1,40})\](?!\()|\[[^\]\n]{0,40}$/g
/** Without any [cue]: for the chat and for a voice that would read them out. Pure, tested. */
export const stripExpressions = (t: string) => t.replace(CUE, ' ').replace(/[ \t]{2,}/g, ' ').trim()
/** Only the allowed cues, in their exact form: anything else in brackets would be read aloud. Pure, tested. */
export const keepExpressions = (t: string) =>
  t.replace(CUE, (m, inner: string | undefined) => (inner && EXPRESSIONS.includes(inner.trim().toLowerCase()) ? `[${inner.trim().toLowerCase()}]` : ' '))
    .replace(/[ \t]{2,}/g, ' ').trim()
