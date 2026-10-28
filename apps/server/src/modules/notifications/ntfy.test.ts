import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../core/db.ts'
import { checkServer, ntfyMessage, ntfyService } from './ntfy.ts'

function setup(answer: () => Response = () => new Response('{}')) {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann', 'x', 'x', 'member')").run()
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) })
    return answer()
  }) as typeof fetch
  return { db, calls, ntfy: ntfyService({ db, masterKey: randomBytes(32), origin: 'https://dev.example.com', fetch: fake }) }
}
const event = { id: 7, kind: 'needs_you', title: 'Which database should we use?', body: 'Postgres · SQLite', url: '/claude/s1', tag: 'session:s1' }

test('turning ntfy on gives a long random topic on ntfy.sh; a token is sealed; the topic can be replaced', () => {
  const { db, ntfy } = setup()
  assert.equal(ntfy.status(1).enabled, false)
  const on = ntfy.configure(1, {})
  assert.match(on.topic!, /^devdash-[0-9a-f]{24}$/)
  assert.deepEqual([on.server, on.subscribeUrl, on.hasToken], ['https://ntfy.sh', `https://ntfy.sh/${on.topic}`, false])
  assert.equal(ntfy.configure(1, { token: 'tk_secret123' }).topic, on.topic) // changing the token keeps the topic
  assert.equal(ntfy.status(1).hasToken, true)
  assert.ok(!JSON.stringify(db.prepare('select * from ntfy_targets').all()).includes('tk_secret123'))
  assert.notEqual(ntfy.configure(1, { newTopic: true }).topic, on.topic)
  assert.equal(ntfy.configure(1, { server: 'https://ntfy.example.com' }).server, 'https://ntfy.example.com')
  assert.equal(ntfy.disable(1).enabled, false)
})

test('the ntfy server must be a public https root: never this machine, a LAN address or a path', () => {
  assert.equal(checkServer('https://ntfy.example.com/'), 'https://ntfy.example.com')
  for (const bad of ['http://ntfy.sh', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://box.local', 'https://intranet', 'https://ntfy.sh/topic', 'not a url']) {
    assert.throws(() => checkServer(bad), /https|public name|just the server|web address/, bad)
  }
})

test('a notification goes to the member’s topic as JSON: title, body, priority, a tap that opens the page', async () => {
  const { calls, ntfy } = setup()
  await ntfy.deliver(1, event) // not turned on: nothing is sent
  assert.equal(calls.length, 0)
  const { topic } = ntfy.configure(1, { token: 'tk_abc' })
  await ntfy.deliver(1, event)
  assert.equal(calls[0]!.url, 'https://ntfy.sh/')
  assert.equal(calls[0]!.headers.authorization, 'Bearer tk_abc')
  assert.deepEqual(calls[0]!.body, {
    topic, title: 'Which database should we use?', message: 'Postgres · SQLite', priority: 4, tags: ['bell'],
    click: 'https://dev.example.com/claude/s1', icon: 'https://dev.example.com/icon-192.png', sequence_id: 'session-s1',
  })
  assert.ok(ntfy.status(1).lastOkAt)
  // Only pages inside DevDash are tap targets; a long body is kept under ntfy's 4 KB.
  const m = ntfyMessage({ ...event, url: 'https://evil.example', body: 'x'.repeat(5000), kind: 'finished' }, 't', 'https://d')
  assert.equal('click' in m, false)
  assert.equal(m.message.length, 3000)
  assert.equal(m.priority, 3)
})

test('a refused delivery is recorded for the member, never thrown; the test says how it went', async () => {
  const { ntfy } = setup(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
  ntfy.configure(1, {})
  await ntfy.deliver(1, event)
  assert.equal(ntfy.status(1).lastError, 'ntfy.sh answered 401: unauthorized')
  assert.deepEqual(await ntfy.test(1), { ok: false, error: 'ntfy.sh answered 401: unauthorized' })
  ntfy.disable(1)
  await assert.rejects(() => ntfy.test(1), /Turn on/)
})
