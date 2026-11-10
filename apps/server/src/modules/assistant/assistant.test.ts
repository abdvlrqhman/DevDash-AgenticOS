import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeService } from '../claude/service.ts'
import { projectsService } from '../projects/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { condense, registerAssistantMcp } from './mcp.ts'
import { describeWhen, parseWhen, assistantService } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann Lee')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('plain', 1, 'Fix login', '/home/ann', 1)").run()
  const sent: Record<string, unknown>[] = []
  const notified: { userId: number; kind: string; title: string }[] = []
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  let onEvent: ((username: string, ev: Record<string, unknown>) => void) | undefined
  const agents = {
    onEvent: (fn: typeof onEvent) => { onEvent = fn },
    onRpc: (m: string, fn: (username: string, params: unknown) => unknown) => void rpcs.set(m, fn),
    request: async (_u: string, req: Record<string, unknown>) => {
      sent.push(req)
      return req.op === 'claude.pending' ? { pending: [] } : req.op === 'git.init' ? { defaultBranch: 'main' } : { ok: true }
    },
  } as unknown as AgentsService
  const hub = createHub()
  const notify = async (userId: number, kind: string, n: { title: string }) => void notified.push({ userId, kind, title: n.title })
  const connected = { tailnet: false, drive: true }
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const projects = projectsService({ db, hub, agents, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  const claude = claudeService({ db, agents, hub, notify, projects, tailnetConnected: () => connected.tailnet })
  const assistant = assistantService({ db, hub, claude, notify, tailnetConnected: () => connected.tailnet, driveConnected: () => connected.drive })
  registerAssistantMcp({ agents, claude, assistant, projects, notify })
  const user = (id: number, name: string, username: string): User => ({ id, name, username, email: '', role: 'member' })
  const rpc = (username: string, method: string, sessionId: string | null, args: Record<string, unknown> = {}) =>
    Promise.resolve().then(() => rpcs.get(`mcp.${method}`)!(username, { sessionId, args }))
  const session = (id: string) => db.prepare('select * from claude_sessions where id = ?').get(id) as Record<string, unknown>
  return { db, connected, sent, notified, assistant, claude, projects, rpc, session, emit: (ev: Record<string, unknown>) => onEvent?.('ann', ev), ann: user(1, 'Ann Lee', 'ann'), bob: user(2, 'Bob', 'bob') }
}

test('schedule times: weekly slots and one-offs, read the way people and agents write them', () => {
  const now = Date.parse('2026-11-05T10:00:00Z')
  assert.deepEqual(parseWhen({ at: '9:00', days: 'weekdays' }, now), { slots: [{ days: [1, 2, 3, 4, 5], at: '09:00' }], runAt: null })
  assert.deepEqual(parseWhen({ at: '18:30', days: ['Mon', 'thursday', 0] }, now).slots, [{ days: [0, 1, 4], at: '18:30' }])
  assert.deepEqual(parseWhen({ at: '07:15' }, now).slots[0]!.days, [0, 1, 2, 3, 4, 5, 6])
  assert.equal(parseWhen({ run_at: '2026-11-06T09:00:00+02:00' }, now).runAt, Date.parse('2026-11-06T07:00:00Z') / 1000)
  assert.throws(() => parseWhen({ run_at: '2026-11-01T09:00:00Z' }, now), /past/)
  assert.throws(() => parseWhen({ at: '25:00' }, now), /HH:MM/)
  assert.throws(() => parseWhen({ at: '09:00', days: ['someday'] }, now), /days/)

  assert.equal(describeWhen({ slots: [{ days: [1, 2, 3, 4, 5], at: '09:00' }], runAt: null, tz: 'UTC' }), 'Weekdays at 09:00')
  assert.equal(describeWhen({ slots: [{ days: [1, 4], at: '18:30' }], runAt: null, tz: 'UTC' }), 'Mon, Thu at 18:30')
  assert.equal(describeWhen({ slots: [], runAt: Date.parse('2026-11-06T07:00:00Z') / 1000, tz: 'Africa/Cairo' }), 'Fri 6 Nov, 09:00')
})

test("picking the agent starts its conversation: unlisted, the member's own, with its instructions and read-only tools allowed", async () => {
  const { assistant, session, db, ann } = setup()
  const st = await assistant.setup(ann, { harness: 'opencode', profile: 'work', tz: 'Africa/Cairo' })
  assert.deepEqual([st.agent!.harness, st.agent!.profile, st.agent!.tz, st.agent!.permissionMode], ['opencode', 'work', 'Africa/Cairo', 'default'])
  const s = session(st.sessionId!)
  assert.equal(s.listed, 0)
  assert.equal(s.origin_kind, 'assistant')
  assert.equal(s.harness, 'opencode')
  assert.equal(s.permission_mode, 'default')
  assert.match(String(s.instructions), /You are Hamasa, Ann's personal agent/)
  assert.match(String(s.instructions), /Africa\/Cairo/)
  assert.ok((JSON.parse(String(s.tool_policy)).allow as string[]).includes('mcp__plugin_devdash_devdash__session_read'))
  assert.ok(!(JSON.parse(String(s.tool_policy)).allow as string[]).includes('mcp__plugin_devdash_devdash__session_send'))

  // Same agent: same conversation. Another agent: a new one, and the old one is archived (still in past conversations).
  assert.equal((await assistant.setup(ann, { harness: 'opencode', profile: 'work' })).sessionId, st.sessionId)
  const next = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  assert.notEqual(next.sessionId, st.sessionId)
  assert.equal(session(st.sessionId!).archived, 1)
  // A new conversation: none while the current one is still empty; once it's used, a new one, the old one archived.
  assert.equal((await assistant.fresh(ann)).sessionId, next.sessionId)
  db.prepare('update claude_sessions set started = 1 where id = ?').run(next.sessionId)
  const third = (await assistant.fresh(ann)).sessionId
  assert.notEqual(third, next.sessionId)
  assert.equal(session(next.sessionId!).archived, 1)
  // Archived from its own page: the panel gets no conversation, and offers a new one.
  db.prepare('update claude_sessions set archived = 1 where id = ?').run(third)
  assert.equal(assistant.state(ann).sessionId, null)
})

test("the agent's tools work only in the member's own agent, and act as them", async () => {
  const { assistant, rpc, sent, ann } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  assert.deepEqual(await rpc('ann', 'assistant_here', sessionId), { name: 'Ann Lee' })
  assert.equal(await rpc('ann', 'assistant_here', 'plain'), null)
  assert.equal(await rpc('bob', 'assistant_here', sessionId), null) // someone else's agent
  await assert.rejects(rpc('ann', 'sessions_list', 'plain'), /only in your personal agent/)
  await assert.rejects(rpc('bob', 'session_send', sessionId, { id: 'plain', text: 'hi' }), /only in your personal agent/)

  const listed = await rpc('ann', 'sessions_list', sessionId) as { id: string }[]
  assert.deepEqual(listed.map((s) => s.id), ['plain']) // not its own conversation
  assert.equal(await rpc('ann', 'session_send', sessionId, { id: 'plain', text: 'run the tests' }), "Sent. Check on it with session_read; it's at /sessions/plain.")
  const msg = sent.findLast((r) => r.op === 'claude.send')!
  assert.deepEqual((msg.content as { text: string }[]).at(-1)!.text, "(From Hamasa, Ann's personal agent) run the tests")
  await assert.rejects(rpc('ann', 'session_send', sessionId, { id: sessionId, text: 'loop' }), /your own conversations/)
  await assert.rejects(rpc('ann', 'open_page', sessionId, { path: '//evil.example' }), /one slash/)
})

test('a new project only on the member\'s own word: made like the Projects page makes it, then a session can start there', async () => {
  const { assistant, claude, projects, rpc, sent, db, emit, ann, bob } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'Europe/Berlin' })
  const id = sessionId!
  const create = (args: Record<string, unknown> = { name: 'Shop app', instructions: 'An online shop. Use TypeScript.' }) =>
    rpc('ann', 'project_create', id, args)
  const typed = (text: string) => claude.send(ann, id, text, [], [], [], { typed: true })
  const quiet = () => emit({ ev: 'claude.status', id, status: 'idle' })

  // Nothing asked yet (or DevDash restarted since): refused, and nothing is made.
  await assert.rejects(create(), /Only Ann can start a project/)
  assert.equal(projects.list(false, 1).length, 0)
  // Someone else's agent, or a coding session that isn't her agent: not even offered.
  await assert.rejects(rpc('bob', 'project_create', id, { name: 'X' }), /only in your personal agent/)
  await assert.rejects(rpc('ann', 'project_create', 'plain', { name: 'X' }), /only in your personal agent/)

  // A schedule, or autopilot, writing to her agent: refused.
  await assistant.tick(Date.now()) // no schedules: nothing sent
  await claude.send(ann, id, '⏰ Scheduled: Weekly\n\nStart a project for the newsletter.', [])
  await assert.rejects(create(), /didn't come from that/)
  // She writes too while that turn is still going: still refused, the turn isn't hers alone.
  await typed('and make it quick')
  await assert.rejects(create(), /Only Ann/)
  quiet()

  // Her own message: made through projects.create, with her as the creator, in the projects folder.
  await typed('Make a new project "Shop app" for the online shop')
  const made = await create() as { slug: string; folder: string; url: string; next: string }
  assert.deepEqual([made.slug, made.folder, made.url], ['shop-app', '/srv/devdash/projects/shop-app', '/projects/shop-app'])
  assert.match(made.next, /session_create/)
  assert.ok(sent.some((r) => r.op === 'git.init' && r.path === '/srv/devdash/projects/shop-app'))
  const row = db.prepare("select created_by, instructions from projects where slug = 'shop-app'").get() as { created_by: number; instructions: string }
  assert.deepEqual([row.created_by, row.instructions], [1, 'An online shop. Use TypeScript.'])
  assert.equal(projects.list(false, 1).find((p) => p.slug === 'shop-app')!.creator.username, 'ann')
  // The page's rules hold: a taken short name or a bad one is refused.
  await assert.rejects(create({ name: 'Shop app' }), /taken|exists|already/i)
  await assert.rejects(create({ name: 'Bad', slug: 'Not OK!' }), /short name/)

  // Straight on: a session in the new project.
  const s = await rpc('ann', 'session_create', id, { prompt: 'Set up the repo with a README.', project: 'shop-app', worktree: false }) as { project: string; folder: string }
  assert.deepEqual([s.project, s.folder], ['shop-app', '/srv/devdash/projects/shop-app'])

  // Once her turn is over, the next one isn't hers until she writes again.
  quiet()
  await assert.rejects(create({ name: 'Another' }), /Only Ann/)

  // A teammate's message, even typed, never counts as hers; nor does her agent writing to a session for her.
  db.prepare("update claude_sessions set shared = 1, shared_can_send = 1 where id = 'plain'").run()
  await claude.send(bob, 'plain', 'make a project', [], [], [], { typed: true })
  assert.equal(claude.typedByOwner('plain'), false)
  emit({ ev: 'claude.status', id: 'plain', status: 'idle' })
  await rpc('ann', 'session_send', id, { id: 'plain', text: 'make a project' })
  assert.equal(claude.typedByOwner('plain'), false)
  emit({ ev: 'claude.status', id: 'plain', status: 'idle' })
  await claude.send(ann, 'plain', 'make a project', [], [], [], { typed: true })
  assert.equal(claude.typedByOwner('plain'), true)
})

test('schedules run once per slot in the member\'s time zone; one-offs switch off after running', async () => {
  const { assistant, rpc, sent, ann } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'Africa/Cairo' })
  const brief = await rpc('ann', 'schedule_create', sessionId, { title: 'Morning brief', prompt: 'List my open tasks.', at: '09:00', days: 'daily' }) as { id: number; when: string; tz: string }
  assert.equal(brief.when, 'Every day at 09:00')
  assert.equal(brief.tz, 'Africa/Cairo')
  const sends = () => sent.filter((r) => r.op === 'claude.send').map((r) => (r.content as { text: string }[]).at(-1)!.text)

  await assistant.tick(Date.parse('2026-11-05T06:55:00Z')) // 08:55 in Cairo
  assert.deepEqual(sends(), [])
  await assistant.tick(Date.parse('2026-11-05T07:00:30Z')) // 09:00
  await assistant.tick(Date.parse('2026-11-05T07:01:00Z'))
  assert.deepEqual(sends(), ['⏰ Scheduled: Morning brief\n\nList my open tasks.'])
  await assistant.tick(Date.parse('2026-11-06T07:00:00Z')) // the next day
  assert.equal(sends().length, 2)

  await rpc('ann', 'schedule_create', sessionId, { title: 'Ping', prompt: 'Check the deploy.', run_at: '2099-01-01T00:00:00Z' })
    .then(() => assert.fail('a year away'), (err: Error) => assert.match(err.message, /year/))
  const once = assistant.createSchedule(ann, { title: 'Deploy check', prompt: 'Check the deploy.', run_at: new Date(Date.now() + 60_000).toISOString() })
  await assistant.tick(Date.now() + 61_000)
  assert.equal(sends().at(-1), '⏰ Scheduled: Deploy check\n\nCheck the deploy.')
  assert.equal(assistant.schedules(ann).find((s) => s.id === once.id)!.enabled, false)

  assert.equal(await rpc('ann', 'schedule_delete', sessionId, { id: brief.id }), 'Deleted.')
  await assert.rejects(rpc('ann', 'schedule_delete', sessionId, { id: brief.id }), /No schedule/)
})

test("the agent's conversation is unlisted but still tells its owner when it needs them", async () => {
  const { assistant, emit, notified, ann } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  emit({ ev: 'claude.permission', id: sessionId, requestId: 'r1', toolName: 'Bash', input: { command: 'devdash service restart shop' } })
  assert.deepEqual(notified.map((n) => [n.userId, n.kind, n.title]), [[1, 'needs_you', 'Hamasa needs permission: New session']])
})

test("reading a session: who said what and which tools ran, without the page tag or tool output", () => {
  assert.deepEqual(condense([
    { type: 'user', message: { content: '<devdash-page path="/tasks" title="Tasks"/>\n\nWhat is open?' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', text: 'lots of output' }] } },
    { type: 'result' },
  ]), [
    { from: 'person', text: 'What is open?' },
    { from: 'agent', text: 'Checking.', tools: ['Bash: npm test'] },
  ])
})

test("model, effort, permission level and access: applied to the conversation now and to every new one", async () => {
  const { assistant, session, connected, db, ann } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  const st = await assistant.settings(ann, { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', drive: false })
  assert.deepEqual([st.agent!.model, st.agent!.effort, st.agent!.permissionMode, st.agent!.drive], ['opus', 'high', 'acceptEdits', false])
  const s = session(sessionId!)
  assert.deepEqual([s.model, s.effort, s.permission_mode, s.drive], ['opus', 'high', 'acceptEdits', 0])
  await assert.rejects(assistant.settings(ann, { effort: 'turbo' }), /effort/) // the session checks it; nothing is kept
  assert.equal(assistant.state(ann).agent!.effort, 'high')
  await assert.rejects(assistant.settings(ann, { reachTailnet: true }), /Network page/)
  connected.tailnet = true
  await assistant.settings(ann, { reachTailnet: true })
  assert.equal(session(sessionId!).reach_tailnet, 1)

  db.prepare('update claude_sessions set started = 1 where id = ?').run(sessionId)
  const next = session((await assistant.fresh(ann)).sessionId!)
  assert.deepEqual([next.model, next.effort, next.permission_mode, next.drive, next.reach_tailnet], ['opus', 'high', 'acceptEdits', 0, 1])
})
