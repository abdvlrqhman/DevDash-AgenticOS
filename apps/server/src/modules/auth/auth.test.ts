import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../app.ts'
import { openDb } from '../../core/db.ts'
import { base32Decode, hotp, totpStep } from '../../core/crypto.ts'

const ORIGIN = 'https://space.test'

function setup() {
  const db = openDb(':memory:')
  const config = { origin: ORIGIN, spaceName: 'Test', dataDir: mkdtempSync(join(tmpdir(), 'dd-')), port: 0, masterKey: randomBytes(32), trustCfIp: false, runDir: '', projectsRoot: '/tmp/devdash-test', servicesPort: 8443, version: '0.0.0', repo: 'example/devdash', githubToken: null }
  const { app, auth } = createApp({ db, config })
  let cookie = ''
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return { status: res.status, body: (await res.json()) as any, setCookie: set }
  }
  return { auth, call, clearCookie: () => (cookie = '') }
}

test('invite → accept → me → logout → login with backup code', async () => {
  const { auth, call, clearCookie } = setup()
  const { token } = auth.createInvite({ email: 'Ada@Example.com', username: 'ada', role: 'admin' }, null, null)

  const inv = await call('GET', `/api/auth/invites/${token}`)
  assert.equal(inv.status, 200)
  assert.equal(inv.body.username, 'ada')
  const secret = base32Decode(inv.body.totpSecret)

  const bad = await call('POST', `/api/auth/invites/${token}`, { name: 'Ada', password: 'short', code: '000000' })
  assert.equal(bad.status, 400, 'wrong code')

  const acc = await call('POST', `/api/auth/invites/${token}`, { name: 'Ada', password: 'a long enough password', code: hotp(secret, totpStep()) })
  assert.equal(acc.status, 200, JSON.stringify(acc.body))
  assert.match(acc.setCookie!, /^__Host-devdash=.+; Path=\/; HttpOnly; Secure; SameSite=Lax$/, 'session cookie, no Max-Age')
  assert.equal(acc.body.backupCodes.length, 10)

  assert.equal((await call('POST', `/api/auth/invites/${token}`, { name: 'Ada', password: 'a long enough password', code: hotp(secret, totpStep()) })).status, 410, 'invite is single use')
  assert.equal((await call('GET', '/api/auth/me')).body.user.email, 'Ada@Example.com')

  await call('POST', '/api/auth/logout')
  clearCookie()
  assert.equal((await call('GET', '/api/auth/me')).status, 401)

  // Same TOTP code as enrollment: replay must fail.
  const replay = await call('POST', '/api/auth/login', { login: 'ada@example.com', password: 'a long enough password', code: hotp(secret, totpStep()), remember: true })
  assert.equal(replay.status, 401)

  const backup = acc.body.backupCodes[0].toLowerCase()
  const ok = await call('POST', '/api/auth/login', { login: 'ada@example.com', password: 'a long enough password', code: backup, remember: true })
  assert.equal(ok.status, 200)
  assert.match(ok.setCookie!, /Max-Age=2592000/, 'remember me = 30 days')
  clearCookie()
  const reused = await call('POST', '/api/auth/login', { login: 'ada@example.com', password: 'a long enough password', code: backup, remember: true })
  assert.equal(reused.status, 401, 'backup codes are single use')
  const byUsername = await call('POST', '/api/auth/login', { login: 'ADA', password: 'a long enough password', code: acc.body.backupCodes[1], remember: false })
  assert.equal(byUsername.status, 200, 'username works as the sign-in identifier')
})

test('wrong password, unknown email and cross-origin requests are rejected', async () => {
  const { auth, call } = setup()
  auth.createInvite({ email: 'b@example.com', username: 'bob', role: 'member' }, null, null)
  assert.equal((await call('POST', '/api/auth/login', { login: 'b@example.com', password: 'nope', code: '123456', remember: false })).status, 401)
  assert.equal((await call('POST', '/api/auth/login', { login: 'ghost@example.com', password: 'nope', code: '123456', remember: false })).status, 401)
  assert.equal((await call('POST', '/api/auth/login', { login: 'b@example.com', password: 'x', code: '123456', remember: false }, { origin: 'https://evil.test' })).status, 403)
})

test('invite validation: usernames and duplicates', () => {
  const { auth } = setup()
  for (const username of ['root', 'Bad', '1abc', 'a', 'systemd-x', 'has space']) {
    assert.throws(() => auth.createInvite({ email: `${randomBytes(4).toString('hex')}@x.com`, username, role: 'member' }, null, null), /Username/)
  }
  auth.createInvite({ email: 'c@example.com', username: 'carol', role: 'member' }, null, null)
  assert.throws(() => auth.createInvite({ email: 'd@example.com', username: 'carol', role: 'member' }, null, null), /taken/)
})

test('members: list for everyone, invites for admins only', async () => {
  const { auth, call } = setup()
  const { token } = auth.createInvite({ email: 'm@example.com', username: 'mem', role: 'member' }, null, null)
  const secret = base32Decode((await call('GET', `/api/auth/invites/${token}`)).body.totpSecret)
  await call('POST', `/api/auth/invites/${token}`, { name: 'Mem', password: 'a long enough password', code: hotp(secret, totpStep()) })
  assert.equal((await call('GET', '/api/members')).status, 200)
  assert.equal((await call('POST', '/api/members/invites', { email: 'n@example.com', username: 'newbie', role: 'member' })).status, 403)
})

test('well-known endpoint is public and CORS-open', async () => {
  const { call } = setup()
  const r = await call('GET', '/.well-known/devdash.json', undefined, { origin: 'https://anything.test' })
  assert.deepEqual(r.body, { app: 'devdash', name: 'Test', version: '0.0.0', api: 1 })
})

test('change password: needs the current one, signs out other devices, short passwords allowed', async () => {
  const { auth, call } = setup()
  const { token } = auth.createInvite({ email: 'p@example.com', username: 'pat', role: 'member' }, null, null)
  const secret = base32Decode((await call('GET', `/api/auth/invites/${token}`)).body.totpSecret)
  const acc = await call('POST', `/api/auth/invites/${token}`, { name: 'Pat', password: 'old', code: hotp(secret, totpStep()) })
  assert.equal(acc.status, 200, 'no minimum length')
  // a second device
  const other = await auth.login({ login: 'p@example.com', password: 'old', code: acc.body.backupCodes[0], remember: false }, { ip: 'x', ua: 'x' })
  assert.ok(auth.sessionUser(other.token))

  assert.equal((await call('POST', '/api/auth/password', { current: 'nope', next: 'new' })).status, 400)
  const ok = await call('POST', '/api/auth/password', { current: 'old', next: 'new' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.signedOutSessions, 1)
  assert.equal(auth.sessionUser(other.token), null, 'other device signed out')
  assert.equal((await call('GET', '/api/auth/me')).status, 200, 'this device stays signed in')
  await assert.rejects(auth.login({ login: 'p@example.com', password: 'old', code: acc.body.backupCodes[1], remember: false }, { ip: 'x', ua: 'x' }))
  assert.ok(await auth.login({ login: 'p@example.com', password: 'new', code: acc.body.backupCodes[2], remember: false }, { ip: 'x', ua: 'x' }))

  assert.equal((await call('POST', '/api/auth/email', { password: 'wrong', email: 'pat@new.com' })).status, 400)
  const changed = await call('POST', '/api/auth/email', { password: 'new', email: 'pat@new.com' })
  assert.equal(changed.body.user.email, 'pat@new.com')
})
