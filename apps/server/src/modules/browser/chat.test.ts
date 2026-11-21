import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openDb } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'
import { authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import { browserChat, type BrowserChatModel } from './chat.ts'
import { browserRoutes } from './routes.ts'
import type { BrowserService } from './service.ts'
import { clickPoint, screenLines } from './screen.ts'

const DEFAULT_T3_MODELS = [
  { value: 'opencode/gpt-5.4', supportsSupervisor: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'antigravity/gemini-4-neon', supportsSupervisor: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'codex/gpt-5.4', supportsSupervisor: false, supportedEffortLevels: ['medium', 'high'] },
]

function fixture(
  choose = async () => '{"kind":"read"}',
  t3Catalog: Parameters<typeof browserChat>[3] = async () => ({ models: DEFAULT_T3_MODELS }),
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
  const actions: unknown[] = []
  const chat = browserChat(db, {
    act: async (a) => { actions.push(a) },
    screen: async () => [
      [{ text: 'Private tab title', x: 100, y: 20, w: 120, h: 20 }],
      [{ text: 'Documentation', x: 100, y: 160, w: 120, h: 20 }],
    ],
  }, async (owner, system, prompt, model) => {
    calls.push({ username: owner.username, prompt, model })
    return system.startsWith('Choose') ? choose() : 'The page shows Documentation.'
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
  assert.deepEqual(calls.map((c) => c.username), [admin.username, admin.username])
  assert.deepEqual(calls[0]!.model, { harness: 'claude', profile: 'default', model: 'sonnet', effort: null })
  assert.equal(calls[0]!.prompt, turn.message)
  assert.match(calls[1]!.prompt, /Documentation/)
  assert.doesNotMatch(calls[1]!.prompt, /Private tab title/)
  assert.deepEqual(chat.state(admin).turns, [])
  assert.equal(chat.state(member).turns.length, 1)
  assert.throws(() => chat.state(other), /grant/)
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: false })).status, 200)
  assert.equal((await request('/chat', member)).status, 403)
})

test('browser agent has its own per-admin settings independent of autopilot and enforces tool-free model validation', async () => {
  const { request, admin, member, chat, db, calls } = fixture()
  // Seed an Autopilot row with a completely different supervisor model to prove full independence.
  db.prepare("insert into autopilot(user_id, sv_harness, sv_profile, sv_model, sv_effort) values (?, 'opencode', 'work', 'custom-ap', null)")
    .run(admin.id)

  const initial = await (await request('/chat/settings', admin)).json()
  assert.deepEqual(initial, { model: { harness: 'claude', profile: 'default', model: 'sonnet', effort: null } })

  // Save a verified T3 Code Antigravity model with thinking level.
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

  // Autopilot settings must remain untouched.
  const apRow = db.prepare('select sv_harness, sv_profile, sv_model from autopilot where user_id = ?').get(admin.id) as Record<string, string>
  assert.deepEqual({ ...apRow }, { sv_harness: 'opencode', sv_profile: 'work', sv_model: 'custom-ap' })

  // Granted member sees active model summary (without profile) and uses the admin's dedicated Browser agent model.
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: true })).status, 200)
  const memberState = await (await request('/chat', member)).json() as { model: Record<string, unknown> }
  assert.deepEqual(memberState.model, { harness: 't3code', model: 'antigravity/gemini-4-neon', effort: 'low' })
  assert.equal('profile' in memberState.model, false)

  assert.equal((await request('/chat', member, 'POST', { requestId: crypto.randomUUID(), message: 'What is on screen?' })).status, 202)
  await finish(chat, member)
  assert.deepEqual(calls.map((c) => c.model), [
    { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
    { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
  ])

  // Invalid configurations must fail with 400 and leave the saved model intact.
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

  // Saved T3 Code model is still intact after all rejected writes.
  assert.deepEqual(await (await request('/chat/settings', admin)).json(), {
    model: { harness: 't3code', profile: 'default', model: 'antigravity/gemini-4-neon', effort: 'low' },
  })

  // Switching to OpenCode clears effort automatically and persists cleanly.
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
  // Update to another agent while the T3 catalog check is in flight.
  const fast = await request('/chat/settings', admin, 'PUT', { harness: 'opencode', profile: 'default', model: '' })
  assert.equal(fast.status, 200)
  gate.resolve({ models: DEFAULT_T3_MODELS })
  const slow = await pending
  assert.equal(slow.status, 409)
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

test('a disabled granting admin immediately loses the ability to sponsor a member', () => {
  const { admin, member, chat, db } = fixture()
  chat.setAccess(admin, member.id, true)
  db.prepare('update users set disabled_at=unixepoch() where id=?').run(admin.id)
  assert.equal(chat.allowed(admin.id), false)
  assert.equal(chat.allowed(member.id), false)
})

test('model output can only click the named label or open a literal HTTP(S) address from the current request', async () => {
  for (const [message, plan, action] of [
    ['Click Documentation', { kind: 'click', label: 'Documentation' }, { kind: 'click', x: 160, y: 170 }],
    ['Open https://example.com', { kind: 'open', url: 'https://example.com' }, { kind: 'open', url: 'https://example.com/' }],
    ['Read this page', { kind: 'open', url: 'https://example.com' }, null],
    ['Open file:///etc/passwd', { kind: 'open', url: 'file:///etc/passwd' }, null],
    ['What is here?', { kind: 'click', label: 'Documentation' }, null],
    ['Scroll down', { kind: 'scroll', direction: 'down' }, { kind: 'scroll', direction: 'down' }],
  ] as const) {
    const { chat, admin, actions } = fixture(async () => JSON.stringify(plan))
    chat.send(admin, crypto.randomUUID(), message)
    await finish(chat, admin)
    assert.deepEqual(actions, action ? [action] : [])
  }
})

test('clicks require a unique contiguous label in the page area of the current screenshot', () => {
  const word = (n: number, x: number, y: number, text: string) => ['5', '1', '1', '1', y, n, x, y, '25', '12', '85', text].join('\t')
  const screen = screenLines([word(1, 10, 20, 'Next'), word(1, 10, 150, 'Next'), word(2, 40, 150, 'page')].join('\n'))
  assert.deepEqual(clickPoint(screen, 'next page'), { x: 38, y: 156 })
  assert.throws(() => clickPoint([...screen, ...screen], 'Next page'), /more than once/)
  assert.throws(() => clickPoint(screen, 'elsewhere'), /couldn’t find/)
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
  const { request, admin, member, chat } = fixture(() => hold ? gate.promise : Promise.resolve('{"kind":"read"}'))
  assert.equal((await request('/chat/access/2', admin, 'PUT', { allowed: true })).status, 200)

  assert.equal((await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'Admin turn' })).status, 202)
  await finish(chat, admin)
  assert.equal((await request('/chat', member, 'POST', { requestId: crypto.randomUUID(), message: 'Member turn' })).status, 202)
  await finish(chat, member)
  assert.equal(chat.state(admin).turns.length, 1)
  assert.equal(chat.state(member).turns.length, 1)

  // Member clearing only clears member's own turns; admin's history stays intact.
  assert.equal((await request('/chat', member, 'DELETE')).status, 200)
  assert.equal(chat.state(member).turns.length, 0)
  assert.equal(chat.state(admin).turns.length, 1)

  // While admin has an active turn, admin cannot clear (409), while member still can.
  hold = true
  assert.equal((await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'In flight' })).status, 202)
  assert.equal((await request('/chat', admin, 'DELETE')).status, 409)
  assert.equal((await request('/chat', member, 'DELETE')).status, 200)
  gate.resolve('{"kind":"read"}')
  await finish(chat, admin)
  assert.equal((await request('/chat', admin, 'DELETE')).status, 200)
  assert.equal(chat.state(admin).turns.length, 0)
})
