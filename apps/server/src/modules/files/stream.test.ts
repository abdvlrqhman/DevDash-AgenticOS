import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asText, parseRange, readAll, videoType } from './stream.ts'

test('the file viewer gets text for text files and nothing for binary ones', async () => {
  assert.equal(asText(Buffer.from('# Plan\n\nhéllo ✓\n')), '# Plan\n\nhéllo ✓\n')
  assert.equal(asText(Buffer.from('')), '')
  assert.equal(asText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), null, 'a PNG has NUL bytes')
  assert.equal(asText(Buffer.from([0x66, 0xff, 0xfe, 0x67])), null, 'not UTF-8')
  assert.equal((await readAll(new Response('abc').body!)).toString(), 'abc')
})

test('a video player gets the part of the file it asks for; other Range forms get the whole file', () => {
  assert.deepEqual(parseRange('bytes=0-'), { start: 0, end: undefined })
  assert.deepEqual(parseRange('bytes=0-1'), { start: 0, end: 1 })
  assert.deepEqual(parseRange('bytes=1048576-2097151'), { start: 1048576, end: 2097151 })
  for (const h of [undefined, '', 'bytes=-500', 'bytes=0-1,5-9', 'bytes=9-3', 'items=0-1', 'bytes=abc-']) assert.equal(parseRange(h), null, String(h))
  assert.equal(videoType('/home/ann/clip.MP4'), 'video/mp4')
  assert.equal(videoType('demo.mov'), 'video/mp4')
  assert.equal(videoType('demo.webm'), 'video/webm')
  assert.equal(videoType('page.html'), null)
  assert.equal(videoType('mp4'), null)
})
