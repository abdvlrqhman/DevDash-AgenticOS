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

import { computeObservationFingerprint, type BrowserObservation, type CdpAction, type CdpActionResult } from './cdp.ts'

function cdpFixture(
  respond: (prompt: string, stepIndex: number) => Promise<string>,
  opts?: {
    observe?: (step: number) => BrowserObservation
    actCdp?: (a: CdpAction) => Promise<CdpActionResult>
  },
) {
  const db = openDb(':memory:')
  const users = ['admin', 'member'].map((role, i) => {
    const user = { id: i + 1, name: 'User' + i, username: 'user' + i, email: i + '@test', role } as User
    db.prepare("insert into users(id,name,username,email,role,password_hash,totp_secret) values (?,?,?,?,?,'x','x')")
      .run(user.id, user.name, user.username, user.email, user.role)
    return user
  })
  const [admin, member] = users as [User, User]
  const cdpActions: CdpAction[] = []
  const prompts: string[] = []
  const notifications: { userId: number; kind: string; title: string; body?: string }[] = []
  let callIndex = 0
  let obsCount = 0
  let curUrl = 'https://example.com/'

  const defaultObs = (idx: number): BrowserObservation => {
    const base = {
      url: curUrl,
      title: `Page ${idx}`,
      elements: [
        { ref: 'e1', role: 'textbox', name: 'Search', tag: 'input', value: '' },
        { ref: 'e2', role: 'button', name: 'Next', tag: 'button' },
        { ref: 'e9', role: 'button', name: 'Place order ($199)', tag: 'button' },
      ],
      text: `Content for step ${idx}`,
    }
    return {
      mode: 'cdp',
      ...base,
      tabs: [{ index: 0, id: 't1', title: base.title, url: base.url, active: true }],
      scroll: { y: 0, maxY: 600, height: 900 },
      fingerprint: computeObservationFingerprint(base),
    }
  }

  const chat = browserChat(
    db,
    {
      screen: async () => DEFAULT_SCREEN,
      act: async () => {},
      observe: async () => (opts?.observe ? opts.observe(obsCount++) : defaultObs(obsCount++)),
      actCdp: async (a) => {
        cdpActions.push(a)
        if (opts?.actCdp) return opts.actCdp(a)
        if (a.kind === 'navigate') curUrl = a.url
        if (a.kind === 'extract_text') return { summary: 'Extracted 18 chars', url: curUrl, extractedText: 'Extracted fact 42.' }
        return { summary: `Ran ${a.kind}`, url: curUrl }
      },
    },
    async (_owner, _system, prompt) => {
      prompts.push(prompt)
      return respond(prompt, callIndex++)
    },
    async () => ({ models: DEFAULT_T3_MODELS }),
    (userId, kind, n) => { notifications.push({ userId, kind, title: n.title, body: n.body }) },
  )

  const mw = authMiddleware({
    sessionUser: (token?: string) => {
      const user = users.find((u) => u.username === token)
      return user ? { user } : null
    },
  } as AuthService)
  const app = browserRoutes({ status: async () => ({ running: true }) } as BrowserService, chat, mw)
  app.onError((e, c) => c.text(e.message, e instanceof AppError ? e.status : 500))
  const request = (path: string, user?: User, method = 'GET', body?: object) => app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie: user ? '__Host-devdash=' + user.username : '' },
    ...(body && { body: JSON.stringify(body) }),
  })
  return { db, admin, member, chat, cdpActions, prompts, notifications, request }
}

async function waitIdle(chat: ReturnType<typeof browserChat>, user: User) {
  for (let i = 0; i < 600 && chat.state(user).busy; i++) await delay(10)
  assert.equal(chat.state(user).busy, false)
  return chat.state(user)
}

test('persistent CDP run executes >8 steps with plan, scratchpad, extract_text, and completion notification', async () => {
  const { admin, chat, cdpActions, prompts, notifications } = cdpFixture(async (_prompt, idx) => {
    if (idx < 10) {
      return JSON.stringify({
        kind: idx === 5 ? 'extract_text' : 'navigate',
        ...(idx === 5 ? { selector: 'main', note: 'Specs' } : { url: `https://example.com/page-${idx + 1}` }),
        plan: [
          { id: 'p1', text: 'Collect 10 pages', status: idx < 9 ? 'in_progress' : 'done' },
        ],
        scratchpadAppend: idx === 0 ? 'Started research' : undefined,
      })
    }
    return JSON.stringify({ kind: 'done', reply: 'Collected all 10 pages.' })
  })

  chat.send(admin, crypto.randomUUID(), 'Research 10 pages', { maxSteps: 25 })
  const st = await waitIdle(chat, admin)
  assert.equal(st.run?.status, 'completed')
  assert.equal(st.run?.stepCount, 10)
  assert.equal(st.run?.result, 'Collected all 10 pages.')
  assert.equal(st.run?.plan[0]?.status, 'done')
  assert.match(st.run?.scratchpad ?? '', /Started research/)
  assert.match(st.run?.scratchpad ?? '', /\[Specs\] Extracted fact 42\./)
  assert.equal(cdpActions.length, 10)
  // Working memory is carried into later prompts
  assert.match(prompts.at(-1) ?? '', /Extracted fact 42/)
  assert.ok(notifications.some((n) => n.kind === 'finished' && n.userId === admin.id))
})

test('ask_user pauses run in waiting_user, notifies user, and resumes cleanly with steering message', async () => {
  const replies = [
    JSON.stringify({
      kind: 'ask_user',
      category: 'login',
      reason: 'Please sign in to Example in the shared browser, then click Continue.',
      plan: [{ id: 'p1', text: 'Sign in', status: 'in_progress' }],
      scratchpadAppend: 'Reached login screen',
    }),
    JSON.stringify({
      kind: 'done',
      reply: 'Finished after login.',
      plan: [{ id: 'p1', text: 'Sign in', status: 'done' }],
    }),
  ]
  const { admin, chat, prompts, notifications, request } = cdpFixture(async () => replies.shift()!)

  const post = await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'Check my orders' })
  assert.equal(post.status, 202)
  const paused = await waitIdle(chat, admin)
  assert.equal(paused.run?.status, 'waiting_user')
  assert.equal(paused.run?.canResume, true)
  assert.match(paused.run?.pauseReason ?? '', /sign in/i)
  assert.ok(notifications.some((n) => n.kind === 'needs_you'))

  const res = await request(`/chat/runs/${paused.run!.id}/resume`, admin, 'POST', { message: 'Signed in now' })
  assert.equal(res.status, 202)
  const done = await waitIdle(chat, admin)
  assert.equal(done.run?.status, 'completed')
  assert.equal(done.run?.result, 'Finished after login.')
  assert.match(prompts[1] ?? '', /Signed in now/)
  assert.match(prompts[1] ?? '', /Reached login screen/)
})

test('destructive action guardrail pauses before clicking Place order until user confirms', async () => {
  const replies = [
    JSON.stringify({ kind: 'click', ref: 'e9' }),
    JSON.stringify({ kind: 'click', ref: 'e9' }),
    JSON.stringify({ kind: 'done', reply: 'Order placed.' }),
  ]
  const { admin, chat, cdpActions, notifications, request } = cdpFixture(async () => replies.shift()!)

  chat.send(admin, crypto.randomUUID(), 'Finish checkout')
  const blocked = await waitIdle(chat, admin)
  assert.equal(blocked.run?.status, 'waiting_user')
  assert.match(blocked.run?.pauseReason ?? '', /Confirmation required.*Place order/i)
  assert.equal(cdpActions.length, 0)
  assert.ok(notifications.some((n) => n.kind === 'needs_you'))

  await request(`/chat/runs/${blocked.run!.id}/resume`, admin, 'POST', { message: 'confirm' })
  const done = await waitIdle(chat, admin)
  assert.equal(done.run?.status, 'completed')
  assert.equal(cdpActions.length, 1)
  assert.equal(cdpActions[0]?.kind, 'click')
})

test('stall detection injects warning and auto-pauses into waiting_user on repeated identical actions', async () => {
  const staticObs: BrowserObservation = {
    mode: 'cdp',
    url: 'https://example.com/stuck',
    title: 'Stuck',
    tabs: [{ index: 0, id: 't1', title: 'Stuck', url: 'https://example.com/stuck', active: true }],
    elements: [{ ref: 'e2', role: 'button', name: 'Next', tag: 'button' }],
    text: 'Nothing changes',
    scroll: { y: 0, maxY: 0, height: 900 },
    fingerprint: 'same-fingerprint',
  }
  const { admin, chat, prompts, notifications } = cdpFixture(
    async () => JSON.stringify({ kind: 'click', ref: 'e2' }),
    { observe: () => staticObs },
  )

  chat.send(admin, crypto.randomUUID(), 'Click next until done')
  const st = await waitIdle(chat, admin)
  assert.equal(st.run?.status, 'waiting_user')
  assert.match(st.run?.pauseReason ?? '', /repeated the same step/i)
  assert.match(prompts.at(-1) ?? '', /stall_warning.*did not change/i)
  assert.ok(notifications.some((n) => n.kind === 'needs_you'))
})

test('pause, mid-run steer, and server restart recovery keep runs resumable', async () => {
  const gate = Promise.withResolvers<string>()
  let step = 0
  const { db, admin, chat, request } = cdpFixture(async () => {
    if (step++ === 0) return gate.promise
    return JSON.stringify({ kind: 'done', reply: 'Resumed and completed.' })
  })

  await request('/chat', admin, 'POST', { requestId: crypto.randomUUID(), message: 'Long task' })
  const runId = chat.state(admin).run!.id
  assert.equal((await request(`/chat/runs/${runId}/steer`, admin, 'POST', { message: 'Focus on section 2' })).status, 200)
  assert.equal((await request(`/chat/runs/${runId}/pause`, admin, 'POST')).status, 200)
  gate.resolve(JSON.stringify({ kind: 'scroll', direction: 'down' }))
  const paused = await waitIdle(chat, admin)
  assert.equal(paused.run?.status, 'paused')
  assert.deepEqual(paused.run?.pendingSteering, ['Focus on section 2'])

  // Simulate server restart while a run row was left running in SQLite
  db.prepare("update browser_runs set status = 'running', pause_reason = null where id = ?").run(runId)
  const recovered = browserChat(
    db,
    {
      screen: async () => DEFAULT_SCREEN,
      act: async () => {},
      observe: async () => ({
        mode: 'cdp', url: 'https://example.com/', title: 'Recovered',
        tabs: [{ index: 0, id: 't1', title: 'Recovered', url: 'https://example.com/', active: true }],
        elements: [], text: 'Recovered page', fingerprint: 'rec',
      }),
      actCdp: async () => ({ summary: 'ok', url: 'https://example.com/' }),
    },
    async () => JSON.stringify({ kind: 'done', reply: 'Finished after server restart.' }),
  )
  const afterBoot = recovered.state(admin)
  assert.equal(afterBoot.run?.status, 'paused')
  assert.match(afterBoot.run?.pauseReason ?? '', /server restarted/i)
  assert.equal(afterBoot.run?.canResume, true)

  recovered.resume(admin, runId)
  const completed = await waitIdle(recovered, admin)
  assert.equal(completed.run?.status, 'completed')
  assert.equal(completed.run?.result, 'Finished after server restart.')
})

test('post-navigation redirect to private metadata IP navigates away to about:blank and blocks run', async () => {
  let redirected = false
  const { admin, chat, cdpActions } = cdpFixture(
    async () => JSON.stringify({ kind: 'navigate', url: 'https://public.example.com/start' }),
    {
      observe: (n) => {
        const url = n > 0 && redirected ? 'http://169.254.169.254/latest/meta-data/' : 'https://public.example.com/'
        return {
          mode: 'cdp', url, title: 'Page', tabs: [{ index: 0, id: 't1', title: 'Page', url, active: true }],
          elements: [], text: 'Page', fingerprint: `fp-${n}`,
        }
      },
      actCdp: async (a) => {
        if (a.kind === 'navigate' && a.url.includes('public.example.com')) redirected = true
        return { summary: `Navigated ${a.kind}`, url: a.kind === 'navigate' ? a.url : undefined }
      },
    },
  )

  chat.send(admin, crypto.randomUUID(), 'Visit https://public.example.com/start')
  const st = await waitIdle(chat, admin)
  assert.equal(st.run?.status, 'failed')
  assert.match(st.run?.result ?? '', /local or private URL/i)
  assert.ok(cdpActions.some((a) => a.kind === 'navigate' && a.url === 'about:blank'))
})

test('normalizes verbose thoughts, long wait budgets, bracketed refs, plan synonyms, and retries once on malformed JSON', async () => {
  const db = openDb(':memory:')
  const admin = { id: 1, name: 'Ada', username: 'ada', email: 'ada@test', role: 'admin' } as User
  db.prepare("insert into users(id,name,username,email,role,password_hash,totp_secret) values (?,?,?,?,?,'x','x')").run(admin.id, admin.name, admin.username, admin.email, admin.role)
  const actions: CdpAction[] = []
  let callCount = 0

  const fakeObs = (url: string): BrowserObservation => ({
    mode: 'cdp',
    url,
    title: 'Speedtest',
    tabs: [{ index: 0, id: 't1', title: 'Speedtest', url, active: true }],
    elements: [{ ref: 'e9', role: 'button', name: 'GO', tag: 'button' }],
    text: 'Download 89.96 Mbps Upload 88.22 Mbps',
    fingerprint: computeObservationFingerprint({ url, title: 'Speedtest', elements: [], text: `page-${callCount}` }),
  })

  const chat = browserChat(
    db,
    {
      screen: async () => [],
      act: async () => {},
      observe: async () => fakeObs('https://www.speedtest.net/'),
      actCdp: async (action) => {
        actions.push(action)
        return { summary: `Executed ${action.kind}`, url: 'https://www.speedtest.net/' }
      },
    },
    async () => {
      callCount++
      if (callCount === 1) {
        // Bracketed ref, >240-char thought, plan status "completed", wrapped in prose
        return `Sure, here is the next step:\n\`\`\`json\n${JSON.stringify({
          kind: 'click',
          ref: '[e9]',
          thought: 'A'.repeat(320),
          plan: [{ id: 1, text: 'Run Ookla speed test', status: 'completed' }],
        })}\n\`\`\`\nLet me know if you want anything else.`
      }
      if (callCount === 2) {
        // Over-budget wait ms (25000 -> clamped to 15000)
        return JSON.stringify({ kind: 'wait_for', ms: 25000 })
      }
      if (callCount === 3) {
        // Malformed output -> should trigger 1 automatic retry instead of failing the run!
        return 'Oops I forgot to wrap this as JSON.'
      }
      return JSON.stringify({ kind: 'done', reply: 'Download 89.96 Mbps, Upload 88.22 Mbps.' })
    },
  )

  chat.send(admin, crypto.randomUUID(), 'Do speed tests')
  const reply = await finish(chat, admin)
  assert.equal(reply, 'Download 89.96 Mbps, Upload 88.22 Mbps.')
  assert.equal(callCount, 4)
  assert.equal(actions.length, 2)
  assert.deepEqual(actions[0], { kind: 'click', ref: 'e9', label: undefined, x: undefined, y: undefined })
  assert.deepEqual(actions[1], { kind: 'wait_for', selector: undefined, text: undefined, networkidle: undefined, ms: 15000 })
  assert.equal(chat.state(admin).run?.status, 'completed')
})
