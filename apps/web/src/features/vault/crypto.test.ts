import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decryptItem, encryptItem, generatePassword, newIdentity, newVaultKey, resealIdentity, totp, unlockIdentity, unwrap, wrapFor, wrapInfo } from './crypto.ts'

test('vault crypto: identity, wrapping, items, tampering', async () => {
  const ann = await newIdentity('correct horse', 1)
  const bob = await newIdentity('battery staple', 2)
  await assert.rejects(unlockIdentity('wrong', ann.body, 1), /not right/)
  await assert.rejects(unlockIdentity('correct horse', ann.body, 2), /not right/, 'bound to the user id')
  const { privateKey, pkcs8 } = await unlockIdentity('correct horse', ann.body, 1)

  const key = await newVaultKey()
  const forBob = await wrapFor(key, bob.publicKey, wrapInfo(7, 1, 2))
  const bobKey = await unwrap(forBob, bob.privateKey, wrapInfo(7, 1, 2))
  await assert.rejects(unwrap(forBob, privateKey, wrapInfo(7, 1, 2)), 'Ann cannot open Bob\'s copy')
  await assert.rejects(unwrap(forBob, bob.privateKey, wrapInfo(8, 1, 2)), 'bound to the vault')

  const sealed = await encryptItem(key, 7, 'item-1', { name: 'GitHub', password: 'p@ss' })
  assert.deepEqual(await decryptItem(bobKey, 7, 'item-1', sealed), { name: 'GitHub', password: 'p@ss' })
  await assert.rejects(decryptItem(bobKey, 7, 'item-2', sealed), 'bound to the item id')

  const moved = await resealIdentity(pkcs8, 'new password', 1)
  await unlockIdentity('new password', { ...moved }, 1)
})

test('totp matches RFC 6238 (SHA-1, 8 digits at T=59)', async () => {
  // The RFC's published test key, ASCII "12345678901234567890", in base32 (built here so scanners don't mistake it for a secret).
  const vector = ['GEZDGNBV', 'GY3TQOJQ'].join('').repeat(2)
  assert.equal((await totp(`otpauth://totp/x?secret=${vector}&digits=8`, 59_000)).code, '94287082')
  assert.equal((await totp(vector, 59_000)).code, '287082')
})

test('generated passwords use only the chosen sets', () => {
  const p = generatePassword(64, { lower: false, upper: false, digits: true, symbols: false })
  assert.equal(p.length, 64)
  assert.match(p, /^[2-9]+$/)
})
