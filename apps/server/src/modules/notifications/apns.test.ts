import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { User } from '../auth/repo.ts'
import { apnsPayload, apnsService, http2Transport, type ApnsRequest, type ApnsResponse } from './apns.ts'
import { notificationsService } from './service.ts'

const TEAM = 'TEAM123456'
const KEY_ID = 'KEY1234567'
const BUNDLE = 'io.github.abdvlrqhman.devdash'
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

/** A fresh APNs-style key: EC P-256, PKCS#8 PEM like the .p8 file Apple hands out. */
const p8 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** Stands in for Apple: records each request and answers with whatever `answer` says for it. */
function fakeApple() {
  const sent: ApnsRequest[] = []
  const a = {
    sent,
    closed: 0,
    answer: (_r: ApnsRequest): ApnsResponse => ({ status: 200 }),
    transport: {
      send: async (r: ApnsRequest) => (sent.push(r), a.answer(r)),
      close: () => { a.closed++ },
    },
  }
  return a
}

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
  add.run(1, 'a@x.io', 'ann', 'Ann', 'admin')
  add.run(2, 'b@x.io', 'bob', 'Bob', 'member')
  const apple = fakeApple()
  let clock = 1_800_000_000_000
  const masterKey = randomBytes(32)
  const apns = apnsService({ db, masterKey, origin: 'https://dev.example.com', transport: apple.transport, now: () => clock })
  const ann: User = { id: 1, name: 'Ann', username: 'ann', email: 'a@x.io', role: 'admin' }
  return { db, apns, apple, ann, masterKey, tick: (ms: number) => { clock += ms }, now: () => clock }
}

const event = (over: Partial<{ id: number; kind: string; title: string; body: string; url: string; tag: string }> = {}) =>
  ({ id: 7, kind: 'needs_you', title: 'Claude needs you: deploy', body: 'Approve the plan?', url: '/claude/abc', tag: 'session:abc', ...over })

const parts = (jwt: string) => {
  const [h, c, s] = jwt.split('.')
  return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()), input: `${h}.${c}`, sig: Buffer.from(s!, 'base64url') }
}

test('an admin sets the APNs key once; it is sealed and never comes back', () => {
  const t = setup()
  assert.equal(t.apns.configured(), false)
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: 'nope', keyId: KEY_ID, bundleId: BUNDLE, key: p8() }), /Team ID/)
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: 'short', bundleId: BUNDLE, key: p8() }), /Key ID/)
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: 'devdash', key: p8() }), /bundle ID/)
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE }), /\.p8/)
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: 'hello' }), /isn't an APNs key/)
  // An RSA key is a private key, but not one Apple issues.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: rsa }), /isn't an APNs key/)

  const key = p8()
  const info = t.apns.setConfig(t.ann, { teamId: ' team123456 ', keyId: KEY_ID, bundleId: BUNDLE, key })
  assert.equal(info.configured, true)
  assert.equal(info.teamId, TEAM, 'trimmed and upper-cased')
  assert.equal(JSON.stringify(info).includes('PRIVATE'), false, 'the key never comes back')
  const row = t.db.prepare('select * from apns_config').get() as { key_sealed: string }
  const body = key.split('\n')[1]!
  assert.equal(row.key_sealed.includes(body), false, 'stored sealed, not as PEM')
  assert.equal(t.apns.configured(), true)

  // Same key and team: the .p8 can be left out (e.g. to fix the bundle ID). A new Key ID needs its file.
  assert.equal(t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: 'com.example.dd' }).bundleId, 'com.example.dd')
  assert.throws(() => t.apns.setConfig(t.ann, { teamId: TEAM, keyId: 'KEY7654321', bundleId: BUNDLE }), /\.p8 file/)
  // Just the base64 lines of the file work too, and a paste that lost its line breaks.
  const lines = key.split('\n').filter((l) => l && !l.startsWith('-----')).join('\n')
  assert.equal(t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: lines }).configured, true)
  assert.equal(t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: key.replace(/\n/g, '') }).configured, true)
  assert.ok(t.apple.closed >= 1, 'a new key starts new connections')

  t.apns.removeConfig()
  assert.equal(t.apns.configured(), false)
})

test('the provider token is an ES256 JWT with kid, iss and iat, reused for 50 minutes', async () => {
  const t = setup()
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
  t.apns.register(2, { token: TOKEN_A, environment: 'production', device: 'iPhone' })

  await t.apns.deliver(2, event())
  const [first] = t.apple.sent
  assert.ok(first)
  assert.match(first.headers.authorization!, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  const jwt = parts(first.headers.authorization!.slice('bearer '.length))
  assert.deepEqual(jwt.header, { alg: 'ES256', kid: KEY_ID })
  assert.deepEqual(jwt.claims, { iss: TEAM, iat: Math.floor(t.now() / 1000) })
  assert.equal(jwt.sig.length, 64, 'raw r‖s, not DER')
  assert.ok(verify('sha256', Buffer.from(jwt.input), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, jwt.sig), 'signed with the .p8 key')

  t.tick(49 * 60_000)
  await t.apns.deliver(2, event())
  assert.equal(t.apple.sent[1]!.headers.authorization, first.headers.authorization, 'reused: Apple refuses new tokens more than every 20 minutes')
  t.tick(2 * 60_000)
  await t.apns.deliver(2, event())
  assert.notEqual(t.apple.sent[2]!.headers.authorization, first.headers.authorization, 'renewed before Apple’s one-hour limit')
  assert.equal(parts(t.apple.sent[2]!.headers.authorization!.slice(7)).claims.iat, Math.floor(t.now() / 1000))
})

test('a push carries the alert, the page to open, and Apple’s headers', async () => {
  const t = setup()
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: p8() })
  t.apns.register(2, { token: TOKEN_A.toUpperCase(), environment: 'sandbox', device: 'iPhone' })
  await t.apns.deliver(2, event())
  const r = t.apple.sent[0]!
  assert.equal(r.env, 'sandbox')
  assert.equal(r.deviceToken, TOKEN_A, 'stored lower-case')
  assert.equal(r.headers['apns-topic'], BUNDLE)
  assert.equal(r.headers['apns-push-type'], 'alert')
  assert.equal(r.headers['apns-priority'], '10')
  assert.equal(r.headers['apns-collapse-id'], 'session:abc')
  assert.equal(r.headers['apns-expiration'], String(Math.floor(t.now() / 1000) + 3600))
  assert.deepEqual(JSON.parse(r.body), {
    aps: { alert: { title: 'Claude needs you: deploy', body: 'Approve the plan?' }, sound: 'default', 'thread-id': 'needs_you' },
    url: 'https://dev.example.com/claude/abc',
    id: 7,
  })

  // Apple refuses payloads over 4 KB and collapse IDs over 64 bytes; links only ever point into the space.
  const big = apnsPayload(event({ body: '😀'.repeat(3000), url: 'https://evil.example/x' }), 'https://dev.example.com')
  assert.equal(big.url, 'https://dev.example.com/')
  assert.ok(Buffer.byteLength(big.aps.alert.body) <= 2000)
  await t.apns.deliver(2, event({ body: '"\n'.repeat(5000), tag: 'x'.repeat(100) }))
  assert.ok(Buffer.byteLength(t.apple.sent[1]!.body) <= 4096)
  assert.equal(t.apple.sent[1]!.headers['apns-collapse-id']!.length, 64)

  // Nothing is sent without a key, or to members without an iPhone.
  t.apns.removeConfig()
  await t.apns.deliver(2, event())
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: p8() })
  await t.apns.deliver(1, event())
  assert.equal(t.apple.sent.length, 2)
})

test('tokens Apple says are gone are dropped; a token from the other environment moves there', async () => {
  const t = setup()
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: p8() })
  const tokens = () => (t.db.prepare('select token, environment from apns_devices order by token').all() as { token: string; environment: string }[])
    .map((d) => `${d.token[0]}:${d.environment}`)

  // 410 Unregistered: the app was removed.
  t.apns.register(2, { token: TOKEN_A, environment: 'production', device: 'iPhone' })
  t.apple.answer = () => ({ status: 410, reason: 'Unregistered', timestamp: t.now() + 60_000 })
  await t.apns.deliver(2, event())
  assert.deepEqual(tokens(), [])

  // ...unless the phone registered the token again after the date Apple gives.
  t.apns.register(2, { token: TOKEN_A, environment: 'production', device: 'iPhone' })
  t.apple.answer = () => ({ status: 410, reason: 'Unregistered', timestamp: 1000 })
  await t.apns.deliver(2, event())
  assert.deepEqual(tokens(), ['a:production'])

  // BadDeviceToken: tried once in the other environment, which knows it.
  t.apple.sent.length = 0
  t.apple.answer = (r) => r.env === 'production' ? { status: 400, reason: 'BadDeviceToken' } : { status: 200 }
  await t.apns.deliver(2, event())
  assert.deepEqual(t.apple.sent.map((r) => r.env), ['production', 'sandbox'])
  assert.deepEqual(tokens(), ['a:sandbox'])

  // BadDeviceToken in both: dropped. Other members' tokens are untouched.
  t.apns.register(1, { token: TOKEN_B, environment: 'production', device: 'iPhone' })
  t.apple.answer = (r) => r.deviceToken === TOKEN_A ? { status: 400, reason: 'BadDeviceToken' } : { status: 200 }
  await t.apns.deliver(2, event())
  assert.deepEqual(tokens(), ['b:production'])
})

test('problems only an admin can fix are kept for the admin page and cleared by the next success', async () => {
  const t = setup()
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: p8() })
  t.apns.register(2, { token: TOKEN_A, environment: 'production', device: 'iPhone' })
  const quiet = console.error
  console.error = () => {}
  try {
    t.apple.answer = () => ({ status: 403, reason: 'InvalidProviderToken' })
    await t.apns.deliver(2, event())
    assert.match(t.apns.info().lastError!, /rejected the key/)
    assert.equal(t.apns.info().devices.production, 1, 'a key problem never deletes devices')

    t.apple.answer = () => ({ status: 403, reason: 'BadEnvironmentKeyIdInToken' })
    await t.apns.deliver(2, event())
    assert.match(t.apns.info().lastError!, /Production/)

    t.apple.answer = () => { throw new Error('ECONNRESET') }
    await t.apns.deliver(2, event()) // never throws into notify()
    assert.match(t.apns.info().lastError!, /Couldn't reach Apple/)
  } finally {
    console.error = quiet
  }
  t.apple.answer = () => ({ status: 200 })
  await t.apns.deliver(2, event())
  assert.equal(t.apns.info().lastError, null)
})

test('a device token moves to whoever signs in on that iPhone; members remove only their own', () => {
  const t = setup()
  t.apns.register(1, { token: TOKEN_A, environment: 'production', device: 'iPhone' })
  assert.deepEqual(t.apns.register(2, { token: TOKEN_A, environment: 'production', device: 'iPhone' }), { configured: false })
  const owner = () => (t.db.prepare('select user_id from apns_devices').get() as { user_id: number } | undefined)?.user_id
  assert.equal(owner(), 2)
  t.apns.unregister(1, TOKEN_A)
  assert.equal(owner(), 2)
  t.apns.unregister(2, TOKEN_A.toUpperCase())
  assert.equal(owner(), undefined)
})

test('notify() pushes to the iPhone like Web Push: not while the member is using DevDash, except for the test', async () => {
  const t = setup()
  t.apns.setConfig(t.ann, { teamId: TEAM, keyId: KEY_ID, bundleId: BUNDLE, key: p8() })
  t.apns.register(1, { token: TOKEN_A, environment: 'production', device: 'iPhone' })
  const hub = createHub()
  hub.publish = () => {}
  let active = false
  hub.isActive = () => active
  const n = notificationsService({ db: t.db, hub, dataDir: mkdtempSync(join(tmpdir(), 'dd-')), origin: 'https://dev.example.com', apns: t.apns })

  await n.notify(1, 'needs_you', { title: 'Claude needs you: x', url: '/claude/x', tag: 'session:x' })
  assert.equal(t.apple.sent.length, 1)
  assert.equal(JSON.parse(t.apple.sent[0]!.body).url, 'https://dev.example.com/claude/x')

  active = true // looking at DevDash somewhere: it shows there instead
  await n.notify(1, 'finished', { title: 'shown in the app' })
  assert.equal(t.apple.sent.length, 1)
  await n.notify(1, 'needs_you', { title: 'Notifications work', url: '/account', tag: 'test' }, true)
  assert.equal(t.apple.sent.length, 2, 'the test button still goes through Apple')

  active = false
  await n.notify(1, 'shared', { title: 'muted: shared is off by default' })
  assert.equal(t.apple.sent.length, 2)
})

test('the HTTP/2 transport posts to /3/device/<token>, reads Apple’s answer, and reuses its connection', async () => {
  const seen: { path: string; headers: Record<string, unknown>; body: string }[] = []
  let sessions = 0
  const server = createServer()
  server.on('session', () => { sessions++ })
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (c: string) => { body += c })
    stream.on('end', () => {
      seen.push({ path: String(headers[':path']), headers, body })
      if (String(headers[':path']).endsWith(TOKEN_B)) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1234 }))
      } else {
        stream.respond({ ':status': 200, 'apns-id': 'x' })
        stream.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}` // h2c here; Apple is https
  const transport = http2Transport({ hosts: { sandbox: local, production: local } })
  try {
    const headers = { authorization: 'bearer t', 'apns-topic': BUNDLE, 'apns-push-type': 'alert' }
    assert.deepEqual(await transport.send({ env: 'sandbox', deviceToken: TOKEN_A, headers, body: '{"aps":{}}' }), { status: 200, reason: undefined, timestamp: undefined })
    assert.deepEqual(await transport.send({ env: 'sandbox', deviceToken: TOKEN_B, headers, body: '{}' }), { status: 410, reason: 'Unregistered', timestamp: 1234 })
    assert.equal(seen[0]!.path, `/3/device/${TOKEN_A}`)
    assert.equal(seen[0]!.headers[':method'], 'POST')
    assert.equal(seen[0]!.headers['apns-topic'], BUNDLE)
    assert.equal(seen[0]!.body, '{"aps":{}}')
    assert.equal(sessions, 1, 'one connection for both')
  } finally {
    transport.close()
    await new Promise((r) => server.close(r))
  }
})
