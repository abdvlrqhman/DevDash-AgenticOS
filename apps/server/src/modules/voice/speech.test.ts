import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackSpeech, isArabic, keepExpressions, sentenceChunker, speakable, stripExpressions, voiceExtractor } from './speech.ts'

test('voice blocks are found as the reply streams, even with tags split across deltas', () => {
  const x = voiceExtractor()
  const out = ['Hi <vo', 'ice>One sec', 'ond, checking.</vo', 'ice> written [link](/x) <voice>Done.</voice>'].map((d) => x.feed(d))
  assert.deepEqual(out, ['', 'One sec', 'ond, checking.', 'Done.'])
  assert.equal(x.spoke, true)
  // A '<' that isn't a tag is released once it can't be one.
  const y = voiceExtractor()
  assert.equal(y.feed('<voice>a <'), 'a ')
  assert.equal(y.feed('b'), '<b')
  assert.equal(voiceExtractor().spoke, false)
  // An unclosed block doesn't swallow the next message.
  y.reset()
  assert.equal(y.feed('plain text'), '')
})

test('speech starts with the first sentence while the rest streams; after it, long pieces at sentence ends', () => {
  const c = sentenceChunker()
  assert.deepEqual(c.push('تمام يا باشا، وسامعك كويس جدا النهارده. وده '), ['تمام يا باشا، وسامعك كويس جدا النهارده.']) // the first sentence at once
  assert.deepEqual(c.push('أول اختبار: هشوف الـ tasks… '), []) // short: waits to join the next
  assert.deepEqual(c.push('وأرجعلك بعد شوية بكل التفاصيل اللي محتاجها.'), [])
  assert.deepEqual(c.flush(), ['وده أول اختبار: هشوف الـ tasks… وأرجعلك بعد شوية بكل التفاصيل اللي محتاجها.'])
  // A long first sentence with no end yet: its first clause of 40+ characters goes.
  const d = sentenceChunker()
  assert.deepEqual(d.push('I went through all of the work from this morning, and the shop deploy'), ['I went through all of the work from this morning,'])
  // "3.5" is not a sentence end.
  assert.deepEqual(sentenceChunker().push('The build is 3.5 MB now, fine for the store. '), ['The build is 3.5 MB now, fine for the store.'])
})

test('expression cues: Fish keeps the allowed ones exactly, everything else (and the chat) loses them', () => {
  assert.equal(keepExpressions('[Laughing] okay, that one was good [dances] [sigh'), '[laughing] okay, that one was good')
  assert.equal(stripExpressions('[chuckling] صباح الفل يا باشا [sighing]'), 'صباح الفل يا باشا')
  assert.equal(stripExpressions('no cues here'), 'no cues here')
  assert.equal(keepExpressions(speakable('See [the PR](https://x.y/1) [break] now')), 'See the PR [break] now') // links aren't cues
})

test('the silence a TTS puts around a piece is trimmed, keeping a breath', async () => {
  const { trimSilence } = await import('./providers.ts')
  const pcm = Buffer.alloc(24_000 * 2) // a second
  for (let i = 9_600; i < 14_400; i++) pcm.writeInt16LE(5000, i * 2) // sound from 400 to 600 ms
  const t = trimSilence(pcm)
  const ms = (t.length / 2 / 24_000) * 1000
  assert.ok(ms > 200 && ms < 380, String(ms)) // 200 ms of sound + 40 ms before + 120 ms after
  assert.equal(trimSilence(Buffer.alloc(4800)).length, 0)
})

test('nothing unspeakable is read out: links keep their words, URLs, paths, code and markdown go', () => {
  assert.equal(speakable('See **[the PR](https://github.com/a/b/pull/3)** now'), 'See the PR now')
  assert.equal(speakable('Open https://dev.example.com/x?y=1 or `/srv/devdash/a.ts` and `npm test`'), 'Open or and npm test')
  assert.equal(speakable('Look at ~/projects/shop/src for it'), 'Look at for it')
  assert.equal(speakable('# Title\n- one\n- two\n```js\nx()\n```\n| a | b |'), 'Title one two')
  assert.equal(speakable('<devdash-page path="/x"/>hi'), 'hi')
})

test('a voice reply without a <voice> block still says something short', () => {
  assert.equal(fallbackSpeech('Done: [shop#12](/tasks/shop/12) is in review.'), 'Done: shop#12 is in review.')
  const long = `${'The deploy failed at step two because the token expired. '.repeat(3)}${'More detail follows here. '.repeat(10)}`
  const s = fallbackSpeech(long)
  assert.ok(s.length <= 220, s)
  assert.ok(s.startsWith('The deploy failed'))
  assert.equal(fallbackSpeech('```\ncode only\n```'), '')
  assert.equal(fallbackSpeech('<voice>said</voice>'), '')
})

test('Arabic script is spotted per sentence', () => {
  assert.equal(isArabic('تمام، خلصت'), true)
  assert.equal(isArabic('Alles klar'), false)
})
