import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../../core/http.ts'
import { authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import { claudeRoutes } from './routes.ts'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { ProjectsService } from '../projects/service.ts'
import { claudeService, checkTailnetMcp, isTailnetHost, requestNotification, sumTurns } from './service.ts'
import type { TurnRow } from './repo.ts'

function setup({ tailnetConnected, requestError }: { tailnetConnected?: (userId: number) => boolean; requestError?: (req: Record<string, unknown>) => Error | undefined } = {}) {
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
      const error = requestError?.(req)
      if (error) throw error
      return { ok: true }
    },
  } as unknown as AgentsService
  const claude = claudeService({
    db, agents, hub: createHub(), projects: { idOf: (slug: string) => (slug === 'app' ? 1 : 0) } as unknown as ProjectsService,
    notify: async (userId, _kind, n) => void notified.push({ userId, title: n.title }),
    tailnetConnected,
  })
  const user = (id: number, name: string): User => ({ id, name, username: name.toLowerCase(), email: '', role: 'member' })
  /** Fires an agent event as Ann's agent would, so the reconcile/notify path can be exercised. */
  const emit = (ev: Record<string, unknown>) => onEvent?.('ann', ev)
  return { claude, db, notified, sent, emit, ann: user(1, 'Ann'), bob: user(2, 'Bob'), cat: user(3, 'Cat') }
}

test('/model and /effort typed in Chat are run by DevDash, like its model menu; anything else is a message', async () => {
  const { claude, db, ann, bob } = setup()
  const row = () => db.prepare("select model, effort from claude_sessions where id = 's1'").get() as { model: string | null; effort: string | null }
  assert.equal(await claude.command(ann, 's1', 'please use opus'), null, 'an ordinary message')
  assert.equal(await claude.command(ann, 's1', '/compact'), null, "Claude Code's own command: it goes to Claude")
  assert.match((await claude.command(ann, 's1', '/model'))!, /The model is the default\. Type \/model/)
  assert.equal(await claude.command(ann, 's1', '/model claude-opus-5-5'), 'Model switched to claude-opus-5-5.')
  assert.equal(row().model, 'claude-opus-5-5')
  assert.equal(await claude.command(ann, 's1', '  /model default '), 'Model switched to the default.')
  assert.equal(row().model, null)
  assert.equal(await claude.command(ann, 's1', '/effort XHigh'), 'Effort set to xhigh.')
  assert.equal(row().effort, 'xhigh')
  await assert.rejects(() => claude.command(ann, 's1', '/effort turbo'), /Unknown effort/)
  await assert.rejects(() => claude.command(ann, 's1', '/model $(whoami)'), /isn't a model name/)
  await assert.rejects(() => claude.command(bob, 's1', '/model haiku'), /Only the owner can send/, 'watching only')
})

test('watching a shared session: ask to join, the owner lets one person in, only they can send', async () => {
  const { claude, notified, ann, bob, cat } = setup()
  assert.equal((await claude.get(bob, 's1')).canSend, false)
  claude.askToJoin(bob, 's1')
  claude.askToJoin(bob, 's1') // a second tap within a minute doesn't notify again
  assert.deepEqual(notified.map((n) => n.userId), [1])

  assert.throws(() => claude.setWriter(bob, 's1', 2, true), /Only the owner/)
  assert.deepEqual(claude.setWriter(ann, 's1', 2, true).writers, [{ id: 2, name: 'Bob', full: false }])
  assert.equal((await claude.get(bob, 's1')).canSend, true)
  assert.equal((await claude.get(cat, 's1')).canSend, false)
  assert.throws(() => claude.askToJoin(bob, 's1'), /already/)

  claude.setWriter(ann, 's1', 2, false)
  assert.equal((await claude.get(bob, 's1')).canSend, false)
})

test("a teammate's message never runs with the owner's access: it goes to the agent as a guest turn, the owner approves", async () => {
  const { claude, db, sent, notified, emit, ann, bob, cat } = setup()
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: true }, { id: 3, canSend: false, full: true }] })
  assert.deepEqual((await claude.get(ann, 's1')).people, [{ id: 2, name: 'Bob', canSend: true, full: false }, { id: 3, name: 'Cat', canSend: true, full: true }])
  assert.deepEqual(await Promise.all([ann, bob, cat].map(async (u) => (await claude.get(u, 's1')).access)), ['owner', 'ask', 'full'])

  // Bob asks: the agent is told who is talking (it gates his turn), and so is Claude, inside his message.
  sent.length = 0
  await claude.send(bob, 's1', 'delete all of the repos on GitHub', [])
  const fromBob = sent.find((r) => r.op === 'claude.send')!
  assert.deepEqual(fromBob.guest, { id: 2, name: 'Bob' })
  const [note, text] = fromBob.content as { type: string; text: string }[]
  assert.match(note!.text, /from Bob, a teammate, not from Ann/)
  assert.equal(text!.text, 'delete all of the repos on GitHub')
  assert.equal((fromBob.launch as { ownerName: string }).ownerName, 'Ann')

  // The owner, and someone they gave full access, run as the owner: no guest turn, no note.
  for (const u of [ann, cat]) {
    sent.length = 0
    await claude.send(u, 's1', 'ship it', [])
    const r = sent.find((x) => x.op === 'claude.send')!
    assert.equal(r.guest, null)
    assert.deepEqual((r.content as { text: string }[]).map((c) => c.text), ['ship it'])
  }

  // Everyone may ask in a session shared with the whole team: still guests, never full access.
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true })
  assert.equal((await claude.get(cat, 's1')).access, 'ask')
  sent.length = 0
  await claude.send(cat, 's1', 'hi', [])
  assert.deepEqual(sent.find((r) => r.op === 'claude.send')!.guest, { id: 3, name: 'Cat' })

  // What Bob's turn wants of Ann's access: only Ann hears about it, and the agent learns who answered.
  notified.length = 0
  emit({ ev: 'claude.permission', id: 's1', requestId: 'r1', toolName: 'Bash', input: { command: 'gh repo delete' }, ownerOnly: true, askedBy: { id: 2, name: 'Bob' } })
  assert.deepEqual(notified, [{ userId: 1, title: 'Bob asked Claude to use your access' }])
  sent.length = 0
  await claude.answer(bob, 's1', 'r1', { behavior: 'allow', updatedInput: {} })
  await claude.answer(ann, 's1', 'r1', { behavior: 'allow', updatedInput: {} })
  assert.deepEqual(sent.map((r) => r.by), [{ owner: false }, { owner: true }]) // the agent refuses Bob's

  // The CLI is the owner's terminal, unguarded: people who may only ask watch it.
  await assert.rejects(() => claude.switchMode(bob, 's1', 'cli', 80, 24), /full access/)
  db.prepare("update claude_sessions set mode = 'cli' where id = 's1'").run()
  assert.deepEqual([ann, bob].map((u) => claude.cliAccess(u, 's1').readonly), [false, true])
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: true, full: true }] })
  assert.equal(claude.cliAccess(bob, 's1').readonly, false)
})

test('what the owner shares with teammates: none by default, sent to the agent and told to Claude, gone when sharing stops', async () => {
  const { claude, sent, ann, bob } = setup()
  assert.deepEqual((await claude.get(ann, 's1')).session.guestCaps, [])
  sent.length = 0
  const r = claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true, caps: ['tailnet', 'drive', 'drive'] })
  assert.deepEqual(r.session.guestCaps, ['drive', 'tailnet'])
  assert.deepEqual([...sent], [{ op: 'claude.set', id: 's1', key: 'guestCaps', value: ['drive', 'tailnet'] }]) // a running session's gate
  sent.length = 0
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true, caps: ['drive', 'tailnet'] })
  assert.equal(sent.length, 0, 'unchanged: nothing to tell')

  await claude.send(bob, 's1', 'upload the render', [])
  const req = sent.find((x) => x.op === 'claude.send')!
  assert.deepEqual((req.launch as { guestCaps: string[] }).guestCaps, ['drive', 'tailnet'])
  assert.match((req.content as { text: string }[])[0]!.text, /the project and its files \(its keys and \.env included\) are the team's; Ann's personal accounts/)
  assert.match((req.content as { text: string }[])[0]!.text, /except what they shared with teammates here: Google Drive, Tailscale/)

  // Only the owner again, by the dialog or the plain switch: sharing again starts from none.
  claude.setSharing(ann, 's1', { audience: 'private', caps: ['drive'] })
  assert.deepEqual((await claude.get(ann, 's1')).session.guestCaps, [])
  claude.setSharing(ann, 's1', { audience: 'everyone', caps: ['github'] })
  await claude.update(ann, 's1', { shared: false })
  assert.deepEqual((await claude.get(ann, 's1')).session.guestCaps, [])
})

test("each member's default for a project: their sessions there follow it, unless a session's Share dialog sets its own", async () => {
  const { claude, db, sent, ann, bob } = setup()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1)").run()
  db.prepare("update claude_sessions set project_id = 1 where id = 's1'").run()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, started, project_id) values ('b1', 2, 'Bob here', '/x', 1, 1, 1)").run()
  assert.deepEqual(claude.projectCaps(ann, 'app').caps, [])
  assert.equal((await claude.get(ann, 's1')).session.guestCapsFromProject, true)

  sent.length = 0
  assert.deepEqual(claude.setProjectCaps(ann, 'app', ['github', 'drive']).caps, ['drive', 'github'])
  assert.deepEqual((await claude.get(ann, 's1')).session.guestCaps, ['drive', 'github'])
  assert.deepEqual(sent.filter((r) => r.op === 'claude.set'), [{ op: 'claude.set', id: 's1', key: 'guestCaps', value: ['drive', 'github'] }], 'its running session learns')
  assert.deepEqual((await claude.get(bob, 'b1')).session.guestCaps, [], "Ann's default is only hers")

  // This session only: its own choice, kept when the project default changes.
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true, caps: ['tailnet'] })
  claude.setProjectCaps(ann, 'app', ['apps'])
  const s = (await claude.get(ann, 's1')).session
  assert.deepEqual([s.guestCaps, s.guestCapsFromProject], [['tailnet'], false])
  // Back to the project's.
  claude.setSharing(ann, 's1', { audience: 'everyone', everyoneCanSend: true, caps: null })
  assert.deepEqual((await claude.get(ann, 's1')).session.guestCaps, ['apps'])
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
  assert.deepEqual(r.people, [{ id: 2, name: 'Bob', canSend: false, full: false }]) // de-duplicated; the owner is never "shared with"
  assert.deepEqual([r.session.audience, r.session.sharedWith, r.session.shared], ['people', 1, false])
  assert.equal(notified.length, 0) // Bob could already see it; nobody new

  assert.equal((await claude.get(bob, 's1')).canSend, false)
  assert.deepEqual((await claude.get(bob, 's1')).people, [{ id: 2, name: 'Bob', canSend: false, full: false }])
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
  assert.deepEqual([...claude.pinned(bob, ['s1', 'nope'])], [['s1', { title: 'Fix login', url: '/sessions/s1', state: 'idle', detail: null }]])
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

test('an OpenCode session: its agent goes with every start, its own session id is kept, and notifications name it', async () => {
  const { claude, db, sent, notified, emit, ann } = setup()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, harness, started) values ('o1', 1, 'Try OpenCode', '/home/ann', 'opencode', 0)").run()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('c1', 1, 'Claude one', '/home/ann', 0)").run()
  assert.equal((await claude.get(ann, 'o1')).session.harness, 'opencode')
  await claude.send(ann, 'o1', 'hello', [])
  const launch = (sent.find((r) => r.op === 'claude.send')!.launch) as { harness: string; nativeId: string | null }
  assert.deepEqual([launch.harness, launch.nativeId], ['opencode', null])
  // OpenCode makes its own id; Claude Code uses DevDash's, so a stray one for a Claude session is ignored.
  emit({ ev: 'claude.native', id: 'o1', nativeId: 'ses_abc' })
  emit({ ev: 'claude.native', id: 'c1', nativeId: 'ses_nope' })
  const ids = db.prepare("select id, native_id from claude_sessions where id in ('o1', 'c1') order by id").all() as { id: string; native_id: string | null }[]
  assert.deepEqual(ids.map((r) => r.native_id), [null, 'ses_abc'])
  sent.length = 0
  await claude.send(ann, 'o1', 'again', [])
  assert.equal(((sent.find((r) => r.op === 'claude.send')!.launch) as { nativeId: string }).nativeId, 'ses_abc')
  emit({ ev: 'claude.status', id: 'o1', status: 'error', detail: 'boom' })
  assert.match(notified.at(-1)!.title, /^OpenCode stopped with an error/)
  // New sessions start with the agent the member chose as their default.
  assert.equal((await claude.saveDefaults(ann, { harness: 'opencode', profile: 'default', model: null, effort: null, permission_mode: 'acceptEdits', open_in: 'chat' })).harness, 'opencode')
})

test('the advisor is off unless the owner picks one; a pick applies live and on the next start, and only in Claude Code', async () => {
  const { claude, db, sent, ann } = setup()
  assert.equal((await claude.get(ann, 's1')).session.advisorModel, null)
  await claude.update(ann, 's1', { advisorModel: 'opus' })
  assert.deepEqual(sent.at(-1), { op: 'claude.set', id: 's1', key: 'advisor', value: 'opus' })
  assert.equal((await claude.get(ann, 's1')).session.advisorModel, 'opus')
  await claude.send(ann, 's1', 'hi', [])
  assert.equal((sent.findLast((r) => r.op === 'claude.send')!.launch as { advisor: string }).advisor, 'opus', 'the next start gets it too')
  await claude.update(ann, 's1', { advisorModel: null })
  assert.deepEqual(sent.at(-1), { op: 'claude.set', id: 's1', key: 'advisor', value: null })
  db.prepare("update claude_sessions set harness = 'opencode' where id = 's1'").run()
  await assert.rejects(claude.update(ann, 's1', { advisorModel: 'opus' }), /Only Claude Code/)
})

test('T3 Code preserves its native thread id, models, effort and defaults, and names notifications', async () => {
  const { claude, db, sent, notified, emit, ann } = setup()
  db.prepare("update claude_sessions set harness = 't3code', started = 0, drive = 0 where id = 's1'").run()
  assert.equal((await claude.get(ann, 's1')).session.harness, 't3code')
  await claude.send(ann, 's1', 'hello', [])
  const launch = sent.find((r) => r.op === 'claude.send')!.launch as { harness: string; nativeId: string | null }
  assert.deepEqual([launch.harness, launch.nativeId], ['t3code', null])
  emit({ ev: 'claude.native', id: 's1', nativeId: 't3-thread' })
  sent.length = 0
  await claude.send(ann, 's1', 'again', [])
  assert.equal((sent.find((r) => r.op === 'claude.send')!.launch as { nativeId: string }).nativeId, 't3-thread')
  assert.equal(await claude.command(ann, 's1', '/model codex/gpt-6.1-sol'), 'Model switched to codex/gpt-6.1-sol.')
  emit({ ev: 'claude.efforts', id: 's1', efforts: ['medium', 'ultra'] })
  assert.equal(await claude.command(ann, 's1', '/effort Ultra'), 'Effort set to ultra.')
  const selected = db.prepare("select model, effort from claude_sessions where id = 's1'").get() as { model: string; effort: string }
  assert.deepEqual([selected.model, selected.effort], ['codex/gpt-6.1-sol', 'ultra'])
  emit({ ev: 'claude.status', id: 's1', status: 'error', detail: 'connection lost' })
  assert.match(notified.at(-1)!.title, /^T3 Code stopped with an error/)
  assert.equal((await claude.saveDefaults(ann, { harness: 't3code', profile: 'default', model: 'codex/gpt-6.1-sol', effort: null, permission_mode: 'bypassPermissions', open_in: 'chat' })).harness, 't3code')
})

test('T3 Code creates Chat sessions with Drive disabled and rejects unsupported launch options before writing', async () => {
  const { claude, db, ann } = inProject()
  const input = { prompt: '', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'bypassPermissions', mode: 'chat' as const, project: 'app', harness: 't3code' as const }
  const count = () => (db.prepare('select count(*) as n from claude_sessions').get() as { n: number }).n
  await assert.rejects(claude.create(ann, { ...input, mode: 'cli' }), /open in Chat/)
  await assert.rejects(claude.create(ann, { ...input, profile: 'work' }), /default connection/)
  for (const permissionMode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']) {
    await assert.rejects(claude.create(ann, { ...input, permissionMode }), /explicit Full access/)
  }
  await assert.rejects(claude.create(ann, input, { toolPolicy: { tools: ['Read'] } }), /cannot enforce DevDash tool policies/)
  assert.equal(count(), 0)
  const created = await claude.create(ann, input)
  assert.equal(created.harness, 't3code')
  assert.equal((db.prepare('select drive from claude_sessions where id = ?').get(created.id) as { drive: number }).drive, 0)
  await assert.rejects(claude.switchMode(ann, created.id, 'cli', 100, 30), /open in Chat/)
  await assert.rejects(claude.saveDefaults(ann, { harness: 't3code', profile: 'default', model: null, effort: null, permission_mode: 'bypassPermissions', open_in: 'cli' }), /open in Chat/)
  await assert.rejects(claude.saveDefaults(ann, { harness: 't3code', profile: 'work', model: null, effort: null, permission_mode: 'bypassPermissions', open_in: 'chat' }), /default connection/)
})

test('T3 Code HTTP defaults and new sessions accept every advertised effort and reject unsupported pairs before saving', async () => {
  const { db, ann } = inProject()
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ProviderSpecific']
  const agents = {
    onEvent: () => {},
    request: async (_username: string, r: { op: string; model?: string }) => {
      assert.equal(r.op, 'claude.commands')
      return { commands: [], models: [
        // This model is outside the short catalog. Its levels are available when requested by ID.
        ...(r.model === 'codex/sol' ? [{ value: r.model, displayName: 'Sol', supportedEffortLevels: levels }] : []),
        { value: 'another/fast', displayName: 'Fast', supportedEffortLevels: [] },
      ] }
    },
  } as unknown as AgentsService
  const projects = { bySlug: () => ({ id: 1, slug: 'app' }), path: () => '/srv/app' } as unknown as ProjectsService
  const claude = claudeService({ db, agents, projects, hub: createHub(), notify: async () => {} })
  const mw = authMiddleware({ sessionUser: () => ({ user: ann }) } as unknown as AuthService)
  const app = claudeRoutes(claude, mw)
  app.onError((e, c) => { if (e instanceof AppError) return c.json({ error: e.message }, e.status); throw e })
  const request = (path: string, method: string, body: object) => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  const listedModels = async (query: string) => {
    const res = await app.request('/commands?' + query)
    assert.equal(res.status, 200)
    return ((await res.json()) as { models: { value: string }[] }).models.map((m) => m.value)
  }
  assert.deepEqual(await listedModels('harness=t3code'), ['another/fast'])
  assert.deepEqual(await listedModels('harness=t3code&model=codex%2Fsol'), ['codex/sol', 'another/fast'])
  assert.deepEqual(await listedModels('harness=opencode&model=codex%2Fsol'), ['another/fast'])
  assert.equal((await app.request('/commands?harness=t3code&model=' + 'x'.repeat(161))).status, 400)

  const sessionFrom = async (res: Response) => ((await res.json()) as { session: { id: string; effort: string | null } }).session
  const defaults = { harness: 't3code', profile: 'default', model: 'codex/sol', permission_mode: 'bypassPermissions', open_in: 'chat' }
  const newSession = { harness: 't3code', model: 'codex/sol', project: 'app' }
  for (const effort of levels) {
    const saved = await request('/defaults', 'PUT', { ...defaults, effort })
    assert.equal(saved.status, 200)
    assert.equal(((await saved.json()) as { defaults: { effort: string } }).defaults.effort, effort)
    const created = await request('/sessions', 'POST', { ...newSession, effort })
    assert.equal(created.status, 200)
    assert.equal((await sessionFrom(created)).effort, effort)
  }
  const count = () => (db.prepare('select count(*) as n from claude_sessions').get() as { n: number }).n
  const before = count()
  for (const model of ['another/fast', null]) {
    assert.equal((await request('/defaults', 'PUT', { ...defaults, model, effort: 'ultra' })).status, 400)
    assert.equal((await request('/sessions', 'POST', { ...newSession, model, effort: 'ultra' })).status, 400)
  }
  assert.equal(count(), before)
  assert.equal(claude.defaults(ann).effort, 'ProviderSpecific')
  assert.equal((await request('/defaults', 'PUT', { ...defaults, harness: 'claude', effort: 'ultra' })).status, 400)

  const idle = await sessionFrom(await request('/sessions', 'POST', { ...newSession, effort: 'ultra' }))
  const path = `/sessions/${idle.id}`
  assert.match((await claude.command(ann, idle.id, '/effort'))!, /low, medium, high, xhigh, max, ultra, ProviderSpecific/)
  assert.equal((await request(path, 'PATCH', { model: 'another/fast', effort: 'ultra' })).status, 400)
  const unchanged = db.prepare('select model, effort from claude_sessions where id = ?').get(idle.id)!
  assert.deepEqual([unchanged.model, unchanged.effort], ['codex/sol', 'ultra'])
  const changed = await request(path, 'PATCH', { model: 'another/fast' })
  assert.equal((await sessionFrom(changed)).effort, null)
})

test('T3 Code rejects guest messages and uploads before using the owner account; full access can send', async () => {
  const { claude, db, sent, ann, bob, cat } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0 where id = 's1'").run()
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: false }, { id: 3, canSend: true, full: true }] })
  // Even a guest writer left over from an older sharing setting cannot send through T3 Code.
  db.prepare("insert into claude_session_writers (session_id, user_id) values ('s1', 2)").run()
  assert.equal((await claude.get(bob, 's1')).canSend, false)
  assert.equal((await claude.get(cat, 's1')).canSend, true)
  sent.length = 0
  await assert.rejects(claude.send(bob, 's1', 'hi', []), /requires full access/)
  await assert.rejects(claude.uploadPiece(bob, 's1', { upload: 'ab'.repeat(16), name: 'hi.txt', offset: 0, total: 2 }, Buffer.from('hi')), /requires full access/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare('select count(*) as n from claude_message_senders').get() as { n: number }).n, 0)
  await claude.send(cat, 's1', 'hi', [])
  assert.equal(sent.find((r) => r.op === 'claude.send')!.guest, null)
})

test('T3 Code only supports explicit Full access and cannot silently persist approval modes', async () => {
  const { claude, db, sent, ann } = setup({ tailnetConnected: () => true })
  db.prepare("update claude_sessions set harness = 't3code', permission_mode = 'bypassPermissions', drive = 0 where id = 's1'").run()
  const row = () => db.prepare("select title, permission_mode, reach_tailnet, fast_mode, remote_control, drive, tailnet_mcps from claude_sessions where id = 's1'").get()
  const before = row()
  for (const permissionMode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']) {
    await assert.rejects(claude.update(ann, 's1', { title: 'Changed', permissionMode }), /explicit Full access/)
    await assert.rejects(claude.saveDefaults(ann, { harness: 't3code', profile: 'default', model: null, effort: null, permission_mode: permissionMode, open_in: 'chat' }), /explicit Full access/)
  }
  for (const patch of [
    { reachTailnet: true }, { tailnetMcps: [{ name: 'ida', url: 'http://100.64.0.9/mcp' }] }, { drive: true },
    { fastMode: true }, { remoteControl: true },
  ]) await assert.rejects(claude.update(ann, 's1', { title: 'Changed', ...patch }), /T3 Code/)
  assert.deepEqual(row(), before)
  assert.equal(sent.length, 0)
  await claude.update(ann, 's1', { permissionMode: 'bypassPermissions' })
  assert.equal(sent.length, 0, 'an unchanged mode does not reach the immutable T3 runtime')
  db.prepare("update claude_sessions set permission_mode = 'default' where id = 's1'").run()
  await assert.rejects(claude.send(ann, 's1', 'continue', []), /explicit Full access/, 'legacy approval-mode sessions cannot run as full access')
  assert.equal(sent.length, 0)
})


test('T3 Code refuses stored unsupported connections, tool policies and unspecified supervisor models', async () => {
  const { claude, db, sent, ann } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0, tool_policy = ? where id = 's1'").run(JSON.stringify({ tools: ['Read'] }))
  await assert.rejects(claude.send(ann, 's1', 'hi', []), /cannot enforce DevDash tool policies/)
  db.prepare("update claude_sessions set tool_policy = null, reach_tailnet = 1 where id = 's1'").run()
  await assert.rejects(claude.send(ann, 's1', 'hi', []), /manages its own connections/)
  assert.throws(() => claude.configure('s1', { title: 'Changed', toolPolicy: { tools: ['Read'] } }), /cannot enforce DevDash tool policies/)
  await assert.rejects(claude.complete('ann', 'answer safely', { harness: 't3code' }), /Choose a T3 Code supervisor model/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("select title from claude_sessions where id = 's1'").get() as { title: string }).title, 'Fix login')
})

test('T3 Code sharing permits watching or named full access and rejects guest settings without changing access', async () => {
  const { claude, db, ann, bob } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0 where id = 's1'").run()
  claude.setSharing(ann, 's1', { audience: 'everyone' })
  for (const input of [
    { audience: 'everyone' as const, everyoneCanSend: true },
    { audience: 'people' as const, people: [{ id: 2, canSend: true }] },
    { audience: 'everyone' as const, caps: ['github' as const] },
  ]) assert.throws(() => claude.setSharing(ann, 's1', input), /T3 Code/)
  await assert.rejects(claude.update(ann, 's1', { sharedCanSend: true }), /T3 Code/)
  assert.throws(() => claude.setWriter(ann, 's1', 2, true), /chosen people.*full access/)
  assert.throws(() => claude.askToJoin(bob, 's1'), /by name.*full access/)
  assert.equal((await claude.get(bob, 's1')).canSend, false)
  assert.equal((await claude.get(ann, 's1')).session.audience, 'everyone')
  claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: 2, canSend: true, full: true }] })
  assert.equal((await claude.get(bob, 's1')).canSend, true)
  claude.setSharing(ann, 's1', { audience: 'everyone' })
  assert.equal((await claude.get(bob, 's1')).canSend, false, 'whole-team sharing removes named full access')
})

test('T3 Hamasa conversations stay owner-only through both sharing APIs', async () => {
  const { claude, db, ann, bob } = setup()
  db.prepare("update claude_sessions set harness = 't3code', origin_kind = 'assistant', shared = 0 where id = 's1'").run()
  assert.throws(() => claude.setSharing(ann, 's1', { audience: 'people', people: [{ id: bob.id, canSend: true, full: true }] }), /private/)
  await assert.rejects(claude.update(ann, 's1', { shared: true }), /private/)
  await assert.rejects(claude.get(bob, 's1'), /private/)
  await assert.rejects(claude.send(bob, 's1', 'List my tasks', []), /private/)
})

test('T3 Code project sharing defaults become watch-only and explicit guest sharing is refused', async () => {
  const { claude, ann } = inProject('shared_can_send')
  const input = { prompt: '', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'bypassPermissions', mode: 'chat' as const, project: 'app', harness: 't3code' as const }
  const session = await claude.create(ann, input)
  assert.deepEqual([session.shared, session.sharedCanSend], [true, false])
  await assert.rejects(claude.create(ann, { ...input, shared: true, sharedCanSend: true }), /T3 Code can be shared for watching/)
})

test('T3 Code rejects every attachment before storing a sender or writing uploaded files', async () => {
  const { claude, db, sent, ann } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0 where id = 's1'").run()
  const image = { mediaType: 'image/png' as const, data: 'aGk=' }
  await assert.rejects(claude.send(ann, 's1', 'look', [image]), /Attachments are unavailable/)
  await assert.rejects(claude.send(ann, 's1', 'read', [], [{ name: 'hello.txt', mediaType: 'text/plain', data: 'aGk=' }]), /Attachments are unavailable/)
  await assert.rejects(claude.send(ann, 's1', 'read', [], [], [{ upload: 'ab'.repeat(16), name: 'hello.txt', size: 2 }]), /Attachments are unavailable/)
  await assert.rejects(claude.uploadPiece(ann, 's1', { upload: 'ab'.repeat(16), name: 'hello.txt', offset: 0, total: 2 }, Buffer.from('hi')), /Attachments are unavailable/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare('select count(*) as n from claude_message_senders').get() as { n: number }).n, 0)
  assert.equal((db.prepare('select count(*) as n from claude_turns').get() as { n: number }).n, 0)
  const fresh = inProject()
  await assert.rejects(fresh.claude.create(fresh.ann, { prompt: 'look', images: [image], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'bypassPermissions', mode: 'chat', project: 'app', harness: 't3code' }), /Attachments are unavailable/)
  assert.equal((fresh.db.prepare('select count(*) as n from claude_sessions').get() as { n: number }).n, 0)
})

test('T3 Code validates one live model/effort pair before saving any requested changes', async () => {
  let failing = true
  let remote = { model: 'codex/original' as string | null, effort: 'high' as string | null }
  const { claude, db, sent, ann } = setup({ requestError: (req) => {
    if (req.op !== 'claude.selection') return undefined
    if (failing) return new Error('T3 Code rejected selection')
    remote = { model: req.model as string | null, effort: req.effort as string | null }
    return undefined
  } })
  db.prepare("update claude_sessions set harness = 't3code', drive = 0, model = 'codex/original', effort = 'high' where id = 's1'").run()
  const row = () => db.prepare("select model, effort, title from claude_sessions where id = 's1'").get()
  const before = row()
  for (const patch of [
    { model: 'codex/missing' }, { effort: 'missing' }, { model: 'codex/valid', effort: 'invalid-for-model' },
  ]) {
    sent.length = 0
    await assert.rejects(claude.update(ann, 's1', { title: 'Changed', ...patch }), /rejected selection/)
    assert.deepEqual(row(), before)
    assert.deepEqual(remote, { model: 'codex/original', effort: 'high' })
    assert.equal(sent.filter((req) => req.op === 'claude.selection').length, 1)
    assert.ok(!sent.some((req) => req.op === 'claude.set' || req.op === 'claude.rename'), 'failed selections never partially apply another live setting')
  }
  failing = false
  sent.length = 0
  await claude.update(ann, 's1', { model: 'codex/gpt-6.1-sol', effort: 'ultra' })
  const changed = row() as { model: string; effort: string }
  assert.deepEqual([changed.model, changed.effort], ['codex/gpt-6.1-sol', 'ultra'])
  assert.deepEqual(remote, { model: 'codex/gpt-6.1-sol', effort: 'ultra' })
  assert.equal((sent[0]?.launch as { id: string }).id, 's1', 'the member agent can reattach a stopped chat')
  const selections = () => sent.map(({ launch: _launch, ...selection }) => selection)
  assert.deepEqual(selections(), [{ op: 'claude.selection', id: 's1', model: 'codex/gpt-6.1-sol', effort: 'ultra' }])
  sent.length = 0
  await claude.update(ann, 's1', { model: 'claude/sonnet' })
  const nextModel = row() as { model: string; effort: string | null }
  assert.deepEqual([nextModel.model, nextModel.effort], ['claude/sonnet', null], 'a different model cannot inherit effort levels from the old model on restart')
  assert.deepEqual(selections(), [{ op: 'claude.selection', id: 's1', model: 'claude/sonnet', effort: null }])
  sent.length = 0
  await claude.update(ann, 's1', { effort: 'low' })
  assert.deepEqual(selections(), [{ op: 'claude.selection', id: 's1', model: 'claude/sonnet', effort: 'low' }], 'effort-only changes include the saved model')
})

test('overlapping T3 model and effort changes resolve against the latest saved selection', async () => {
  const { claude, db, sent, emit, ann } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0, model = 'codex/old', effort = 'high' where id = 's1'").run()
  await Promise.all([
    claude.update(ann, 's1', { model: 'other/new' }),
    claude.update(ann, 's1', { effort: 'ultra' }),
    claude.update(ann, 's1', { model: 'other/new' }),
  ])
  assert.deepEqual(sent.map((r) => [r.model, r.effort]), [['other/new', null], ['other/new', 'ultra'], ['other/new', 'ultra']])
  const row = db.prepare("select model, effort from claude_sessions where id = 's1'").get()!
  assert.deepEqual([row.model, row.effort], ['other/new', 'ultra'])

  const levels = Array.from({ length: 25 }, (_, i) => `level-${i}`)
  emit({ ev: 'claude.efforts', id: 's1', efforts: levels })
  assert.deepEqual(claude.list(ann, false)[0]!.efforts, levels)
})

test('T3 Code existing conversations reject Default without silently changing the saved model', async () => {
  const { claude, db, sent, ann } = setup()
  db.prepare("update claude_sessions set harness = 't3code', drive = 0, model = 'codex/original', effort = 'high' where id = 's1'").run()
  await assert.rejects(claude.update(ann, 's1', { model: null }), /Choose a specific T3 Code model/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("select model from claude_sessions where id = 's1'").get() as { model: string }).model, 'codex/original')
  db.prepare("update claude_sessions set started = 0 where id = 's1'").run()
  await claude.update(ann, 's1', { model: null })
  assert.equal((db.prepare("select model from claude_sessions where id = 's1'").get() as { model: string | null }).model, null, 'unstarted sessions may choose the T3 default')
  assert.equal(sent.length, 0)
})

test('an explicit profile refresh reaches the member agent and preserves ordinary profile reads', async () => {
  const { claude, sent, ann } = setup()
  await claude.profiles(ann)
  assert.deepEqual(sent.pop(), { op: 'claude.profiles' })
  await claude.profiles(ann, true)
  assert.deepEqual(sent.pop(), { op: 'claude.profiles', refresh: true })
})


test('a restart never queues a duplicate Continue turn for externally running agents', async () => {
  const { db, sent, emit } = setup()
  db.prepare("update claude_sessions set harness = 't3code', status = 'working', drive = 0 where id = 's1'").run()
  emit({ ev: 'snapshot', sessions: [] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent.filter((r) => r.op === 'claude.send').length, 0)
  assert.equal((db.prepare('select count(*) as n from claude_message_senders').get() as { n: number }).n, 0)
  const row = db.prepare("select status, status_detail from claude_sessions where id = 's1'").get() as { status: string; status_detail: string }
  assert.equal(row.status, 'error')
  assert.match(row.status_detail, /may still be running.*Check its conversation/)
  emit({ ev: 'snapshot', sessions: [] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent.filter((r) => r.op === 'claude.send').length, 0, 'repeated snapshots cannot queue a synthetic turn')
})

test('Claude Code and OpenCode retain automatic restart recovery', async () => {
  for (const harness of ['claude', 'opencode']) {
    const { db, sent, emit } = setup()
    db.prepare("update claude_sessions set harness = ?, status = 'working' where id = 's1'").run(harness)
    emit({ ev: 'snapshot', sessions: [] })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const sends = sent.filter((r) => r.op === 'claude.send')
    assert.equal(sends.length, 1, harness)
    assert.match(JSON.stringify(sends[0]!.content), /Continue where you left off/)
    assert.equal((db.prepare("select status from claude_sessions where id = 's1'").get() as { status: string }).status, 'working')
  }
})

test('voice mode in a session: wherever they may send, never where they only watch, never in someone else\'s Hamasa', () => {
  const { claude, db, ann, bob, cat } = setup()
  // s1: Ann's, shared to watch. s2: Ann's, shared with send. s3: Ann's personal agent (Hamasa).
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, shared_can_send, started) values ('s2', 1, 'Shop', '/home/ann', 1, 1, 1)").run()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, started, origin_kind) values ('s3', 1, 'Hamasa', '/home/ann', 1, 1, 'assistant')").run()
  assert.deepEqual(claude.voiceAccess(ann, 's1'), { assistant: false })
  assert.throws(() => claude.voiceAccess(bob, 's1'), /only watch this session/)
  assert.deepEqual(claude.voiceAccess(bob, 's2'), { assistant: false }) // a teammate with write access, with their own keys
  assert.deepEqual(claude.voiceAccess(ann, 's3'), { assistant: true })
  assert.throws(() => claude.voiceAccess(bob, 's3'), /only watch|not_found|does not exist/)
  void cat
})
