import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../core/db.ts'
import { sha256 } from '../../core/crypto.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { spacePagesRoutes } from './pages.ts'
import { storageTokenRoutes } from './routes.ts'
import { storageService } from './service.ts'

const CLIENT = '123-abc.apps.googleusercontent.com'
const idToken = (sub: string, email: string) => `x.${Buffer.from(JSON.stringify({ sub, email })).toString('base64url')}.y`

/** Stands in for Google: records each call; tests change what the token endpoint says. */
function fakeGoogle() {
  const calls: { url: string; body: string; auth: string | null }[] = []
  let refreshes = 0
  const g = {
    calls,
    refreshes: () => refreshes,
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    refreshError: null as string | null,
    folders: [] as string[],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? String(init.body) : ''
      calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') })
      const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
      if (url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(body)
        if (form.get('grant_type') === 'authorization_code') {
          return ok({ access_token: 'at-code', refresh_token: 'rt-secret', expires_in: 3600, scope: g.scope, id_token: idToken('sub-1', 'bob@gmail.com') })
        }
        if (g.refreshError) return new Response(JSON.stringify({ error: g.refreshError, error_description: 'Token has been expired or revoked.' }), { status: 400 })
        refreshes++
        return ok({ access_token: `at-${refreshes}`, expires_in: 3600 })
      }
      if (url === 'https://oauth2.googleapis.com/revoke') return ok({})
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return ok({ files: g.folders.map((id) => ({ id })) })
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id')) {
        g.folders.push('F1')
        return ok({ id: 'F1' })
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/about')) return ok({ storageQuota: { limit: '16106127360', usage: '1073741824' } })
      return new Response('{}', { status: 404 })
    }) as typeof fetch,
  }
  return g
}

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
  add.run(1, 'a@x.io', 'ann', 'Ann', 'admin')
  add.run(2, 'b@x.io', 'bob', 'Bob', 'member')
  const sent: { username: string; req: Record<string, unknown> }[] = []
  const agents = { request: async (username: string, req: Record<string, unknown>) => (sent.push({ username, req }), { ok: true }) } as unknown as AgentsService
  const google = fakeGoogle()
  let clock = 1_000_000
  const storage = storageService({
    db, agents, masterKey: randomBytes(32), origin: 'https://dev.example.com', tokenUrl: 'http://127.0.0.1:8787/internal/storage/token',
    fetch: google.fetch, now: () => clock,
  })
  const user = (id: number, name: string, role: 'admin' | 'member'): User => ({ id, name, username: name.toLowerCase(), email: '', role })
  return { db, storage, google, sent, ann: user(1, 'Ann', 'admin'), bob: user(2, 'Bob', 'member'), tick: (ms: number) => { clock += ms } }
}

/** Runs Bob through Google's consent and back. */
async function connect(t: ReturnType<typeof setup>) {
  const url = new URL(t.storage.connectUrl(t.bob).url)
  return { url, back: await t.storage.callback(t.bob, { code: 'the-code', state: url.searchParams.get('state')! }) }
}

test('an admin registers the Google app once; the secret is sealed and never comes back', () => {
  const t = setup()
  assert.throws(() => t.storage.connectUrl(t.bob), /not set up/)
  assert.throws(() => t.storage.setApp(t.ann, { clientId: 'nope', clientSecret: 's' }), /client ID/)
  assert.throws(() => t.storage.setApp(t.ann, { clientId: CLIENT }), /client secret/)
  const info = t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh' })
  assert.deepEqual([info.configured, info.clientId, info.redirectUri], [true, CLIENT, 'https://dev.example.com/storage/callback'])
  assert.ok(!JSON.stringify(info).includes('GOCSPX'))
  assert.ok(!JSON.stringify(t.db.prepare('select * from storage_apps').all()).includes('GOCSPX'))
  t.storage.setApp(t.ann, { clientId: CLIENT }) // keeping the secret while editing the ID
  assert.equal(t.storage.appInfo().configured, true)
})

test('connecting: PKCE + single-use state, Drive scope only, a DevDash folder, and only a handle reaches the member', async () => {
  const t = setup()
  t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh' })
  const { url, back } = await connect(t)
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file')
  assert.deepEqual([url.searchParams.get('access_type'), url.searchParams.get('prompt'), url.searchParams.get('code_challenge_method')], ['offline', 'consent', 'S256'])
  assert.deepEqual(back, { ok: true, message: 'Google Drive connected (bob@gmail.com).' })

  // The code exchange proves the verifier behind the challenge.
  const exchange = new URLSearchParams(t.google.calls.find((c) => c.body.includes('authorization_code'))!.body)
  assert.equal(sha256(exchange.get('code_verifier')!), url.searchParams.get('code_challenge'))
  assert.equal(exchange.get('client_secret'), 'GOCSPX-shh')

  // The agent gets the handle and folder, never the Google refresh token; the DB keeps it sealed.
  const pushed = t.sent.find((s) => s.req.op === 'storage.configure')!
  assert.equal(pushed.username, 'bob')
  const st = pushed.req.storage as { handle: string; folderId: string; remote: string; account: string; tokenUrl: string }
  assert.match(st.handle, /^ddh_/)
  assert.deepEqual([st.folderId, st.remote, st.account, st.tokenUrl], ['F1', 'drive', 'bob@gmail.com', 'http://127.0.0.1:8787/internal/storage/token'])
  assert.ok(!JSON.stringify(t.sent).includes('rt-secret'))
  assert.ok(!JSON.stringify(t.db.prepare('select * from member_storage').all()).includes('rt-secret'))
  assert.deepEqual(t.storage.forLaunch(2), st)
  assert.equal(t.storage.forLaunch(1), null)

  const s = await t.storage.status(t.bob)
  assert.deepEqual([s.connected, s.account, s.folderUrl, s.quota], [true, 'bob@gmail.com', 'https://drive.google.com/drive/folders/F1', { used: 1073741824, limit: 16106127360 }])

  // The state worked once; replaying it (or someone else using it) is refused.
  assert.match((await t.storage.callback(t.bob, { code: 'again', state: url.searchParams.get('state')! })).message, /expired/)
  // Reconnecting reuses the folder DevDash made before and swaps the handle.
  await connect(t)
  assert.equal(t.google.folders.length, 1)
  assert.notEqual(t.storage.forLaunch(2)!.handle, st.handle)
})

test("the callback: completes in a browser that isn't signed in, refuses another member's browser, a cancel and no Drive access", async () => {
  const t = setup()
  t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh' })
  const stateOf = () => new URL(t.storage.connectUrl(t.bob).url).searchParams.get('state')!
  // Bob's link, finished in a browser signed in as Ann: refused (and the link is used up).
  const s1 = stateOf()
  assert.match((await t.storage.callback(t.ann, { code: 'c', state: s1 })).message, /Another DevDash member/)
  assert.match((await t.storage.callback(t.bob, { code: 'c', state: s1 })).message, /expired/)
  assert.match((await t.storage.callback(t.bob, { error: 'access_denied', state: stateOf() })).message, /cancelled/)
  const s3 = stateOf()
  t.tick(11 * 60_000)
  assert.match((await t.storage.callback(t.bob, { code: 'c', state: s3 })).message, /expired/)
  t.google.scope = 'openid email' // they unticked Drive on Google's screen
  assert.match((await t.storage.callback(t.bob, { code: 'c', state: stateOf() })).message, /Drive access was not granted/)
  assert.equal(t.storage.forLaunch(2), null)

  // The native app opened Google in the system browser, which isn't signed in to DevDash: the state says it's Bob's.
  t.google.scope = 'openid email https://www.googleapis.com/auth/drive.file'
  assert.equal((await t.storage.callback(null, { code: 'c', state: stateOf() })).ok, true)
  assert.equal(t.sent.at(-1)!.username, 'bob')
  assert.equal(t.storage.forLaunch(2)!.account, 'bob@gmail.com')
})

test("the token endpoint trades the member's handle for a cached access token; a revoked grant is reported, not retried", async () => {
  const t = setup()
  t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh' })
  await connect(t)
  const handle = t.storage.forLaunch(2)!.handle
  const routes = storageTokenRoutes(t.storage)
  const ask = (body: string) => routes.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ZGV2ZGFzaDpkZXZkYXNo' }, body })

  // rclone's refresh request (as it really sends it): the access token from connecting is reused while fresh.
  const r1 = await ask(`grant_type=refresh_token&refresh_token=${handle}`)
  assert.deepEqual([r1.status, (await r1.json() as { access_token: string }).access_token], [200, 'at-code'])
  assert.equal(t.google.refreshes(), 0)
  t.tick(56 * 60_000) // within five minutes of expiry: a fresh one, shared by parallel callers
  const both = await Promise.all([t.storage.token(handle), t.storage.token(handle)])
  assert.deepEqual(both.map((b) => b.access_token), ['at-1', 'at-1'])
  assert.equal(t.google.refreshes(), 1)

  assert.equal((await ask('grant_type=refresh_token&refresh_token=ddh_unknown')).status, 400)
  assert.equal((await ask('grant_type=password&username=x')).status, 400)

  // Bob revoked DevDash in his Google account: the connection is marked, sessions stop getting the remote.
  t.google.refreshError = 'invalid_grant'
  t.tick(61 * 60_000)
  const r2 = await ask(`grant_type=refresh_token&refresh_token=${handle}`)
  assert.deepEqual([r2.status, (await r2.json() as { error: string }).error], [400, 'invalid_grant'])
  assert.match((await t.storage.status(t.bob)).broken!, /revoked/)
  assert.equal(t.storage.forLaunch(2), null)
  // Connecting again fixes it.
  t.google.refreshError = null
  await connect(t)
  assert.equal((await t.storage.status(t.bob)).broken, null)
})

test('disconnecting revokes at Google, kills the handle and removes the remote; a new Google app needs everyone to reconnect', async () => {
  const t = setup()
  t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh' })
  await connect(t)
  const handle = t.storage.forLaunch(2)!.handle
  await t.storage.disconnect(t.bob)
  assert.equal(new URLSearchParams(t.google.calls.find((c) => c.url.endsWith('/revoke'))!.body).get('token'), 'rt-secret')
  await assert.rejects(() => t.storage.token(handle), /disconnected/)
  assert.deepEqual(t.sent.at(-1), { username: 'bob', req: { op: 'storage.remove', remote: 'drive', tokenUrl: 'http://127.0.0.1:8787/internal/storage/token' } })
  assert.equal((await t.storage.status(t.bob)).connected, false)

  await connect(t)
  t.storage.setApp(t.ann, { clientId: '999-new.apps.googleusercontent.com', clientSecret: 'GOCSPX-new' })
  assert.match((await t.storage.status(t.bob)).broken!, /Google app changed/)
  assert.equal(t.storage.forLaunch(2), null)
})

test("the public /about and /privacy pages say what the space is and what it does with Google data, without signing in", async () => {
  const routes = spacePagesRoutes(() => ({ name: 'Acme <Dev>', origin: 'https://dev.example.com', contact: 'ops@example.com' }))
  const about = await routes.request('/about')
  assert.equal(about.status, 200)
  assert.match(about.headers.get('content-type')!, /text\/html/)
  const a = await about.text()
  assert.ok(a.includes('<h1>Acme &lt;Dev&gt;</h1>') && !a.includes('<Dev>')) // the space name is escaped
  assert.match(a, /The private workspace of the team at dev\.example\.com\./)
  assert.match(a, /only the files Acme &lt;Dev&gt; creates<\/strong> \(Google's <code>drive\.file<\/code> permission\)/)
  assert.match(a, /<a href="\/privacy">Privacy policy<\/a>/)
  assert.match(a, /mailto:ops@example\.com/)

  const p = await (await routes.request('/privacy')).text()
  assert.match(p, /Last updated \d{4}-\d{2}-\d{2}/)
  assert.match(p, /Google API Services User Data Policy<\/a>,\s+including the Limited Use requirements/)
  assert.match(p, /does not sell Google user data/)
  assert.match(p, /revokes Acme &lt;Dev&gt;'s access at Google/)
  // No contact set yet: the pages still read sensibly.
  const bare = await (await spacePagesRoutes(() => ({ name: 'DevDash', origin: 'https://x.io', contact: null })).request('/privacy')).text()
  assert.match(bare, /Questions about this policy or your data: the people who run DevDash\./)
})

test('the contact email is kept when the app is edited, cleared on request; a removed member loses their Drive connection', async () => {
  const t = setup()
  const info = t.storage.setApp(t.ann, { clientId: CLIENT, clientSecret: 'GOCSPX-shh', contactEmail: 'ops@example.com' })
  assert.deepEqual([info.contactEmail, info.homeUrl, info.privacyUrl], ['ops@example.com', 'https://dev.example.com/about', 'https://dev.example.com/privacy'])
  t.storage.setApp(t.ann, { clientId: CLIENT })
  assert.equal(t.storage.contactEmail(), 'ops@example.com')
  t.storage.setApp(t.ann, { clientId: CLIENT, contactEmail: '' })
  assert.equal(t.storage.contactEmail(), null)

  await connect(t)
  const handle = t.storage.forLaunch(2)!.handle
  await t.storage.memberRemoved(2)
  assert.ok(t.google.calls.some((c) => c.url.endsWith('/revoke')))
  assert.equal(t.db.prepare('select count(*) as n from member_storage').get()!.n, 0)
  await assert.rejects(() => t.storage.token(handle), /disconnected/)
})
