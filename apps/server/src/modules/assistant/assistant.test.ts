import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  return { db, hub, notify, connected, sent, notified, assistant, claude, projects, rpc, session, emit: (ev: Record<string, unknown>) => onEvent?.('ann', ev), ann: user(1, 'Ann Lee', 'ann'), bob: user(2, 'Bob', 'bob') }
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

  // Same agent and account: same conversation. The other agent: a chat of its own beside it, the first one untouched.
  assert.equal((await assistant.setup(ann, { harness: 'opencode', profile: 'work' })).sessionId, st.sessionId)
  const both = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  assert.notEqual(both.sessionId, st.sessionId)
  assert.equal(session(st.sessionId!).archived, 0)
  assert.deepEqual(both.chats.map((c) => [c.harness, c.profile, c.sessionId]), [['claude', 'default', both.sessionId], ['opencode', 'work', st.sessionId]])
  // Another account for an agent: its chat starts afresh, and the old conversation is archived (not deleted).
  const next = await assistant.setup(ann, { harness: 'claude', profile: 'work' })
  assert.notEqual(next.sessionId, both.sessionId)
  assert.equal(session(both.sessionId!).archived, 1)
  assert.equal(session(st.sessionId!).archived, 0, "the other agent's chat stays")
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

test('a chat per agent: switching keeps each conversation and its own settings, and the one they talk in gets the rest', async () => {
  const { assistant, session, emit, sent, db, ann } = setup()
  const claudeChat = (await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })).sessionId!
  await assistant.settings(ann, { model: 'opus', effort: 'high' })

  // The other agent's first chat: on its default account, with none of Claude Code's settings.
  const st = await assistant.switchTo(ann, 'opencode')
  const openChat = st.sessionId!
  assert.notEqual(openChat, claudeChat)
  assert.deepEqual([st.agent!.harness, st.agent!.profile, st.agent!.model, st.agent!.effort], ['opencode', 'default', null, null])
  assert.equal(session(openChat).harness, 'opencode')
  await assistant.settings(ann, { model: 'anthropic/claude-opus-5-5' })
  assert.equal(session(claudeChat).model, 'opus', 'the other chat keeps its model')
  // Back: the same conversation, with its settings as they were. What it reaches is the same in both.
  const back = await assistant.switchTo(ann, 'claude')
  assert.deepEqual([back.sessionId, back.agent!.model, back.agent!.effort], [claudeChat, 'opus', 'high'])
  assert.equal(session(openChat).archived, 0)
  await assistant.settings(ann, { drive: false })
  assert.deepEqual([session(claudeChat).drive, session(openChat).drive, session(openChat).model], [0, 0, 'anthropic/claude-opus-5-5'])
  await assert.rejects(assistant.switchTo(ann, 'nope'), /Unknown agent/)

  // Each chat has its own dot; the launchers' shows either. Seeing one clears only its own.
  emit({ ev: 'claude.msg', id: openChat, msg: { type: 'result', subtype: 'success', result: 'Done.' } })
  assert.deepEqual(assistant.state(ann).chats.map((c) => [c.harness, c.unread]), [['claude', false], ['opencode', true]])
  assert.equal(assistant.state(ann).unread, true)
  assert.equal(assistant.seen(ann).unread, true, "seeing the chat they're in leaves the other one's dot")
  assert.equal(assistant.seen(ann, openChat).unread, false)

  // Schedules' runs can read both chats; hand-offs, follow-ups and voice go to the one they talk in.
  assistant.createSchedule(ann, { title: 'Brief', prompt: 'Brief me.', at: '09:00', days: 'daily' })
  await assistant.tick(Date.parse('2026-11-05T09:00:30Z'))
  const run = sent.findLast((r) => r.op === 'claude.send')!
  assert.match((run.content as { text: string }[]).at(-1)!.text, new RegExp(`Their chats with you are sessions ${claudeChat} and ${openChat}:`))
  assert.equal(await assistant.current(ann), claudeChat)
  await assistant.switchTo(ann, 'opencode')
  assert.equal(await assistant.current(ann), openChat)

  // Clearing clears only the chat they're in.
  db.prepare('update claude_sessions set started = 1 where id in (?, ?)').run(claudeChat, openChat)
  const cleared = await assistant.fresh(ann)
  assert.notEqual(cleared.sessionId, openChat)
  assert.deepEqual([session(openChat).archived, session(claudeChat).archived], [1, 0])
  assert.equal(cleared.chats.find((c) => c.harness === 'claude')!.sessionId, claudeChat)
})

test('after the update, the chat each member had becomes the one of its agent, with its settings and dot', () => {
  const { db, assistant, ann } = setup()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, origin_kind, listed) values ('old', 1, 'Chat', '/home/ann', 'assistant', 0)").run()
  db.exec('drop table assistant_chats') // as it was before migration 066
  db.prepare(`insert into assistants (user_id, harness, profile, model, effort, permission_mode, fast, tz, session_id, unread)
    values (1, 'opencode', 'work', 'x/y', 'high', 'acceptEdits', 0, 'Africa/Cairo', 'old', 1)`).run()
  db.exec(readFileSync(new URL('../../../migrations/066_assistant_chats.sql', import.meta.url), 'utf8'))
  const st = assistant.state(ann)
  assert.deepEqual([st.agent!.harness, st.agent!.profile, st.agent!.model, st.agent!.effort, st.agent!.permissionMode, st.agent!.tz], ['opencode', 'work', 'x/y', 'high', 'acceptEdits', 'Africa/Cairo'])
  assert.deepEqual(st.chats, [{ harness: 'opencode', profile: 'work', sessionId: 'old', unread: true }])
  assert.equal(st.sessionId, 'old')
})

test('T3 Code cannot run Hamasa and rejecting it preserves the current agent and conversation', async () => {
  const { assistant, ann } = setup()
  const current = await assistant.setup(ann, { harness: 'claude', profile: 'default' })
  await assert.rejects(assistant.setup(ann, { harness: 't3code', profile: 'default' }), /Hamasa requires DevDash tool policies/)
  assert.deepEqual(assistant.state(ann), current)
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

test("session settings: model, effort and advisor freely; the permission level only on the member's own word", async () => {
  const { assistant, claude, rpc, sent, db, ann } = setup()
  const { sessionId } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'Europe/Berlin' })
  const id = sessionId!
  db.prepare("update claude_sessions set mode = 'chat' where id = 'plain'").run()
  const set = (args: Record<string, unknown>) => rpc('ann', 'session_settings', id, { id: 'plain', ...args }) as Promise<Record<string, string>>

  const r = await set({ model: 'opus', effort: 'high', advisor: 'fable' })
  assert.deepEqual([r.model, r.effort, r.advisor], ['opus', 'high', 'fable'])
  assert.deepEqual(sent.filter((x) => x.op === 'claude.set').map((x) => [x.key, x.value]), [['model', 'opus'], ['effort', 'high'], ['advisor', 'fable']], 'applied to the live session')
  assert.equal((await set({ advisor: 'off' })).advisor, 'off')
  await assert.rejects(set({ advisor: 'gpt' }), /advisor is "off" or one of/)
  await assert.rejects(set({}), /Say what to change/)

  // The permission level: refused until she asks in her own message, then set.
  await assert.rejects(set({ permission_mode: 'bypassPermissions' }), /Only Ann can change a session's permission level/)
  await claude.send(ann, id, 'Put the login session in bypass mode', [], [], [], { typed: true })
  assert.equal((await set({ permission_mode: 'bypassPermissions' })).permission_mode, 'bypassPermissions')
  await assert.rejects(set({ permission_mode: 'root' }), /permission_mode is one of/)
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
  // Without the pointer to their chat that every run gets (tested below).
  const sends = () => sent.filter((r) => r.op === 'claude.send').map((r) => (r.content as { text: string }[]).at(-1)!.text.replace(/\n\n\(Their chat with you is session [^)]*\)$/, ''))

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
  assert.equal(sessionId, assistant.state(ann).sessionId)
  assert.equal(await rpc('ann', 'schedule_delete', sessionId, { id: brief.id }), 'Deleted.')
  await assert.rejects(rpc('ann', 'schedule_delete', sessionId, { id: brief.id }), /No schedule/)
})

test("a schedule runs in a conversation of its own, never in the one the member is chatting in", async () => {
  const { assistant, rpc, sent, session, db, ann } = setup()
  const { sessionId: chat } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  const runs = () => sent.filter((r) => r.op === 'claude.send').map((r) => ({ to: (r.launch as { id: string }).id, text: (r.content as { text: string }[]).at(-1)!.text }))
  const brief = assistant.createSchedule(ann, { title: 'Morning brief', prompt: 'List my open tasks.', at: '09:00', days: 'daily' })
  const check = assistant.createSchedule(ann, { title: 'Deploy check', prompt: 'Check the deploy.', at: '09:00', days: 'daily' })
  assert.equal(brief.conversation, null, 'none before its first run')

  await assistant.tick(Date.parse('2026-11-05T09:00:30Z'))
  const [a, b] = runs()
  assert.ok(a && b && a.to !== chat && b.to !== chat, 'not in the chat')
  assert.notEqual(a.to, b.to, 'each schedule its own')
  assert.equal(assistant.state(ann).sessionId, chat, "the panel stays on the member's conversation")
  const own = session(a.to)
  assert.deepEqual([own.title, own.origin_kind, own.listed], ['Scheduled: Morning brief', 'assistant', 0])
  assert.equal(assistant.schedules(ann).find((s) => s.id === brief.id)!.conversation, a.to)
  // It works like the agent everywhere: its tools act as the member.
  assert.deepEqual(await rpc('ann', 'assistant_here', a.to), { name: 'Ann Lee' })

  // The next run follows the earlier one, in the same conversation.
  await assistant.tick(Date.parse('2026-11-06T09:00:30Z'))
  assert.deepEqual(runs().slice(2).map((r) => r.to).sort(), [a.to, b.to].sort())

  // Settings reach the schedules' conversations too; a renamed schedule renames its conversation.
  await assistant.settings(ann, { model: 'opus' })
  assert.equal(session(a.to).model, 'opus')
  assistant.updateSchedule(ann, brief.id, { title: 'Daily brief' })
  await new Promise((r) => setImmediate(r))
  assert.equal(session(a.to).title, 'Scheduled: Daily brief')

  // Archived from its page: the next run starts a new one.
  db.prepare('update claude_sessions set archived = 1 where id = ?').run(a.to)
  await assistant.tick(Date.parse('2026-11-07T09:00:30Z'))
  const fresh = runs().slice(4).find((r) => r.text.includes('Daily brief'))!
  assert.ok(fresh.to !== a.to && fresh.to !== chat)
  // Switching to the other agent's chat leaves its runs where they are.
  await assistant.switchTo(ann, 'opencode')
  await assistant.tick(Date.parse('2026-11-08T09:00:30Z'))
  assert.equal(runs().slice(6).find((r) => r.text.includes('Deploy check'))!.to, b.to)
  // No chat on its agent and account anymore (another account for Claude Code): on the agent they talk in now.
  await assistant.setup(ann, { harness: 'claude', profile: 'work' })
  await assistant.tick(Date.parse('2026-11-09T09:00:30Z'))
  const moved = runs().slice(8).find((r) => r.text.includes('Deploy check'))!
  assert.notEqual(moved.to, b.to)
  assert.deepEqual([session(moved.to).harness, session(moved.to).profile], ['claude', 'work'])
})

test("a schedule hands what needs the member to their chat, and the agent's answer there is the one notification", async () => {
  const { assistant, rpc, sent, notified, emit, ann } = setup()
  const { sessionId: chat } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  const check = assistant.createSchedule(ann, { title: 'Routine check', prompt: 'Did they finish their routine?', at: '21:00', days: 'daily' })
  const sends = () => sent.filter((r) => r.op === 'claude.send').map((r) => ({ to: (r.launch as { id: string }).id, text: (r.content as { text: string }[]).at(-1)!.text }))
  await assistant.tick(Date.parse('2026-11-05T21:00:30Z'))
  const run = assistant.schedules(ann).find((x) => x.id === check.id)!.conversation!
  assert.ok(run && run !== chat)
  assert.match(sends()[0]!.text, new RegExp(`Their chat with you is session ${chat}`), 'the run can read what they said there')

  await assert.rejects(rpc('ann', 'hand_off', chat, { note: 'x' }), /schedule's run/, 'in their chat there is nothing to hand over')
  await assert.rejects(rpc('ann', 'notify_me', run, { title: 'Routine not done' }), /use hand_off/, 'a run never pings them itself')
  assert.match(await rpc('ann', 'hand_off', run, { note: 'Nothing of the routine is done; ask what got in the way.' }) as string, /Handed to their chat/)
  const handed = sends().at(-1)!
  assert.equal(handed.to, chat)
  assert.match(handed.text, /^<system-reminder>Their schedule "Routine check" ran on its own[\s\S]*ask what got in the way\.[\s\S]*<\/system-reminder>$/)
  assert.equal(notified.length, 0, 'nothing until the agent has written to them')

  emit({ ev: 'claude.msg', id: chat, msg: { type: 'result', subtype: 'success', result: "It's 9 pm and none of today's routine is done. What got in the way?" } })
  assert.deepEqual(notified.map((n) => [n.userId, n.kind, n.title]), [[1, 'needs_you', 'Hamasa']])
  emit({ ev: 'claude.msg', id: chat, msg: { type: 'result', subtype: 'success', result: 'Got it, tomorrow at 8.' } })
  assert.equal(notified.length, 1, 'their own conversation after that notifies no one')
})

test("a dot on the launchers while the agent wrote in their chat and they haven't looked", async () => {
  const { assistant, emit, ann } = setup()
  const { sessionId: chat } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  const result = (id: string) => emit({ ev: 'claude.msg', id, msg: { type: 'result', subtype: 'success', result: 'Done.' } })
  assert.equal(assistant.state(ann).unread, false)
  result(chat!)
  assert.equal(assistant.state(ann).unread, true)
  assert.equal(assistant.seen(ann).unread, false)
  // A schedule's run happens out of their chat: no dot for it.
  assistant.createSchedule(ann, { title: 'Brief', prompt: 'Brief me.', at: '09:00', days: 'daily' })
  await assistant.tick(Date.parse('2026-11-05T09:00:30Z'))
  result(assistant.schedules(ann)[0]!.conversation!)
  assert.equal(assistant.state(ann).unread, false)
  // Clearing the chat clears the dot.
  result(chat!)
  await assistant.fresh(ann)
  assert.equal(assistant.state(ann).unread, false)
})

test("schedules' runs can't ping the member through the general notify tool either, and never run in their chat", async () => {
  const { assistant, claude, db, sent, ann } = setup()
  const { sessionId: chat } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  const brief = assistant.createSchedule(ann, { title: 'Brief', prompt: 'Brief me.', at: '09:00', days: 'daily' })
  await assistant.tick(Date.parse('2026-11-05T09:00:30Z'))
  const run = assistant.schedules(ann)[0]!.conversation!
  assert.match(String(claude.notifyFrom('ann', { sessionId: run, args: { message: 'Brief is ready' } })), /^Not sent: a schedule's run/)
  assert.doesNotMatch(String(await Promise.resolve(claude.notifyFrom('ann', { sessionId: chat, args: { message: 'Done' } })).catch((e: Error) => e.message)), /schedule/)

  // An earlier version could open a schedule's conversation as the chat: its next run goes to a new one, not the chat.
  db.prepare("update assistant_chats set session_id = ? where user_id = 1 and harness = 'claude'").run(run)
  await assistant.tick(Date.parse('2026-11-06T09:00:30Z'))
  const to = (sent.filter((r) => r.op === 'claude.send').at(-1)!.launch as { id: string }).id
  assert.ok(to !== run && to !== chat)
  assert.equal(assistant.schedules(ann).find((x) => x.id === brief.id)!.conversation, to)
})

test('after an update, conversations made before get the current instructions and allowed tools', async () => {
  const { assistant, claude, db, hub, session, notify, ann } = setup()
  const { sessionId: chat } = await assistant.setup(ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  db.prepare("update claude_sessions set instructions = 'old', tool_policy = '{\"allow\":[]}' where id = ?").run(chat)
  assistantService({ db, hub, claude, notify }) // the server starting again
  assert.match(String(session(chat!).instructions), /hand_off/)
  assert.ok((JSON.parse(String(session(chat!).tool_policy)).allow as string[]).includes('mcp__plugin_devdash_devdash__hand_off'))
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
