import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashText, md5 } from './hash.ts'

test('md5 matches RFC 1321 test vectors', () => {
  const of = (s: string) => md5(new TextEncoder().encode(s))
  assert.equal(of(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(of('abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(of('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0')
  assert.equal(of('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6')
  // Longer than one 64-byte block, to exercise padding/length.
  assert.equal(of('a'.repeat(1000)), 'cabe45dcc9ae5b66ba86600cca6b8ba8')
})

test('hashText delegates MD5 and SHA via Web Crypto', async () => {
  assert.equal(await hashText('MD5', 'abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(await hashText('SHA-1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(await hashText('SHA-256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
