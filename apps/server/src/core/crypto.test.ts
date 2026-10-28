import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  base32Decode, base32Encode, hashPassword, hotp, newBackupCode, normalizeBackupCode,
  seal, totpStep, unseal, verifyPassword, verifyTotp,
} from './crypto.ts'

test('base32 matches RFC 4648 vectors', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar')
  assert.equal(base32Decode('mzxw-6ytb oi').toString(), 'foobar')
})

test('HOTP / TOTP match RFC 4226 and RFC 6238 vectors', () => {
  const seed = Buffer.from('12345678901234567890')
  assert.equal(hotp(seed, 0), '755224')
  assert.equal(hotp(seed, 9), '520489')
  assert.equal(hotp(seed, totpStep(59_000), 8), '94287082')
  assert.equal(hotp(seed, totpStep(1111111109_000), 8), '07081804')
})

test('verifyTotp accepts ±1 step and rejects replay', () => {
  const secret = randomBytes(20)
  const now = 1_700_000_000_000
  const step = totpStep(now)
  assert.equal(verifyTotp(secret, hotp(secret, step), 0, now), step)
  assert.equal(verifyTotp(secret, hotp(secret, step - 1), 0, now), step - 1)
  assert.equal(verifyTotp(secret, hotp(secret, step + 2), 0, now), null)
  assert.equal(verifyTotp(secret, hotp(secret, step), step, now), null, 'replayed code')
  assert.equal(verifyTotp(secret, 'abcdef', 0, now), null)
})

test('password hash round trip', async () => {
  const h = await hashPassword('correct horse battery staple')
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  assert.equal(await verifyPassword('correct horse battery staple', h), true)
  assert.equal(await verifyPassword('wrong', h), false)
  assert.equal(await verifyPassword('x', 'not-a-hash'), false)
})

test('seal/unseal round trip, tamper and wrong-AAD rejection', () => {
  const key = randomBytes(32)
  const s = seal(key, Buffer.from('secret'), 'totp:user:1')
  assert.equal(unseal(key, s, 'totp:user:1').toString(), 'secret')
  assert.throws(() => unseal(key, s, 'totp:user:2'))
  const raw = Buffer.from(s, 'base64'); raw[raw.length - 1]! ^= 1
  assert.throws(() => unseal(key, raw.toString('base64'), 'totp:user:1'))
})

test('backup codes have 80 bits and normalize', () => {
  const c = newBackupCode()
  assert.match(c, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/)
  assert.equal(normalizeBackupCode(c.toLowerCase()), c.replaceAll('-', ''))
})
