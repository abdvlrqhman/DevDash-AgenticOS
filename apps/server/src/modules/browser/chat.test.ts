import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openDb } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'
import { authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import { browserChat, type BrowserAction, type BrowserChatModel } from './chat.ts'
import { browserRoutes } from './routes.ts'
import type { BrowserService } from './service.ts'
import { clickPoint, screenLines, screenSnapshot, type Screen } from './screen.ts'

const DEFAULT_T3_MODELS = [
  { value: 'opencode/gpt-5.4', supportsSupervisor: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'antigravity/gemini-4-neon', supportsSupervisor: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'codex/gpt-5.4', supportsSupervisor: false, supportedEffortLevels: ['medium', 'high'] },
]

const DEFAULT_SCREEN: Screen = [
  [{ text: 'Private tab title', x: 100, y: 20, w: 120, h: 20 }],
  [{ text: 'Documentation', x: 100, y: 160, w: 120, h: 20 }],
]

function fixture(
  respond: (prompt: string, stepIndex: number) => Promise<string> = async () => '{"kind":"done","reply":"The page shows Documentation."}',
  t3Catalog: Parameters<typeof browserChat>[3] = async () => ({ models: DEFAULT_T3_MODELS }),
  screenFn?: (actions: BrowserAction[]) => Screen,
) {
  const db = openDb(':memory:')
  const users = ['admin', 'member', 'member'].map((role, i) => {
    const user = { id: i + 1, name: 'User' + i, username: 'user' + i, email: i + '@test', role } as User
    db.prepare("insert into users(id,name,username,email,role,password_hash,totp_secret) values (?,?,?,?,?,'x','x')")
      .run(user.id, user.name, user.username, user.email, user.role)
    return user
  })
  const [admin, member, other] = users as [User, User, User]
  const calls: { username: string; prompt: string; model: BrowserChatModel }[] = []
  const actions: BrowserAction[] = []
  let callIndex = 0
  const chat = browserChat(db, {
    act: async (a) => { actions.push(a) },
    screen: async () => (screenFn ? screenFn(actions) : DEFAULT_SCREEN),
  }, async (owner, _system, prompt, model) => {
    calls.push({ username: owner.username, prompt, model })
    return respond(prompt, callIndex++)
  }, t3Catalog)
  const mw = authMiddleware({ sessionUser: (token?: string) => {
    const user = users.find((u) => u.username === token)
    return user ? { user } : null
  } } as AuthService)
  const app = browserRoutes({ status: async () => ({ running: true }) } as BrowserService, chat, mw)
  app.onError((e, c) => c.text(e.message, e instanceof AppError ? e.status : 500))
  const request = (path: string, user?: User, method = 'GET', body?: object) => app.request(path, {
    method, headers: { 'content-type': 'application/json', cookie: user ? '__Host-devdash=' + user.username : 'dd_watch=watch-only' },
    ...(body && { body: JSON.stringify(body) }),
  })
  return { admin, member, other, chat, db, calls, actions, request }
}

async function finish(chat: ReturnType<typeof browserChat>, user: User) {
  for (let i = 0; i < 600 && chat.state(user).busy; i++) await delay(10)
  assert.equal(chat.state(user).busy, false)
  return chat.state(user).turns.at(-1)!.reply
}

test('only admins grant access, watch links cannot chat, and granted members share the admin model with private transcripts', async () => {
  const { request, admin, member, other, chat, calls, actions } = fixture()
  const turn = { requestId: crypto.randomUUID(), message: 'What is on screen?' }
  for (const [user, status] of [[undefined, 401], [member, 403]] as const) {
    assert.equal((await request('/chat', user, 'POST', turn)).status, status)
    assert.equal((await request('/chat', user)).status, status)
    assert.equal((await request('/chat', user, 'DELETE')).status, status)
    assert.equal((await request('/chat/cancel', user, 'POST')).status, status)
    assert.equal((await request('/chat/access', user)).status, status)
    assert.equal((await request('/chat/access/2', user, 'PUT', { allowed: true })).status, status)
    assert.equal((await request('/chat/settings', user)).status, status)
    assert.equal((await request('/chat/settings', user, 'PUT', { harness: 'opencode', model: '' })).status, status)
  }
  assert.equal(calls.length, 0)
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: true })).status, 200)
  assert.equal((await request('/chat', member, 'POST', turn)).status, 202)
  await finish(chat, member)
  assert.equal((await request('/chat', member, 'POST', turn)).status, 202)
  assert.deepEqual(actions, [])
  assert.deepEqual(calls.map((c) => c.username), [admin.username])
  assert.deepEqual(calls[0]!.model, { harness: 'claude', profile: 'default', model: 'sonnet', effort: null })
  assert.match(calls[0]!.prompt, /What is on screen\?/)
  assert.match(calls[0]!.prompt, /Documentation/)
  assert.doesNotMatch(calls[0]!.prompt, /Private tab title/)
  assert.deepEqual(chat.state(admin).turns, [])
  assert.equal(chat.state(member).turns.length, 1)
  assert.throws(() => chat.state(other), /grant/)
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: false })).status, 200)
  assert.equal((await request('/chat', member)).status, 403)
})

test('browser agent has its own per-admin settings independent of autopilot and enforces tool-free model validation', async () => {
  const { request, admin, member, chat, db, calls } = fixture()
  db.prepare("insert into autopilot(user_id, sv_harness, sv_profile, sv_model, sv_effort) values (?, 'opencode', 'work', 'custom-ap', null)")
    .run(admin.id)

  const initial = await (await request('/chat/settings', admin)).json()
  assert.deepEqual(initial, { model: { harness: 'claude', profile: 'default', model: 'sonnet', effort: null } })

  const t3Res = await request('/chat/settings', admin, 'PUT', {
    harness: 't3code',
    profile: 'default',
    model: 'antigravity/gemini-4-neon',
    effort: 'low',
  })
  assert.equal(t3Res.status, 200)
  assert.deepEqual(await t3Res.json(), {
    model: { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
  })

  const apRow = db.prepare('select sv_harness, sv_profile, sv_model from autopilot where user_id = ?').get(admin.id) as Record<string, string>
  assert.deepEqual({ ...apRow }, { sv_harness: 'opencode', sv_profile: 'work', sv_model: 'custom-ap' })

  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: true })).status, 200)
  const memberState = await (await request('/chat', member)).json() as { model: Record<string, unknown> }
  assert.deepEqual(memberState.model, { harness: 't3code', model: 'antigravity/gemini-4-neon', effort: 'low' })
  assert.equal('profile' in memberState.model, false)

  assert.equal((await request('/chat', member, 'POST', { requestId: crypto.randomUUID(), message: 'What is on screen?' })).status, 202)
  await finish(chat, member)
  assert.deepEqual(calls.map((c) => c.model), [
    { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
  ])

  for (const bad of [
    { harness: 'unknown', model: 'x' },
    { harness: 'codex', model: 'gpt-5' },
    { harness: 'claude', profile: 'BAD PROFILE!' },
    { harness: 't3code', profile: 'secondary', model: 'antigravity/gemini-4-neon' },
    { harness: 't3code', profile: 'default', model: '' },
    { harness: 't3code', profile: 'default', model: 'codex/gpt-5.4' },
    { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'max' },
    { harness: 'claude', profile: 'default', model: 'sonnet', effort: 'low' },
  ]) {
    const res = await request('/chat/settings', admin, 'PUT', bad)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${res.status}`)
  }

  assert.deepEqual(await (await request('/chat/settings', admin)).json(), {
    model: { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
  })

  const ocRes = await request('/chat/settings', admin, 'PUT', { harness: 'opencode', profile: 'work', model: 'openai/gpt-5' })
  assert.equal(ocRes.status, 200)
  assert.deepEqual(await ocRes.json(), {
    model: { harness: 'opencode', profile: 'work', model: 'openai/gpt-5', effort: null },
  })
})

test('concurrent browser agent update during T3 model verification returns 409', async () => {
  const gate = Promise.withResolvers<{ models: typeof DEFAULT_T3_MODELS }>()
  const { request, admin } = fixture(undefined, () => gate.promise)
  const pending = request('/chat/settings', admin, 'PUT', {
    harness: 't3code', profile: 'default', model: 'opencode/gpt-5.4', effort: 'medium',
  })
  const fast = await request('/chat/settings', admin, 'PUT', { harness: 'opencode', profile: 'default', model: '' })
  assert.equal(fast.status, 200)
  gate.resolve({ models: DEFAULT_T3_MODELS })
  const slow = await pending
  assert.equal(slow.status, 409)
})

test('multi-step browser control opens sites by name, clicks, types with submit, and presses keys', async () => {
  const { chat, admin, actions } = fixture(
    async (_prompt, step) => {
      if (step === 0) return JSON.stringify({ kind: 'open', url: 'https://www.youtube.com' })
      if (step === 1) return JSON.stringify({ kind: 'type', x: 568, y: 140, text: 'lofi beats', submit: true })
      if (step === 2) return JSON.stringify({ kind: 'click', x: 340, y: 420, label: 'Lofi Hip Hop Radio' })
      return JSON.stringify({ kind: 'done', reply: 'Opened YouTube, searched for lofi beats, and started Lofi Hip Hop Radio.' })
    },
    undefined,
    (taken) => {
      if (taken.length === 0) return DEFAULT_SCREEN
      if (taken.length === 1) return [[{ text: 'Search', x: 520, y: 130, w: 96, h: 20 }]]
      if (taken.length <= 4) return [[{ text: 'Lofi', x: 300, y: 410, w: 30, h: 20 }, { text: 'Hip', x: 335, y: 410, w: 25, h: 20 }, { text: 'Hop', x: 365, y: 410, w: 30, h: 20 }]]
      return [[{ text: 'Now playing', x: 200, y: 650, w: 120, h: 20 }]]
    },
  )

  chat.send(admin, crypto.randomUUID(), 'Open yt and play lofi beats')
  const reply = await finish(chat, admin)
  assert.match(reply ?? '', /Lofi Hip Hop Radio/)
  assert.deepEqual(actions, [
    { kind: 'open', url: 'https://www.youtube.com/' },
    { kind: 'click', x: 568, y: 140 },
    { kind: 'type', text: 'lofi beats' },
    { kind: 'press', key: 'Enter' },
    { kind: 'click', x: 340, y: 420 },
  ])
})

test('blocks dangerous URLs, non-requested private/loopback URLs, and clicks on browser chrome (y < 100)', async () => {
  for (const [message, plan, expectedAction] of [
    ['Open https://example.com', { kind: 'open', url: 'https://example.com' }, { kind: 'open', url: 'https://example.com/' }],
    ['Open yt', { kind: 'open', url: 'https://www.youtube.com' }, { kind: 'open', url: 'https://www.youtube.com/' }],
    ['Open file:///etc/passwd', { kind: 'open', url: 'file:///etc/passwd' }, null],
    ['Open secret', { kind: 'open', url: 'https://user:pass@example.com' }, null],
    ['Open metadata', { kind: 'open', url: 'http://169.254.169.254/latest/meta-data/' }, null],
    ['Open local', { kind: 'open', url: 'http://127.0.0.1:8787/' }, null],
    ['Open http://localhost:3000/', { kind: 'open', url: 'http://localhost:3000/' }, { kind: 'open', url: 'http://localhost:3000/' }],
    ['Click tab bar', { kind: 'click', x: 100, y: 20 }, null],
    ['Click Documentation', { kind: 'click', label: 'Documentation' }, { kind: 'click', x: 160, y: 170 }],
    ['Go back', { kind: 'press', key: 'Back' }, { kind: 'press', key: 'Back' }],
    ['Scroll down', { kind: 'scroll', direction: 'down' }, { kind: 'scroll', direction: 'down' }],
  ] as const) {
    const { chat, admin, actions } = fixture(
      async (_p, step) => step === 0 ? JSON.stringify(plan) : JSON.stringify({ kind: 'done', reply: 'Done.' }),
      undefined,
      (taken) => taken.length === 0 ? DEFAULT_SCREEN : [[{ text: 'Updated page', x: 100, y: 200, w: 120, h: 20 }]],
    )
    chat.send(admin, crypto.randomUUID(), message)
    await finish(chat, admin)
    assert.deepEqual(actions, expectedAction ? [expectedAction] : [], `case: ${message}`)
  }
})

test('revoking and regranting during a model request cancels the outstanding action, and concurrent sends serialize', async () => {
  const gate = Promise.withResolvers<string>()
  const { admin, member, chat, actions } = fixture(() => gate.promise)
  chat.setAccess(admin, member.id, true)
  chat.send(member, crypto.randomUUID(), 'Scroll down')
  assert.throws(() => chat.send(admin, crypto.randomUUID(), 'Read screen'), /another request/)
  chat.setAccess(admin, member.id, false)
  chat.setAccess(admin, member.id, true)
  gate.resolve('{"kind":"scroll","direction":"down"}')
  assert.match((await finish(chat, member))!, /grant/)
  assert.deepEqual(actions, [])
})

test('stopping an in-flight turn via /chat/cancel aborts cleanly without taking further actions', async () => {
  const gate = Promise.withResolvers<string>()
  const { admin, chat, actions, request } = fixture(() => gate.promise)
  chat.send(admin, crypto.randomUUID(), 'Open yt')
  assert.equal(chat.state(admin).canStop, true)
  assert.equal((await request('/chat/cancel', admin, 'POST')).status, 200)
  gate.resolve('{"kind":"open","url":"https://www.youtube.com"}')
  assert.match((await finish(chat, admin))!, /Stopped/)
  assert.deepEqual(actions, [])
})

test('a disabled granting admin immediately loses the ability to sponsor a member', () => {
  const { admin, member, chat, db } = fixture()
  chat.setAccess(admin, member.id, true)
  db.prepare('update users set disabled_at=unixepoch() where id=?').run(admin.id)
  assert.equal(chat.allowed(admin.id), false)
  assert.equal(chat.allowed(member.id), false)
})

test('clicks require a unique contiguous label and screenSnapshot excludes browser chrome', () => {
  const word = (n: number, x: number, y: number, text: string) => ['5', '1', '1', '1', y, n, x, y, '25', '12', '85', text].join('\t')
  const screen = screenLines([word(1, 10, 20, 'Next'), word(1, 10, 150, 'Next'), word(2, 40, 150, 'page')].join('\n'))
  assert.deepEqual(clickPoint(screen, 'next page'), { x: 38, y: 156 })
  assert.throws(() => clickPoint([...screen, ...screen], 'Next page'), /more than once/)
  assert.throws(() => clickPoint(screen, 'elsewhere'), /couldn’t find/)
  const snap = screenSnapshot(screen)
  assert.equal(snap, '(38,156) Next page')
})

test('supervisor rate-limit errors surface cleanly without running browser actions', async () => {
  const { chat, admin, actions } = fixture(async () => { throw new Error('The T3 Antigravity supervisor reached its rate limit.') })
  chat.send(admin, crypto.randomUUID(), 'Open https://example.com')
  const reply = await finish(chat, admin)
  assert.match(reply ?? '', /usage limit/i)
  assert.match(reply ?? '', /Browser agent settings/i)
  assert.doesNotMatch(reply ?? '', /Autopilot/i)
  assert.deepEqual(actions, [])
})

test('clearing browser chat only removes the caller’s own history and rejects while their turn is in flight', async () => {
  const gate = Promise.withResolvers<string>()
  let hold = false
  const { request, admin, member, chat } = fixture(() => hold ? gate.promise : Promise.resolve('{"kind":"done","reply":"OK."}'))
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: true })).status, 200)

  assert.equal((await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'Admin turn' })).status, 202)
  await finish(chat, admin)
  assert.equal((await request('/chat', member, 'POST', { requestId: crypto.randomUUID(), message: 'Member turn' })).status, 202)
  await finish(chat, member)
  assert.equal(chat.state(admin).turns.length, 1)
  assert.equal(chat.state(member).turns.length, 1)

  assert.equal((await request('/chat', member, 'DELETE')).status, 200)
  assert.equal(chat.state(member).turns.length, 0)
  assert.equal(chat.state(admin).turns.length, 1)

  hold = true
  assert.equal((await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'In flight' })).status, 202)
  assert.equal((await request('/chat', admin, 'DELETE')).status, 409)
  assert.equal((await request('/chat', member, 'DELETE')).status, 200)
  gate.resolve('{"kind":"done","reply":"OK."}')
  await finish(chat, admin)
  assert.equal((await request('/chat', admin, 'DELETE')).status, 200)
  assert.equal(chat.state(admin).turns.length, 0)
})

test('browser URL filter blocks internal/IPv6-private hosts while allowing public fc*/fd* domains and rejects control chars in type', async () => {
  const replies = [
    JSON.stringify({ kind: 'open', url: 'https://fdic.gov/' }),
    JSON.stringify({ kind: 'done', reply: 'Opened FDIC.' }),
    JSON.stringify({ kind: 'open', url: 'http://devdash-browser:8080/' }),
    JSON.stringify({ kind: 'open', url: 'http://localhost./' }),
    JSON.stringify({ kind: 'open', url: 'http://[fe90::1]/' }),
    JSON.stringify({ kind: 'type', text: 'bad\tcontrol' }),
  ]
  const { admin, chat, actions } = fixture(async () => replies.shift() ?? JSON.stringify({ kind: 'done', reply: 'ok' }))

  chat.send(admin, crypto.randomUUID(), 'Open FDIC')
  assert.equal(await finish(chat, admin), 'Opened FDIC.')
  assert.deepEqual(actions, [{ kind: 'open', url: 'https://fdic.gov/' }])

  for (const [label, expected] of [
    ['Open docker service', /local or private URL/],
    ['Open localhost with dot', /local or private URL/],
    ['Open ipv6 link-local', /local or private URL/],
    ['Type control char', /unreadable browser instruction/],
  ] as const) {
    chat.send(admin, crypto.randomUUID(), label)
    assert.match((await finish(chat, admin)) ?? '', expected)
  }
  assert.equal(actions.length, 1)
})
