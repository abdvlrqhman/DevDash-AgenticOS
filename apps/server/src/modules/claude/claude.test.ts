import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { ProjectsService } from '../projects/service.ts'
import { claudeService, checkTailnetMcp, isTailnetHost, requestNotification, sumTurns } from './service.ts'
import type { TurnRow } from './repo.ts'

function setup({ tailnetConnected }: { tailnetConnected?: (userId: number) => boolean } = {}) {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  add.run(3, 'c@x.io', 'cat', 'Cat')
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, started) values ('s1', 1, 'Fix login', '/home/ann', 1, 1)").run()
  const notified: { userId: number; title: string }[] = []
  const sent: Record<string, unknown>[] = []
  let onEvent: ((username: string, ev: Record<string, unknown>) => void) | undefined
  const agents = {
    onEvent: (fn: (username: string, ev: Record<string, unknown>) => void) => { onEvent = fn },
    request: async (_u: string, req: Record<string, unknown>) => {
      sent.push(req)
      return { ok: true }
    },
  } as unknown as AgentsService
  const claude = claudeService({
    db, agents, hub: createHub(), projects: {} as ProjectsService,
    notify: async (userId, _kind, n) => void notified.push({ userId, title: n.title }),
    tailnetConnected,
  })
  const user = (id: number, name: string): User => ({ id, name, username: name.toLowerCase(), email: '', role: 'member' })
  /** Fires an agent event as Ann's agent would, so the reconcile/notify path can be exercised. */
  const emit = (ev: Record<string, unknown>) => onEvent?.('ann', ev)
  return { claude, db, notified, sent, emit, ann: user(1, 'Ann'), bob: user(2, 'Bob'), cat: user(3, 'Cat') }
}

test('watching a shared session: ask to join, the owner lets one person in, only they can send', async () => {
  const { claude, notified, ann, bob, cat } = setup()
  assert.equal((await claude.get(bob, 's1')).canSend, false)
  claude.askToJoin(bob, 's1')
  claude.askToJoin(bob, 's1') // a second tap within a minute doesn't notify again
  assert.deepEqual(notified.map((n) => n.userId), [1])

  assert.throws(() => claude.setWriter(bob, 's1', 2, true), /Only the owner/)
  assert.deepEqual(claude.setWriter(ann, 's1', 2, true).writers, [{ id: 2, name: 'Bob' }])
  assert.equal((await claude.get(bob, 's1')).canSend, true)
  assert.equal((await claude.get(cat, 's1')).canSend, false)
  assert.throws(() => claude.askToJoin(bob, 's1'), /already/)

  claude.setWriter(ann, 's1', 2, false)
  assert.equal((await claude.get(bob, 's1')).canSend, false)
})

test('requestNotification: a question leads with the question and its options; plans and permissions stay actionable', () => {
  const q = requestNotification('AskUserQuestion', {
    questions: [{ question: 'Which database should we use?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
  }, 'Fix login')
  assert.equal(q.title, 'Which database should we use?')
  assert.equal(q.body, 'Postgres · SQLite')

  // Several questions: the body says how many more are waiting; no options falls back to a prompt to open it.
  const multi = requestNotification('AskUserQuestion', {
    questions: [{ question: 'Pick a DB?' }, { question: 'Pick a UI?' }],
  }, 'Fix login')
  assert.equal(multi.title, 'Pick a DB?')
  assert.match(multi.body, /Tap to answer\. \(\+1 more\)/)

  const plan = requestNotification('ExitPlanMode', { plan: '# Plan' }, 'Fix login')
  assert.deepEqual(plan, { title: "Claude's plan is ready: Fix login", body: 'Approve it or send changes.' })

  const perm = requestNotification('Bash', { command: 'rm -rf build' }, 'Fix login')
  assert.equal(perm.title, 'Claude needs permission: Fix login')
  assert.equal(perm.body, 'Allow Bash: rm -rf build')
})

test('a pending question pings the owner and the teammates let in to send, not mere watchers', () => {
  const { claude, notified, emit, ann } = setup()
  claude.setWriter(ann, 's1', 2, true) // Bob can send; Cat only watches
  notified.length = 0 // ignore the "you can send now" ping from setWriter
  emit({ ev: 'claude.permission', id: 's1', requestId: 'r1', toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Use React or Vue?', options: [{ label: 'React' }, { label: 'Vue' }] }] } })
  assert.deepEqual(notified.map((n) => n.userId).sort(), [1, 2])
  assert.equal(notified[0]!.title, 'Use React or Vue?')
})

test('comments: anyone who can see the session; the owner hears about others', async () => {
  const { claude, notified, ann, bob } = setup()
  claude.comment(bob, 's1', '  Try the staging DB first  ')
  claude.comment(ann, 's1', 'On it')
  const { comments } = claude.comments(bob, 's1')
  assert.deepEqual(comments.map((c) => [c.user.name, c.body]), [['Bob', 'Try the staging DB first'], ['Ann', 'On it']])
  assert.deepEqual(notified, [{ userId: 1, title: 'Bob commented on Fix login' }])
  assert.equal((await claude.get(ann, 's1')).comments, 2)
})

test('attachments: PDFs and text become documents, other files are saved in the owner account', async () => {
  const { claude, sent, ann } = setup()
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  await claude.send(ann, 's1', 'Look at these', [], [
    { name: 'spec.pdf', mediaType: 'application/pdf', data: b64('%PDF-1.4') },
    { name: 'notes.md', mediaType: '', data: b64('# Notes') },
    { name: '../../etc/data.zip', mediaType: 'application/zip', data: b64('PK\0\0') },
  ])
  const write = sent.find((r) => r.op === 'fs.write')!
  assert.match(String(write.path), /^\/home\/ann\/\.cache\/devdash\/uploads\/s1\/[0-9a-f]{8}\/data\.zip$/)
  const msg = sent.find((r) => r.op === 'claude.send')!
  const content = msg.content as { type: string; title?: string; text?: string; source?: { type: string } }[]
  assert.deepEqual(content.map((c) => [c.type, c.title ?? null, c.source?.type ?? null]), [
    ['document', 'spec.pdf', 'base64'], ['document', 'notes.md', 'text'], ['text', null, null],
  ])
  assert.match(content[2]!.text!, /^Look at these\n\nAttached files, saved on this server:\n- \/home\/ann\/.+\/data\.zip$/)
})

test('fast mode and Remote Control: fast is for anyone who can send, Remote Control only for the owner', async () => {
  const { claude, sent, ann, bob } = setup()
  claude.setWriter(ann, 's1', 2, true)
  const s = await claude.update(bob, 's1', { fastMode: true })
  assert.equal(s.fastMode, true)
  assert.deepEqual(sent.filter((r) => r.op === 'claude.set').map((r) => [r.key, r.value]), [['fast', true]])
  await assert.rejects(claude.update(bob, 's1', { remoteControl: true }), /Only the owner/)
})

test('tailnet MCP URL validation: tailnet addresses only, http(s) only', () => {
  // 100.64.0.0/10 CGNAT range and *.ts.net MagicDNS names pass
  assert.equal(isTailnetHost('100.64.0.1'), true)
  assert.equal(isTailnetHost('100.102.226.36'), true)
  assert.equal(isTailnetHost('100.127.255.255'), true)
  assert.equal(isTailnetHost('ida-box.tail1234.ts.net'), true)
  assert.equal(isTailnetHost('ida-box.tail1234.ts.net.'), true)
  // outside the range, public IPs, localhost and other names fail
  assert.equal(isTailnetHost('100.63.0.1'), false)
  assert.equal(isTailnetHost('100.128.0.1'), false)
  assert.equal(isTailnetHost('8.8.8.8'), false)
  assert.equal(isTailnetHost('127.0.0.1'), false)
  assert.equal(isTailnetHost('localhost'), false)
  assert.equal(isTailnetHost('evil.com'), false)
  assert.equal(isTailnetHost('ts.net'), false)

  assert.equal(checkTailnetMcp('http://100.102.226.36:13337/mcp'), 'http://100.102.226.36:13337/mcp')
  assert.equal(checkTailnetMcp('  https://ida-box.tail1.ts.net/mcp  '), 'https://ida-box.tail1.ts.net/mcp')
  assert.throws(() => checkTailnetMcp('http://8.8.8.8/mcp'), /tailnet address/)
  assert.throws(() => checkTailnetMcp('http://127.0.0.1:13337/mcp'), /tailnet address/)
  assert.throws(() => checkTailnetMcp('ftp://100.64.0.1/mcp'), /http or https/)
  assert.throws(() => checkTailnetMcp('not a url'), /full MCP URL/)
})

test('reach my tailnet: owner-only, needs a connected node, validates the MCP, and rides along in the launch', async () => {
  const { claude, db, ann, bob, sent } = setup({ tailnetConnected: (id) => id === 1 })
  // non-owner can't touch it
  await assert.rejects(claude.update(bob, 's1', { reachTailnet: true }), /Only the owner/)
  // owner with no connected node is blocked
  const { claude: c2, ann: ann2 } = setup({ tailnetConnected: () => false })
  await assert.rejects(c2.update(ann2, 's1', { reachTailnet: true }), /Connect your tailnet/)
  // a bad MCP URL is rejected before anything is stored
  await assert.rejects(claude.update(ann, 's1', { reachTailnet: true, tailnetMcps: [{ name: 'x', url: 'http://8.8.8.8/mcp' }] }), /tailnet address/)

  // several MCPs, names turned into distinct safe slugs
  const dto = await claude.update(ann, 's1', { reachTailnet: true, tailnetMcps: [
    { name: 'IDA Pro', url: 'http://100.64.0.2:13337/mcp' },
    { name: '', url: 'http://100.64.0.3:13337/mcp' },
  ] })
  assert.equal(dto.reachTailnet, true)
  assert.deepEqual(dto.tailnetMcps, [
    { name: 'ida-pro', url: 'http://100.64.0.2:13337/mcp' },
    { name: 'mcp2', url: 'http://100.64.0.3:13337/mcp' },
  ])
  // an idle chat process is stopped so the next message relaunches with the proxy env
  assert.ok(sent.some((r) => r.op === 'claude.stop'))
  // the flag/mcps travel to the agent on the next send, inside the launch payload
  await claude.send(ann, 's1', 'ssh to my iphone', [])
  const launch = sent.find((r) => r.op === 'claude.send')!.launch as { reachTailnet: boolean; tailnetMcps: { name: string; url: string }[] }
  assert.equal(launch.reachTailnet, true)
  assert.equal(launch.tailnetMcps.length, 2)

  // the legacy single-URL field still works (stored as one entry named "ida")
  await claude.update(ann, 's1', { tailnetMcp: 'http://100.64.0.9:13337/mcp' })
  assert.deepEqual((await claude.update(ann, 's1', {})).tailnetMcps, [{ name: 'ida', url: 'http://100.64.0.9:13337/mcp' }])

  // clearing: empty list nulls it, and the row reflects the toggle off
  await claude.update(ann, 's1', { reachTailnet: false, tailnetMcps: [] })
  const row = db.prepare('select reach_tailnet, tailnet_mcps from claude_sessions where id = ?').get('s1') as { reach_tailnet: number; tailnet_mcps: string | null }
  assert.equal(row.reach_tailnet, 0)
  assert.equal(row.tailnet_mcps, '[]')
})

function inProject(sharing: 'private' | 'shared' | 'shared_can_send' = 'private') {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann Lee')
  add.run(2, 'b@x.io', 'bob', 'Bob Day')
  add.run(3, 'c@x.io', 'cat', 'Cat Moe')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1), (2, 'site', 'Site', 1)").run()
  const project = { id: 1, slug: 'app', name: 'App', session_sharing: sharing, instructions: 'Follow the house style.' }
  const projects = {
    bySlug: () => project, path: () => '/srv/devdash/projects/app', forPath: () => project,
  } as unknown as ProjectsService
  const agents = { onEvent: () => {}, request: async () => ({ ok: true }) } as unknown as AgentsService
  const claude = claudeService({ db, agents, hub: createHub(), projects, notify: async () => {} })
  const user = (id: number, name: string): User => ({ id, name, username: name.toLowerCase(), email: '', role: 'member' })
  return { db, claude, ann: user(1, 'Ann'), bob: user(2, 'Bob'), cat: user(3, 'Cat') }
}

test("a new session in a project follows the project's instructions (added to its system prompt)", async () => {
  const { db, claude, ann } = inProject()
  const s = await claude.create(ann, { prompt: '', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'app' })
  assert.equal((db.prepare('select instructions from claude_sessions where id = ?').get(s.id) as { instructions: string | null }).instructions, 'Follow the house style.')
  // A role brings its own instructions, so the project's don't override them.
  const r = await claude.create(ann, { prompt: '', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'app' }, { instructions: 'You are the CTO.' })
  assert.equal((db.prepare('select instructions from claude_sessions where id = ?').get(r.id) as { instructions: string | null }).instructions, 'You are the CTO.')
})

test('a project\'s sessions: yours, teammates\' shared ones and the roles\' unlisted ones; others\' private ones only counted', () => {
  const { db, claude, ann, bob } = inProject()
  const session = db.prepare(`insert into claude_sessions (id, owner_id, title, cwd, shared, listed, archived, status, project_id, last_activity_at)
    values (?, ?, ?, '/x', ?, ?, ?, ?, ?, ?)`)
  session.run('a1', 1, 'Ann private', 0, 1, 0, 'idle', 1, 100)
  session.run('b1', 2, 'Bob shared', 1, 1, 0, 'idle', 1, 300)
  session.run('b2', 2, 'Bob private', 0, 1, 0, 'idle', 1, 400)
  session.run('b3', 2, 'Bob private too', 0, 1, 0, 'working', 1, 50)
  session.run('c1', 3, 'Cat private', 0, 1, 0, 'idle', 1, 10)
  session.run('r1', 2, 'CTO', 1, 0, 0, 'idle', 1, 200) // a role's chat, run as Bob
  session.run('r2', 2, 'CTO: shift', 1, 0, 0, 'idle', 1, 250)
  session.run('x1', 1, 'Ann archived', 0, 1, 1, 'idle', 1, 999)
  session.run('o1', 1, 'Elsewhere', 1, 1, 0, 'idle', 2, 999)
  claude.labelSessions(() => new Map([
    ['r1', { kind: 'role' as const, role: { id: 7, name: 'CTO' } }], ['r2', { kind: 'shift' as const, role: { id: 7, name: 'CTO' } }],
  ]))

  const mine = claude.inProject(ann, 'app', false)
  assert.deepEqual(mine.sessions.map((s) => [s.id, s.kind, s.role?.name ?? null]), [
    ['b1', 'shared', null], ['r2', 'shift', 'CTO'], ['r1', 'role', 'CTO'], ['a1', 'mine', null],
  ])
  assert.deepEqual(mine.hidden, { count: 3, people: ['Bob Day', 'Cat Moe'] })
  const bobs = claude.inProject(bob, 'app', false)
  assert.deepEqual(bobs.sessions.map((s) => s.id).sort(), ['b1', 'b2', 'b3', 'r1', 'r2'])
  assert.deepEqual(bobs.hidden, { count: 2, people: ['Ann Lee', 'Cat Moe'] })
  assert.deepEqual(claude.inProject(ann, 'app', true).sessions.map((s) => s.id), ['x1'])
})

test('new sessions in a project start out as the project says, unless the person or the feature chose', async () => {
  const base = { prompt: '', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'bypassPermissions', mode: 'chat' as const, project: 'app' }
  const sharing = (s: { shared: boolean; sharedCanSend: boolean }) => [s.shared, s.sharedCanSend]

  const priv = inProject('private')
  assert.deepEqual(sharing(await priv.claude.create(priv.ann, base)), [false, false])
  assert.deepEqual(sharing(await priv.claude.create(priv.ann, { ...base, shared: true })), [true, false])

  const open = inProject('shared_can_send')
  assert.deepEqual(sharing(await open.claude.create(open.ann, base)), [true, true])
  assert.deepEqual(sharing(await open.claude.create(open.ann, { ...base, shared: false })), [false, false])
  assert.deepEqual(sharing(await open.claude.create(open.ann, { ...base, shared: true, sharedCanSend: false })), [true, false])
  // A team role's shift keeps its own: shared to watch, nobody types in it.
  assert.deepEqual(sharing(await open.claude.create(open.ann, base, { listed: false, shared: true })), [true, false])
  const s = await open.claude.create(open.ann, base)
  assert.deepEqual(sharing(await open.claude.update(open.ann, s.id, { shared: false })), [false, true]) // still the owner's to change

  const watch = inProject('shared')
  assert.deepEqual(sharing(await watch.claude.create(watch.ann, base)), [true, false])
})

test('sumTurns: session total is the last answer’s cumulative cost, with tokens and turns summed', () => {
  const turn = (over: Partial<TurnRow>): TurnRow => ({
    session_id: 's1', result_uuid: 'r', after_uuid: null, prompt_uuid: null, ok: 1, duration_ms: 0,
    cost_usd: 0, turn_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    num_turns: 1, model: null, created_at: 0, ...over,
  })
  assert.deepEqual(sumTurns([]), { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 })
  const total = sumTurns([
    turn({ cost_usd: 0.1, input_tokens: 10, output_tokens: 2, cache_read_tokens: 100, cache_write_tokens: 5 }),
    turn({ cost_usd: 0.3, input_tokens: 20, output_tokens: 4, cache_read_tokens: 200, cache_write_tokens: 7 }),
  ])
  assert.deepEqual(total, { cost: 0.3, inputTokens: 30, outputTokens: 6, cacheReadTokens: 300, cacheWriteTokens: 12, turns: 2 })
})

test('sharing with chosen people: only they see it, each watching or also sending; the rest lose it', async () => {
  const { claude, notified, ann, bob, cat } = setup() // s1 starts shared with the whole team
  notified.length = 0
  const r = claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: false }, { id: 2, canSend: false }, { id: 1, canSend: true }] })
  assert.deepEqual(r.people, [{ id: 2, name: 'Bob', canSend: false }]) // de-duplicated; the owner is never "shared with"
  assert.deepEqual([r.session.audience, r.session.sharedWith, r.session.shared], ['people', 1, false])
  assert.equal(notified.length, 0) // Bob could already see it; nobody new

  assert.equal((await claude.get(bob, 's1')).canSend, false)
  assert.deepEqual((await claude.get(bob, 's1')).people, [{ id: 2, name: 'Bob', canSend: false }])
  await assert.rejects(() => claude.get(cat, 's1'), /private/)
  assert.deepEqual(claude.list(bob, false).map((s) => s.id), ['s1'])
  assert.deepEqual(claude.list(cat, false), [])
  assert.throws(() => claude.askToJoin(cat, 's1'), /private/)

  // Bob may send too; asking to join works for people it's shared with.
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: true }, { id: 3, canSend: false }] })
  assert.equal((await claude.get(bob, 's1')).canSend, true)
  assert.equal((await claude.get(cat, 's1')).canSend, false)
  assert.deepEqual(notified.map((n) => [n.userId, n.title]), [[3, 'Ann shared a Claude session with you']])
  claude.askToJoin(cat, 's1')
  claude.setWriter(ann, 's1', 3, true)
  assert.equal((await claude.get(cat, 's1')).canSend, true)

  assert.throws(() => claude.setSharing(bob, 's1', { audience: 'private' }), /Only the owner/)
  assert.throws(() => claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 99, canSend: false }] }), /No such member/)

  // Only the owner: nobody else sees it; the people list goes with it.
  notified.length = 0
  claude.setSharing(ann, 's1', { audience: 'private' })
  await assert.rejects(() => claude.get(bob, 's1'), /private/)
  assert.deepEqual((await claude.get(ann, 's1')).people, [])
  assert.equal((await claude.get(ann, 's1')).session.audience, 'private')

  // The whole team: everyone sees it and hears about it; only the owner sends unless everyone may.
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: false })
  assert.deepEqual(notified.map((n) => n.userId).sort(), [2, 3])
  assert.equal((await claude.get(cat, 's1')).session.audience, 'everyone')
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true })
  assert.equal((await claude.get(bob, 's1')).canSend, true)

  // The plain team switch means the team (or only the owner), never a stale list of people.
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: false }] })
  await claude.update(ann, 's1', { shared: false })
  await assert.rejects(() => claude.get(bob, 's1'), /private/)
})

test("a project's sessions shared with chosen people: listed for them, only counted for everyone else", () => {
  const { db, claude, ann, bob, cat } = inProject()
  db.prepare(`insert into claude_sessions (id, owner_id, title, cwd, shared, listed, archived, status, project_id, last_activity_at)
    values ('a1', 1, 'Ann for Bob', '/x', 0, 1, 0, 'idle', 1, 100)`).run()
  claude.setSharing(ann, 'a1', { audience: 'people', people: [{ id: 2, canSend: false }] })
  assert.deepEqual(claude.inProject(bob, 'app', false).sessions.map((s) => [s.id, s.kind]), [['a1', 'shared']])
  assert.deepEqual(claude.inProject(bob, 'app', false).hidden, { count: 0, people: [] })
  assert.deepEqual(claude.inProject(cat, 'app', false).sessions, [])
  assert.deepEqual(claude.inProject(cat, 'app', false).hidden, { count: 1, people: ['Ann Lee'] })
})

test("a pinned session shows in the sidebar only while the member may open it, with its live status", () => {
  const { claude, ann, bob, cat } = setup() // s1: Ann's, shared with the team
  assert.deepEqual([...claude.pinned(bob, ['s1', 'nope'])], [['s1', { title: 'Fix login', url: '/claude/s1', state: 'idle', detail: null }]])
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: false }] })
  assert.equal(claude.pinned(bob, ['s1']).size, 1)
  assert.equal(claude.pinned(cat, ['s1']).size, 0) // not shared with her any more: the pin hides
  assert.equal(claude.pinned(ann, ['s1']).size, 1)
})

test('big attachments: uploaded in pieces into the owner’s account by anyone who may send, then named in the message', async () => {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, started) values ('s1', 1, 'Edit video', '/home/ann', 1, 1)").run()
  const sent: { user: string; req: Record<string, unknown> }[] = []
  const written = new Set<string>()
  const agents = {
    onEvent: () => {},
    request: async (user: string, req: Record<string, unknown>) => {
      sent.push({ user, req })
      if (req.op === 'fs.write') written.add(String(req.path))
      if (req.op === 'fs.exists') return { exists: written.has(String(req.path)) }
      return { ok: true }
    },
  } as unknown as AgentsService
  const claude = claudeService({ db, agents, hub: createHub(), projects: {} as ProjectsService, notify: async () => {} })
  const ann: User = { id: 1, name: 'Ann', username: 'ann', email: '', role: 'member' }
  const bob: User = { id: 2, name: 'Bob', username: 'bob', email: '', role: 'member' }
  const MB = 1024 * 1024
  const upload = 'ab'.repeat(16)

  // Bob can watch but not send: he can't upload either.
  await assert.rejects(() => claude.uploadPiece(bob, 's1', { upload, name: 'a.mp4', offset: 0, total: 10 }, Buffer.from('x')), /Only the owner/)
  await assert.rejects(() => claude.uploadPiece(ann, 's1', { upload, name: 'a.mp4', offset: 0, total: 251 * MB }, Buffer.from('x')), /250 MB/)
  // Two pieces of a 40 MB file land at their offsets in Ann's account (Claude runs as her).
  assert.deepEqual(await claude.uploadPiece(ann, 's1', { upload, name: '../raw cut.mp4', offset: 0, total: 40 * MB }, Buffer.alloc(32 * MB)), { received: 32 * MB })
  await claude.uploadPiece(ann, 's1', { upload, name: '../raw cut.mp4', offset: 32 * MB, total: 40 * MB }, Buffer.alloc(8 * MB))
  const writes = sent.filter((x) => x.req.op === 'fs.write')
  assert.deepEqual(writes.map((x) => [x.user, x.req.path, x.req.offset]), [
    ['ann', `/home/ann/.cache/devdash/uploads/s1/${upload}/raw cut.mp4`, 0], ['ann', `/home/ann/.cache/devdash/uploads/s1/${upload}/raw cut.mp4`, 32 * MB],
  ])

  // Sending names it, with its path, for Claude to open.
  await claude.send(ann, 's1', 'Cut the intro', [], [], [{ upload, name: '../raw cut.mp4', size: 40 * MB }])
  const msg = sent.find((x) => x.req.op === 'claude.send')!.req.content as { type: string; text?: string }[]
  assert.match(msg.find((c) => c.type === 'text')!.text!, new RegExp(`Attached files, saved on this server:\\n- /home/ann/.cache/devdash/uploads/s1/${upload}/raw cut.mp4 \\(40.0 MB\\)`))
  // An upload that never finished, or more than 250 MB in all, is refused.
  await assert.rejects(() => claude.send(ann, 's1', 'x', [], [], [{ upload: 'cd'.repeat(16), name: 'b.mp4', size: 5 }]), /didn't finish uploading/)
  await assert.rejects(() => claude.send(ann, 's1', 'x', [], [], [{ upload, name: 'raw cut.mp4', size: 251 * MB }]), /250 MB/)
})
