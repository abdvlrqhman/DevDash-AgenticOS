import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asText, readAll } from './stream.ts'

test('the file viewer gets text for text files and nothing for binary ones', async () => {
  assert.equal(asText(Buffer.from('# Plan\n\nhéllo ✓\n')), '# Plan\n\nhéllo ✓\n')
  assert.equal(asText(Buffer.from('')), '')
  assert.equal(asText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), null, 'a PNG has NUL bytes')
  assert.equal(asText(Buffer.from([0x66, 0xff, 0xfe, 0x67])), null, 'not UTF-8')
  assert.equal((await readAll(new Response('abc').body!)).toString(), 'abc')
})
