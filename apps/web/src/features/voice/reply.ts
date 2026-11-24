// In voice mode Hamasa writes one reply: what it says goes in <voice>…</voice>, the rest is the written reply. The chat
// shows both: what was said (so a sentence they heard is always there to read), then what was written. Works on a
// reply still streaming in.

const BLOCK = /<voice>([\s\S]*?)(<\/voice>|$)/g
const PARTIAL_TAG = /<\/?v?o?i?c?e?$/ // the start of a tag still arriving
const CUE = /\[[^\]\[\n]{1,40}\](?!\()|\[[^\]\n]{0,40}$/g // the server's speech.ts cues

/** A reply's spoken and written parts. Pure, tested. */
export function splitReply(text: string): { spoken: string; written: string } {
  if (!text.includes('<voice') && !PARTIAL_TAG.test(text)) return { spoken: '', written: text }
  const t = text.replace(PARTIAL_TAG, '')
  return {
    // [laughing]-style cues are for the voice, never shown.
    spoken: [...t.matchAll(BLOCK)].map((m) => m[1]!.replace(CUE, ' ').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join(' '),
    written: t.replace(BLOCK, '').trim(),
  }
}

/** The reply as plain text, spoken part first: to copy it, or to tell whether there's anything to show. Pure, tested. */
export const plainReply = (text: string) => { const r = splitReply(text); return [r.spoken, r.written].filter(Boolean).join('\n\n') }

/** A reply to a message that wasn't spoken: its <voice> blocks become ordinary text (cues dropped). Pure, tested. */
export const unwrapVoice = (text: string) =>
  text.includes('<voice') ? text.replace(PARTIAL_TAG, '').replace(BLOCK, (_, inner: string) => inner.replace(CUE, ' ').replace(/[ \t]{2,}/g, ' ').trim()).trim() : text

/** A message they spoke: the tag the voice pipeline adds after the page tag. */
export const VOICE_TAG_RE = /^\s*<devdash-voice\b[^>]*\/>\s*/
