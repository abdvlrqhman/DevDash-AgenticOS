import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeService } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { registerAutopilotMcp } from './mcp.ts'
import { convertPrototypeRules, isDuplicate, localToUnix, parsePrototypeLog } from './migrate.ts'
import { autopilotService, type TeamPort } from './service.ts'
import { DEFAULTS, describePrompt, judge, limitedUntil, neverApprove, nightStart, obviousRed, parseTeamDecision, redQuestion, parseDecision, pingDue, type Candidate } from './sweep.ts'

const NOW = Date.parse('2026-11-06T02:00:00Z') // 03:00 in Berlin: night
const nowS = Math.floor(NOW / 1000)

const base: Candidate = {
  status: 'idle', mode: 'chat', started: true, archived: false, excluded: false, viewers: 0, lastActivity: nowS - 3600,
  lastSender: 'owner', goal: 'g1', statusDetail: null, memory: { goal: null, nudges: 0, lastError: null, checkedActivity: null }, inInbox: false,
}

test('sweep safeguards: never while someone is active, and not past the nudge limit', () => {
  assert.deepEqual(judge(base, DEFAULTS, nowS), { act: true })
  // Quiet gap: anyone's message or a status change within 20 minutes.
  assert.equal(judge({ ...base, lastActivity: nowS - 19 * 60 }, DEFAULTS, nowS).act, false)
  assert.equal(judge({ ...base, lastActivity: nowS - 21 * 60 }, DEFAULTS, nowS).act, true)
  assert.equal(judge({ ...base, lastActivity: nowS - 30 * 60 }, { ...DEFAULTS, quietMin: 45 }, nowS).act, false)
  // Someone (teammate or the member) has it open.
  assert.deepEqual(judge({ ...base, viewers: 1 }, DEFAULTS, nowS), { act: false, reason: 'someone has it open' })
  // A teammate's message is the last, or a turn (a guest's included) is running.
  assert.equal(judge({ ...base, lastSender: 'teammate' }, DEFAULTS, nowS).act, false)
  assert.equal(judge({ ...base, status: 'working' }, DEFAULTS, nowS).act, false)
  // Not the member's to run: Hamasa, team roles, proposals; nor CLI mode, archived or empty sessions.
  for (const c of [{ excluded: true }, { mode: 'cli' }, { archived: true }, { started: false }, { lastSender: null }]) {
    assert.equal(judge({ ...base, ...c } as Candidate, DEFAULTS, nowS).act, false)
  }
  // Already waiting in Needs you.
  assert.equal(judge({ ...base, inInbox: true }, DEFAULTS, nowS).act, false)
  // Nudge limit per goal: the third nudge was the last; a new goal (the member wrote) starts over.
  const nudged = (n: number) => ({ ...base, memory: { ...base.memory, goal: 'g1', nudges: n } })
  assert.equal(judge(nudged(2), DEFAULTS, nowS).act, true)
  assert.equal(judge(nudged(3), DEFAULTS, nowS).act, 'needs_you')
  assert.equal(judge({ ...nudged(3), goal: 'g2' }, DEFAULTS, nowS).act, true)
  // The same error after a nudge: stop early.
  const err = { ...nudged(1), status: 'error', statusDetail: 'ENOENT build.sh', memory: { ...nudged(1).memory, lastError: 'ENOENT build.sh' } }
  assert.deepEqual(judge(err, DEFAULTS, nowS), { act: 'needs_you', kind: 'stuck', reason: 'the same error again after a nudge' })
  assert.equal(judge({ ...err, statusDetail: 'another error' }, DEFAULTS, nowS).act, true)
  // Judged before and nothing happened since: no second model call.
  assert.equal(judge({ ...base, memory: { ...base.memory, goal: 'g1', checkedActivity: base.lastActivity } }, DEFAULTS, nowS).act, false)
})

test('nights run from one morning ping to the next; the ping is due once a day', () => {
  // 03:00 Berlin: the night started at 09:00 the day before.
  assert.equal(nightStart(NOW, 'Europe/Berlin', '09:00'), Date.parse('2026-11-05T08:00:00Z') / 1000)
  assert.equal(nightStart(Date.parse('2026-11-06T09:30:00Z'), 'Europe/Berlin', '09:00'), Date.parse('2026-11-06T08:00:00Z') / 1000)
  assert.equal(pingDue(NOW, 'Europe/Berlin', '09:00', null), null)
  assert.equal(pingDue(Date.parse('2026-11-06T08:05:00Z'), 'Europe/Berlin', '09:00', null), '2026-11-06')
  assert.equal(pingDue(Date.parse('2026-11-06T08:05:00Z'), 'Europe/Berlin', '09:00', '2026-11-06'), null)
})

test("the supervisor's answer: one action, red always left for the member", () => {
  assert.deepEqual(parseDecision('{"action":"continue","tier":"green","message":"Run the tests, then commit.","why":"next step of the plan"}'),
    { action: 'continue', tier: 'green', message: 'Run the tests, then commit.', answers: {}, why: 'next step of the plan' })
  assert.equal(parseDecision('```json\n{"action":"continue","tier":"red","message":"Publish now","why":"x"}\n```')!.action, 'needs_you')
  assert.equal(parseDecision('{"action":"continue","tier":"green","message":""}'), null)
  assert.equal(parseDecision('{"action":"answer","tier":"green","answers":{}}'), null)
  assert.equal(parseDecision('no idea'), null)
  assert.equal(parseDecision('{"action":"publish"}'), null)
})

test('the usage limit: paused until the earliest reset of a used-up window', () => {
  assert.equal(limitedUntil({ five_hour: { utilization: 79, resets_at: null }, seven_day: { utilization: 89 } }, nowS), null)
  assert.equal(limitedUntil({ five_hour: { utilization: 80, resets_at: '2026-11-06T04:00:00Z' }, seven_day: { utilization: 50 } }, nowS), Date.parse('2026-11-06T04:00:00Z') / 1000)
  assert.equal(limitedUntil({ five_hour: { utilization: 10 }, seven_day: { utilization: 91, resets_at: '2026-11-09T00:00:00Z' } }, nowS), Date.parse('2026-11-09T00:00:00Z') / 1000)
  assert.equal(limitedUntil(null, nowS), null)
})

// ---- The service, with a fake agent ----

function setup(o: { team?: TeamPort } = {}) {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'y@x.io', 'yo', 'Yara Haddad')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  const sent: Record<string, unknown>[] = []
  const reply = { decision: '{"action":"continue","tier":"green","message":"Carry on with step 2.","why":"next step of the agreed plan"}', utilization: 10, pending: [] as unknown[], error: null as string | null }
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  const agents = {
    onEvent: () => {},
    onRpc: (m: string, fn: (username: string, params: unknown) => unknown) => void rpcs.set(m, fn),
    request: async (_u: string, req: Record<string, unknown>) => {
      sent.push(req)
      if (req.op === 'claude.complete' && reply.error) throw new Error(reply.error)
      if (req.op === 'claude.complete') return { text: reply.decision }
      if (req.op === 'claude.usage') return { usage: { plan: 'max', available: true, limits: { five_hour: { utilization: reply.utilization, resets_at: '2026-11-06T05:00:00Z' } } } }
      if (req.op === 'claude.history') return { messages: [{ type: 'user', message: { content: 'Build step 1 and 2' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Step 1 done. Shall I do step 2?' }] } }] }
      if (req.op === 'claude.pending') return { pending: reply.pending }
      return { ok: true }
    },
  } as unknown as AgentsService
  const hub = createHub()
  const notified: { userId: number; title: string }[] = []
  const notify = async (userId: number, _k: string, n: { title: string }) => void notified.push({ userId, title: n.title })
  const claude = claudeService({ db, agents, hub, notify, projects: { forPath: () => null } as unknown as ProjectsService })
  let clock = NOW
  const autopilot = autopilotService({ db, hub, claude, notify, now: () => clock, team: () => o.team })
  registerAutopilotMcp({ agents, autopilot })
  const user = (id: number, name: string, username: string): User => ({ id, name, username, email: '', role: 'member' })
  const yo = user(1, 'Yara Haddad', 'yo'), bob = user(2, 'Bob', 'bob')
  /** A session of Yara's that went quiet an hour ago after his message `goal`. */
  const session = (id: string, o: { status?: string; detail?: string; shared?: boolean } = {}) => {
    db.prepare(`insert into claude_sessions (id, owner_id, title, cwd, started, status, status_detail, shared, shared_can_send, last_activity_at)
      values (?, 1, ?, '/home/yo/projects/app', 1, ?, ?, ?, ?, ?)`).run(id, `Session ${id}`, o.status ?? 'idle', o.detail ?? null, o.shared ? 1 : 0, o.shared ? 1 : 0, nowS - 3600)
    db.prepare('insert into claude_message_senders (session_id, message_uuid, user_id) values (?, ?, 1)').run(id, `${id}-goal`)
  }
  const quiet = (id: string) => db.prepare('update claude_sessions set last_activity_at = ?, status = ? where id = ?').run(Math.floor(clock / 1000) - 3600, 'idle', id)
  const rpc = (method: string, username: string, sessionId: string, args: Record<string, unknown> = {}) =>
    Promise.resolve().then(() => rpcs.get(`mcp.${method}`)!(username, { sessionId, args }))
  const sends = () => sent.filter((r) => r.op === 'claude.send') as { content: { type: string; text?: string }[]; uuid: string }[]
  return { db, hub, sent, sends, reply, notified, autopilot, claude, yo, bob, session, quiet, rpc, tick: (ms: number) => (clock += ms) }
}

test('rules ride on the owner\'s own messages only: in full once, then a line; off says so once', async () => {
  const t = setup()
  t.session('s1', { shared: true })
  await t.claude.send(t.yo, 's1', 'go', [])
  assert.equal(t.sends().at(-1)!.content.length, 1) // off: nothing added
  t.autopilot.setEnabled(t.yo, true)
  await t.claude.send(t.yo, 's1', 'go on', [])
  assert.match(t.sends().at(-1)!.content[0]!.text!, /Autopilot is ON for Yara[\s\S]*Red: never on autopilot/)
  await t.claude.send(t.yo, 's1', 'and more', [])
  assert.match(t.sends().at(-1)!.content[0]!.text!, /^<system-reminder>Autopilot is ON for Yara: follow/)
  // A teammate's message never gets them (it gets DevDash's teammate note instead).
  await t.claude.send(t.bob, 's1', 'hi from bob', [])
  assert.doesNotMatch(JSON.stringify(t.sends().at(-1)!.content), /Autopilot/)
  // Edited rules: the next message has them in full again.
  t.autopilot.setRules(t.yo, 'Only green: tests and commits.')
  await t.claude.send(t.yo, 's1', 'next', [])
  assert.match(t.sends().at(-1)!.content[0]!.text!, /Only green: tests and commits\./)
  t.autopilot.setEnabled(t.yo, false)
  await t.claude.send(t.yo, 's1', 'x', [])
  assert.match(t.sends().at(-1)!.content[0]!.text!, /Autopilot is now OFF/)
  await t.claude.send(t.yo, 's1', 'y', [])
  assert.equal(t.sends().at(-1)!.content.length, 1)
})

test('autopilot_log: logs green and yellow; refuses while off, on red, and in a teammate\'s turn', async () => {
  const t = setup()
  t.session('s1', { shared: true })
  await assert.rejects(t.rpc('autopilot_log', 'yo', 's1', { tier: 'green', what: 'x' }), /OFF/)
  t.autopilot.setEnabled(t.yo, true)
  assert.equal(await t.rpc('autopilot_log', 'yo', 's1', { tier: 'yellow', what: 'Picked SQLite', why: 'fewer services' }), 'Logged.')
  await assert.rejects(t.rpc('autopilot_log', 'yo', 's1', { tier: 'red', what: 'Publish' }), /never/)
  await assert.rejects(t.rpc('autopilot_log', 'bob', 's1', { tier: 'green', what: 'x' }), /own DevDash sessions/)
  await t.claude.send(t.bob, 's1', 'do it', [])
  await assert.rejects(t.rpc('autopilot_log', 'yo', 's1', { tier: 'green', what: 'x' }), /teammate/)
  const e = t.autopilot.entries(t.yo, { limit: 100 }).entries
  assert.equal(e.find((x) => x.tier === 'yellow')!.what, 'Picked SQLite')
  assert.equal(e.find((x) => x.tier === 'yellow')!.project, 'app')
  assert.equal(t.autopilot.state(t.yo).unseenYellow, 1)
  assert.equal(t.autopilot.seen(t.yo).unseenYellow, 0)
})

test('the sweep continues a stalled session, logs it, and stops at the nudge limit', async () => {
  const t = setup()
  t.session('s1')
  assert.deepEqual(await t.autopilot.sweep(), []) // off: nothing
  t.autopilot.setEnabled(t.yo, true)
  assert.deepEqual((await t.autopilot.sweep()).map((d) => d.what), ['continue'])
  const msg = t.sends().at(-1)!
  assert.match(JSON.stringify(msg.content), /\(Autopilot\) Carry on with step 2\./)
  const logged = t.autopilot.entries(t.yo, { limit: 100 }).entries.find((x) => x.tier === 'action')!
  assert.equal(logged.message, 'Carry on with step 2.')
  assert.equal(logged.session!.id, 's1')
  // Right after its own message: the quiet gap holds it back (the database's clock isn't the test's).
  t.db.prepare('update claude_sessions set last_activity_at = ? where id = ?').run(nowS - 60, 's1')
  assert.deepEqual(await t.autopilot.sweep(), [])
  for (let i = 0; i < 2; i++) {
    t.tick(3600_000)
    t.quiet('s1')
    assert.deepEqual((await t.autopilot.sweep()).map((d) => d.what), ['continue'])
  }
  t.tick(3600_000)
  t.quiet('s1')
  assert.deepEqual((await t.autopilot.sweep()).map((d) => d.what), ['stuck'])
  assert.match(t.autopilot.state(t.yo).inbox[0]!.title, /Stuck/)
  // The member writes in it: Needs you clears, the goal is new, nudges start over.
  await t.claude.send(t.yo, 's1', 'try another way', [])
  assert.equal(t.autopilot.state(t.yo).inbox.length, 0)
})

test('the sweep leaves red questions and approvals for the member, and answers green questions', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.session('red')
  t.reply.decision = '{"action":"continue","tier":"red","message":"Publish the video now?","why":"publishing outside the plan"}'
  await t.autopilot.sweep()
  assert.equal(t.sends().length, 0)
  const inbox = t.autopilot.state(t.yo).inbox
  assert.equal(inbox[0]!.kind, 'red')
  assert.equal(inbox[0]!.session!.id, 'red')

  t.session('ask', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] } }]
  t.reply.decision = '{"action":"answer","tier":"green","answers":{"Which DB?":"SQLite"},"why":"fewer services"}'
  await t.autopilot.sweep()
  const ans = t.sent.find((r) => r.op === 'claude.answer') as { result: { updatedInput: { answers: Record<string, string> } } }
  assert.match(ans.result.updatedInput.answers['Which DB?']!, /^SQLite \(answered by Autopilot for Yara, by their rules: fewer services\)$/)

  t.session('perm', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'r2', toolName: 'Bash', input: { command: 'rm -rf x' } }]
  await t.autopilot.sweep()
  assert.ok(t.autopilot.state(t.yo).inbox.some((i) => i.kind === 'permission' && i.session?.id === 'perm'))
})

test('the nightly cap and the usage limit stop the supervisor', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { nightCap: 2 })
  for (const id of ['a', 'b', 'c']) t.session(id)
  const did = await t.autopilot.sweep()
  assert.equal(did.length, 2)
  assert.ok(t.autopilot.entries(t.yo, { limit: 100 }).entries.some((e) => /Nightly cap reached/.test(e.what)))
  assert.ok(t.autopilot.state(t.yo).pausedUntil)

  const u = setup()
  u.autopilot.setEnabled(u.yo, true)
  u.session('a')
  u.reply.utilization = 99
  assert.deepEqual(await u.autopilot.sweep(), [])
  assert.equal(u.sends().length, 0)
  assert.ok(u.autopilot.entries(u.yo, { limit: 100 }).entries.some((e) => /paused/.test(e.what)))
})

test('the sweep skips a session where a teammate wrote last; turning autopilot off stops it', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.session('s1', { shared: true })
  t.db.prepare('insert into claude_message_senders (session_id, message_uuid, user_id) values (?, ?, 2)').run('s1', 'bob-1')
  assert.deepEqual(await t.autopilot.sweep(), [])
  t.session('s2')
  t.autopilot.setEnabled(t.yo, false)
  assert.deepEqual(await t.autopilot.sweep(), [])
  assert.equal(t.sends().length, 0)
})

test('the morning ping: only with something in Needs you or an unseen yellow decision', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.tick(Date.parse('2026-11-06T08:05:00Z') - NOW) // 09:05 Berlin
  await t.autopilot.morning()
  assert.equal(t.notified.length, 0)
  t.session('s1')
  await t.rpc('autopilot_log', 'yo', 's1', { tier: 'yellow', what: 'Switched to pnpm' })
  t.tick(86_400_000)
  await t.autopilot.morning()
  await t.autopilot.morning() // once a day
  assert.deepEqual(t.notified.map((n) => n.title), ['Autopilot: 1 decision to look at'])
})

test("a role's reply in a thread the session started is passed on to it, once", async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.reply.decision = '{"action":"done","tier":"green","message":"","why":"finished"}'
  t.session('s1')
  t.db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1)").run()
  const ceo = (t.db.prepare("insert into team_roles (project_id, name, summary, instructions, model, created_by) values (1, 'CEO', '', '', null, 1) returning id").get() as { id: number }).id
  const th = (t.db.prepare("insert into team_threads (project_id, title, opened_by) values (1, 'Pricing page', 'Session s1') returning id").get() as { id: number }).id
  const msg = t.db.prepare('insert into team_messages (thread_id, kind, body, author_role_id, author_session_id, author_label) values (?, ?, ?, ?, ?, ?)')
  msg.run(th, 'question', 'Can we ship the pricing page?', null, 's1', 'Session s1')
  msg.run(th, 'reply', 'Yes, but drop the annual toggle.', ceo, null, 'CEO')
  const did = await t.autopilot.sweep()
  assert.ok(did.some((d) => d.what === 'relay'))
  assert.match(JSON.stringify(t.sends().at(-1)!.content), /CEO wrote in team thread #\d+ \\"Pricing page\\"[\s\S]*drop the annual toggle/)
  t.tick(3600_000)
  t.quiet('s1')
  await t.autopilot.sweep()
  assert.equal(t.sends().filter((s) => /CEO wrote/.test(JSON.stringify(s.content))).length, 1)
})

// The prototype as it was on 2026-11-05 (~/.claude/autopilot).
const PROTO_LOG = `# Autopilot log

Every decision a session made for Yara while autopilot was on. Newest at the bottom.

- 2026-11-05 23:16 · ⚙️ **Autopilot turned on**
- 2026-11-05 23:36 · 🟢 · **home** · Sent the Autopilot build prompt to a new DevDash session instead of only giving it to you · _you offered either; sending it starts the work now_ · [session](/sessions/582e4d6d-a43e-4472-84a3-34bdddeabb92)
- 2026-11-05 23:40 · 🟡 · **hopsy** · Picked the calmer voice · _matches the tone_
`
const PROTO_RULES = `# Autopilot is ON (Yara's trial, started 2026-11-05)

Yara lets you make his routine decisions instead of stopping to ask him. Decide the way he would.

## Before every decision
- Log the decision at the moment you make it:
  \`~/.claude/autopilot/ap log green|yellow "<what you decided>" "<why: the rule or preference>"\`
  If it answers that autopilot is OFF, he turned it off: ask him as usual.

## 🟢 Green: decide, log, keep going
- The next step of a plan he already agreed to.

## 🟡 Yellow: decide, log, and notify his phone
- It adds something new to run or maintain.
Notify with the DevDash \`notify_me\` tool if you have it: one line saying what you decided and where.

## 🔴 Red: never on autopilot, stop and ask him
- Publishing that isn't already in an agreed plan.
- Deleting or overwriting anything that isn't your own scratch work.
`

test("the prototype moves in: its log with times in Berlin, its rules with DevDash's logging, and its toggle", async () => {
  assert.equal(localToUnix('2026-11-05', '23:16', 'Europe/Berlin'), Date.parse('2026-11-05T22:16:00Z') / 1000)
  assert.equal(localToUnix('2026-07-01', '09:00', 'Europe/Berlin'), Date.parse('2026-07-01T07:00:00Z') / 1000)
  const log = parsePrototypeLog(PROTO_LOG)
  assert.deepEqual(log.map((e) => [e.tier, e.project, e.sessionId]), [['system', null, null], ['green', 'home', '582e4d6d-a43e-4472-84a3-34bdddeabb92'], ['yellow', 'hopsy', null]])
  assert.equal(log[1]!.why, 'you offered either; sending it starts the work now')
  assert.match(log[1]!.what, /^Sent the Autopilot build prompt/)

  const rules = convertPrototypeRules(PROTO_RULES, 'Yara Haddad')!
  assert.doesNotMatch(rules, /ap log|notify_me|^# Autopilot is ON|🟢|🟡|🔴/m)
  assert.match(rules, /autopilot_log/)
  assert.match(rules, /## Red: never on autopilot/)

  const t = setup()
  t.db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('582e4d6d-a43e-4472-84a3-34bdddeabb92', 1, 'Autopilot', '/home/yo')").run()
  const r = t.autopilot.importPrototype('yo', { rules: PROTO_RULES, log: PROTO_LOG, state: 'on\n' })
  assert.deepEqual(r, { entries: 3, skipped: 0, customRules: true, enabled: true, approvals: false })
  const st = t.autopilot.state(t.yo)
  assert.equal(st.enabled, true)
  assert.equal(st.rules, rules)
  assert.equal(t.autopilot.entries(t.yo, { limit: 100 }).entries.find((e) => e.tier === 'green')!.session!.id, '582e4d6d-a43e-4472-84a3-34bdddeabb92')
  assert.throws(() => t.autopilot.importPrototype('yo', { log: PROTO_LOG }), /already moved/)
})

test('approvals: which prompts autopilot may decide, how they read, and the shorter wait when blocked', () => {
  assert.equal(neverApprove({ toolName: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' }, ownerOnly: true, askedBy: { id: 2, name: 'Bob' } }), "a teammate's request that uses your access")
  assert.equal(neverApprove({ toolName: 'mcp__plugin_devdash_devdash__devdash_deploy_request', input: {} }), 'a DevDash deploy request')
  assert.equal(neverApprove({ toolName: 'Bash', input: { command: 'npm test' } }), null)
  assert.equal(describePrompt({ toolName: 'Bash', input: { command: 'npm   test\n' } }), 'Bash: npm test')
  assert.equal(describePrompt({ toolName: 'mcp__plugin_devdash_devdash__task_update', input: {} }), 'task_update')
  assert.equal(describePrompt({ toolName: 'ExitPlanMode', input: { plan: 'Step 1' } }), 'Plan: Step 1')
  // Red approvals are declined, never approved; declining is only for red.
  assert.equal(parseDecision('{"action":"approve","tier":"red","why":"deletes data"}')!.action, 'decline')
  assert.equal(parseDecision('{"action":"approve","tier":"green","why":"runs tests"}')!.action, 'approve')
  assert.equal(parseDecision('{"action":"decline","tier":"green","why":"x"}'), null)
  // Blocked on a prompt: the prompt wait (2 minutes by default) instead of the quiet gap.
  const blocked = { ...base, status: 'waiting', lastActivity: nowS - 3 * 60 }
  assert.equal(judge(blocked, DEFAULTS, nowS).act, true)
  assert.equal(judge({ ...blocked, lastActivity: nowS - 60 }, DEFAULTS, nowS).act, false)
  assert.equal(judge(blocked, { ...DEFAULTS, promptWaitMin: 5 }, nowS).act, false)
  assert.equal(judge({ ...blocked, viewers: 1 }, DEFAULTS, nowS).act, false)
  assert.equal(judge({ ...blocked, lastSender: 'teammate' }, DEFAULTS, nowS).act, false)
  assert.equal(judge({ ...base, lastActivity: nowS - 3 * 60 }, DEFAULTS, nowS).act, false) // idle: the quiet gap still holds
})

test('approvals in the sweep: green approved, red declined and parked, guest gate and deploys never, viewers skipped', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { approvals: true })
  const answers = () => t.sent.filter((r) => r.op === 'claude.answer') as { id: string; requestId: string; result: { behavior: string; message?: string; updatedInput?: Record<string, unknown> } }[]

  t.session('green', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'g1', toolName: 'Bash', input: { command: 'npm test' } }]
  t.reply.decision = '{"action":"approve","tier":"green","why":"test runs are green"}'
  await t.autopilot.sweep()
  assert.deepEqual(answers().at(-1)!.result, { behavior: 'allow', updatedInput: { command: 'npm test' } })
  const approved = t.autopilot.entries(t.yo, { limit: 100 }).entries.find((e) => /^Approved/.test(e.what))!
  assert.equal(approved.what, 'Approved (green): Bash: npm test')
  assert.equal(approved.message, 'Bash: npm test')

  t.session('red', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf ~/videos/final' } }]
  t.reply.decision = '{"action":"approve","tier":"red","message":"deletes finished videos","why":"deleting what isn\'t scratch is red"}'
  await t.autopilot.sweep()
  const declined = answers().at(-1)!
  assert.equal(declined.requestId, 'r1')
  assert.equal(declined.result.behavior, 'deny')
  assert.match(declined.result.message!, /red[\s\S]*Needs you[\s\S]*carry on with other work/)
  assert.ok(t.autopilot.state(t.yo).inbox.some((i) => i.session?.id === 'red' && /rm -rf ~\/videos\/final/.test(i.title)))
  assert.ok(t.autopilot.entries(t.yo, { limit: 100 }).entries.some((e) => e.tier === 'red' && /Declined \(red\)/.test(e.what)))

  // The model would approve both, but these never are.
  t.reply.decision = '{"action":"approve","tier":"green","why":"x"}'
  t.session('guest', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'x1', toolName: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' }, ownerOnly: true, askedBy: { id: 2, name: 'Bob' } }]
  await t.autopilot.sweep()
  t.session('deploy', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'x2', toolName: 'mcp__plugin_devdash_devdash__devdash_deploy_request', input: { note: 'ship' } }]
  await t.autopilot.sweep()
  assert.ok(!answers().some((a) => a.requestId === 'x1' || a.requestId === 'x2'))
  const inbox = t.autopilot.state(t.yo).inbox
  assert.ok(inbox.some((i) => i.session?.id === 'guest' && i.kind === 'permission'))
  assert.ok(inbox.some((i) => i.session?.id === 'deploy' && i.kind === 'permission'))

  // Someone has the session open: nothing at all.
  t.session('viewed', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'v1', toolName: 'Bash', input: { command: 'npm test' } }]
  const viewers = t.hub.viewers
  t.hub.viewers = (topic: string) => (topic === 'session:viewed' ? [{ id: 1, name: 'Yara' }] : viewers(topic))
  await t.autopilot.sweep()
  assert.ok(!answers().some((a) => a.requestId === 'v1'))
  assert.ok(!t.autopilot.state(t.yo).inbox.some((i) => i.session?.id === 'viewed'))
})

test('approvals stay with the member while "Autopilot handles approvals" is off', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.session('p', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'p1', toolName: 'Bash', input: { command: 'npm test' } }]
  t.reply.decision = '{"action":"approve","tier":"green","why":"x"}'
  await t.autopilot.sweep()
  assert.ok(!t.sent.some((r) => r.op === 'claude.answer' || r.op === 'claude.complete'))
  assert.equal(t.autopilot.state(t.yo).inbox[0]!.kind, 'permission')
})

test("moving in after the deploy: decisions logged in both places aren't doubled, DevDash's toggle and rules win", async () => {
  const h = { at: Date.parse('2026-11-05T23:05:30Z') / 1000, tier: 'yellow', sessionId: 'ff', what: 'Added the small library built-in-math-eval to evaluate formulas for the video curves' }
  const e = { at: Date.parse('2026-11-05T23:05:00Z') / 1000, tier: 'yellow' as const, sessionId: 'ff', what: 'Add the small library built-in-math-eval to the video project to evaluate formulas like x^2 for the video curves' }
  assert.equal(isDuplicate(e, h), true)
  assert.equal(isDuplicate({ ...e, sessionId: 'other' }, h), false)
  assert.equal(isDuplicate({ ...e, at: e.at - 3600 }, h), false)
  assert.equal(isDuplicate({ ...e, what: 'Re-render the test video with the new layout' }, h), false)

  const t = setup()
  t.session('ff')
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setRules(t.yo, 'Edited in DevDash.')
  await t.rpc('autopilot_log', 'yo', 'ff', { tier: 'green', what: 'First local git commit of the project, no push' })
  const at = (h: number, m: number) => `2026-11-05 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const committed = new Date(t.autopilot.entries(t.yo, { limit: 100 }).entries[0]!.at * 1000)
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(committed).split(':').map(Number)
  const log = `- ${committed.toISOString().slice(0, 10)} ${local.map((n) => String(n).padStart(2, '0')).join(':')} · 🟢 · **app** · First local git commit of the project (no push) · [session](/sessions/ff)
- ${at(23, 59)} · 🟢 · **app** · Re-rendered the test video · [session](/sessions/ff)`
  t.autopilot.setEnabled(t.yo, false) // turned off in DevDash: the prototype's "on" doesn't override it
  const r = t.autopilot.importPrototype('yo', { rules: PROTO_RULES, log, state: 'on', approvals: true })
  assert.deepEqual(r, { entries: 1, skipped: 1, customRules: true, enabled: false, approvals: true })
  const st = t.autopilot.state(t.yo)
  assert.equal(st.rules, 'Edited in DevDash.')
  assert.equal(st.settings.approvals, true)
  assert.equal(t.autopilot.entries(t.yo, { limit: 100 }).entries.filter((x) => /git commit/.test(x.what)).length, 1)
})

test('obviously red requests: declined on sight, without reading the conversation', () => {
  const red = (command: string) => obviousRed({ toolName: 'Bash', input: { command } })
  assert.equal(red('rm ~/sessions/autopilot-e2e/keep2.txt'), 'it deletes files outside /tmp')
  assert.equal(red('cd app && rm -rf data'), 'it deletes files outside /tmp')
  assert.equal(red('rm -rf /tmp/build-1234'), null)
  assert.equal(red('git push --force origin main'), 'it force-pushes or deletes a remote branch')
  assert.equal(red('git push origin --delete dd/x'), 'it force-pushes or deletes a remote branch')
  assert.equal(red('git push origin HEAD:main'), null)
  assert.equal(red('git reset --hard HEAD~3'), 'it throws away work (git reset --hard)')
  assert.equal(red('git branch -D old'), 'it deletes a branch')
  assert.equal(red('psql -c "DROP TABLE users"'), 'it drops data')
  assert.equal(red('npm publish'), 'it publishes or deletes outside this server')
  assert.equal(red('sudo systemctl restart x'), 'it uses sudo')
  assert.equal(red('npm test && git commit -am "x"'), null)
  assert.equal(obviousRed({ toolName: 'Write', input: { file_path: '/home/yo/a.txt' } }), null)
})

test('a prompt is handled on its own, soon after it appears: obvious red without a model call, green after a look', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { approvals: true })
  t.session('soon', { status: 'waiting' })
  // Asked 3 minutes ago: past the 2-minute wait.
  t.db.prepare('update claude_sessions set last_activity_at = ? where id = ?').run(nowS - 180, 'soon')
  t.reply.pending = [{ requestId: 'd1', toolName: 'Bash', input: { command: 'rm ~/notes/real.md' } }]
  assert.deepEqual((await t.autopilot.promptNow('soon', 1)).map((d) => d.what), ['decline'])
  assert.ok(!t.sent.some((r) => r.op === 'claude.complete'))
  const deny = t.sent.find((r) => r.op === 'claude.answer') as { result: { behavior: string; message: string } }
  assert.equal(deny.result.behavior, 'deny')
  assert.match(deny.result.message, /it deletes files outside \/tmp/)

  // Only this session, and only once the member had their 2 minutes.
  t.session('other', { status: 'waiting' })
  t.session('fresh', { status: 'waiting' })
  t.db.prepare('update claude_sessions set last_activity_at = ? where id = ?').run(nowS - 30, 'fresh')
  t.reply.pending = [{ requestId: 'g1', toolName: 'Bash', input: { command: 'npm test' } }]
  t.reply.decision = '{"action":"approve","tier":"green","why":"test runs are green"}'
  assert.deepEqual(await t.autopilot.promptNow('fresh', 1), [])
  t.db.prepare('update claude_sessions set last_activity_at = ? where id = ?').run(nowS - 150, 'fresh')
  assert.deepEqual((await t.autopilot.promptNow('fresh', 1)).map((d) => d.session + ':' + d.what), ['fresh:approve'])
  assert.ok(!t.sent.some((r) => r.op === 'claude.answer' && (r as { id?: string }).id === 'other'))
  // Off: nothing.
  t.autopilot.setEnabled(t.yo, false)
  assert.deepEqual(await t.autopilot.promptNow('other', 1), [])
})

test('a question about something red is never answered, not even with the safe "No"; Needs you clears with the session', async () => {
  assert.equal(redQuestion('Publish the test video publicly now?'), 'it asks about publishing')
  assert.equal(redQuestion('Should I email the client the report?'), 'it asks about sending to people')
  assert.equal(redQuestion('Delete the old branch?'), 'it asks about deleting or overwriting')
  assert.equal(redQuestion('Upgrade the plan to get more credits?'), 'it asks about money')
  assert.equal(redQuestion('Which database should we use?'), null)
  assert.equal(redQuestion('Use tabs or spaces?'), null)

  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.session('pub', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Publish the test video publicly now?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }]
  t.reply.decision = '{"action":"answer","tier":"green","answers":{"Publish the test video publicly now?":"No"},"why":"not publishing is safe"}'
  assert.deepEqual((await t.autopilot.sweep()).map((d) => d.what), ['needs_you'])
  assert.ok(!t.sent.some((r) => r.op === 'claude.answer' || r.op === 'claude.complete'))
  assert.equal(t.autopilot.state(t.yo).inbox[0]!.title, 'Publish the test video publicly now?')
  // Archived (or deleted): its Needs you item goes with it.
  t.db.prepare('update claude_sessions set archived = 1 where id = ?').run('pub')
  assert.equal(t.autopilot.state(t.yo).inbox.length, 0)
})

test('the log: by when it happened, filtered by who, tier, project and words, paged with a total', () => {
  const t = setup()
  const add = (at: number, tier: 'green' | 'yellow' | 'action' | 'system', source: 'session' | 'supervisor' | 'system', project: string | null, what: string) =>
    t.autopilot.log(1, { at, tier, source, project, what })
  add(nowS - 100, 'action', 'supervisor', 'app', 'Approved (green): Plan: ship it')
  add(nowS - 86_400 * 2, 'green', 'session', 'app', 'Moved in: an old decision') // written later, happened earlier
  add(nowS - 50, 'yellow', 'session', 'site', 'Picked 50% off')
  add(nowS - 10, 'system', 'system', null, 'Autopilot turned on')
  const all = t.autopilot.entries(t.yo)
  assert.equal(all.total, 4)
  assert.deepEqual(all.entries.map((e) => e.what), ['Autopilot turned on', 'Picked 50% off', 'Approved (green): Plan: ship it', 'Moved in: an old decision'])
  assert.deepEqual(t.autopilot.entries(t.yo, { order: 'old' }).entries.map((e) => e.what)[0], 'Moved in: an old decision')
  assert.deepEqual(t.autopilot.entries(t.yo, { who: 'autopilot' }).entries.map((e) => e.what), ['Approved (green): Plan: ship it'])
  assert.equal(t.autopilot.entries(t.yo, { who: 'sessions', project: 'app' }).total, 1)
  assert.equal(t.autopilot.entries(t.yo, { tier: 'yellow' }).total, 1)
  assert.equal(t.autopilot.entries(t.yo, { q: '50%' }).total, 1) // % means itself
  assert.equal(t.autopilot.entries(t.yo, { q: 'nothing like this' }).total, 0)
  const page = t.autopilot.entries(t.yo, { limit: 2, offset: 2 })
  assert.deepEqual([page.total, page.entries.length], [4, 2])
  assert.deepEqual(all.projects, ['app', 'site'])
})

test("the AI team's asks: only in projects turned on, after 30 minutes, approved or answered as the member, never declined", async () => {
  assert.equal(parseTeamDecision('{"action":"approve","tier":"red","why":"spends money"}', 'proposal')!.action, 'needs_you')
  assert.equal(parseTeamDecision('{"action":"answer","tier":"green","why":"x"}', 'ask')!.action, 'needs_you') // no reply text
  assert.equal(parseTeamDecision('{"action":"approve","tier":"green","why":"x"}', 'ask')!.action, 'needs_you') // doesn't fit
  assert.equal(parseTeamDecision('{"action":"approve","tier":"yellow","why":"x"}', 'proposal')!.action, 'approve')

  const old = nowS - 3600, fresh = nowS - 600
  const approved: number[] = [], answered: { slug: string; thread: number; body: string }[] = []
  const team: TeamPort = {
    projects: () => [{ id: 1, slug: 'shop', name: 'Shop' }, { id: 2, slug: 'oss', name: 'OSS' }],
    waiting: (projectId) => projectId === 1 ? {
      proposals: [
        { id: 11, kind: 'task', title: 'Add a pricing FAQ task', why: 'support questions', role: 'CEO', project: 'shop', createdAt: old, url: '/approvals/shop' },
        { id: 12, kind: 'task', title: 'Fresh one', why: 'x', role: 'CEO', project: 'shop', createdAt: fresh, url: '/approvals/shop' },
        { id: 13, kind: 'other', title: 'Hire a designer', why: 'x', role: 'CEO', project: 'shop', createdAt: old, url: '/approvals/shop' },
        { id: 14, kind: 'code', title: 'Publish the landing page', why: 'launch', role: 'CMO', project: 'shop', createdAt: old, url: '/approvals/shop' },
      ],
      asks: [{ id: 7, title: 'Onboarding copy', ask: 'Short or long welcome text?', role: 'CEO', project: 'shop', updatedAt: old, lastMessage: 70, url: '/projects/shop/team/threads/7', recent: ['CEO: Short or long?'] }],
    } : { proposals: [{ id: 21, kind: 'task', title: 'Other project', why: 'x', role: 'CEO', project: 'oss', createdAt: old, url: '/approvals/oss' }], asks: [] },
    approve: async (_u, id) => void approved.push(id),
    answer: (_u, slug, thread, body) => void answered.push({ slug, thread, body }),
  }
  const projects = (x: ReturnType<typeof setup>) => x.db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1), (2, 'oss', 'OSS', 1)").run()
  const t = setup({ team })
  projects(t)
  t.autopilot.setEnabled(t.yo, true)
  assert.deepEqual(t.autopilot.state(t.yo).team!.map((p) => p.on), [false, false]) // off by default
  assert.deepEqual(await t.autopilot.teamAsks(t.yo), [])

  t.autopilot.setTeam(t.yo, 1, true)
  t.reply.decision = '{"action":"approve","tier":"green","message":"","why":"a backlog task is routine"}'
  const first = await t.autopilot.teamAsks(t.yo)
  assert.deepEqual(approved, [11]) // not the fresh one, not "other", not publishing, not the other project
  const inbox = t.autopilot.state(t.yo).inbox
  assert.ok(inbox.some((i) => /Hire a designer/.test(i.title) && i.url === '/approvals/shop'))
  assert.ok(inbox.some((i) => /Publish the landing page/.test(i.title)))
  // The thread's question: the model said "approve", which doesn't fit a question: it waits for the member.
  assert.ok(first.some((d) => d.session === 'ask:7:70' && d.what === 'needs_you'))
  assert.ok(t.autopilot.entries(t.yo, { who: 'autopilot' }).entries.some((e) => /^Approved for the team \(green\): CEO \(shop\) proposes: Add a pricing FAQ task/.test(e.what)))

  // Handled once: a second pass does nothing more.
  assert.deepEqual(await t.autopilot.teamAsks(t.yo), [])

  // A new message in the thread is a new ask; this time an answer, sent as the member and marked.
  const u = setup({ team: { ...team, waiting: (id) => ({ ...team.waiting(id), proposals: [] }) } })
  projects(u)
  u.autopilot.setEnabled(u.yo, true)
  u.autopilot.setTeam(u.yo, 1, true)
  u.reply.decision = '{"action":"answer","tier":"green","message":"Short: two lines.","why":"he likes short, calm copy"}'
  await u.autopilot.teamAsks(u.yo)
  assert.equal(answered.at(-1)!.thread, 7)
  assert.match(answered.at(-1)!.body, /^Short: two lines\.\n\n\(Autopilot for Yara, by their rules: he likes short, calm copy\)$/)
  assert.throws(() => u.autopilot.setTeam(u.yo, 99, true), /No AI team/)
})

test('supervisor settings: saved, returned in state, and logged', () => {
  const t = setup()
  const s = t.autopilot.state(t.yo)
  assert.deepEqual(s.supervisor, { harness: 'claude', profile: 'default', model: 'sonnet', dailyCap: 100, modelCallsToday: 0 })
  t.autopilot.setSettings(t.yo, { svHarness: 'opencode', svProfile: 'default', svModel: 'anthropic/claude-sonnet-4-5', svDailyCap: 50 })
  const s2 = t.autopilot.state(t.yo)
  assert.equal(s2.supervisor.harness, 'opencode')
  assert.equal(s2.supervisor.model, 'anthropic/claude-sonnet-4-5')
  assert.equal(s2.supervisor.dailyCap, 50)
  assert.ok(t.autopilot.entries(t.yo, { limit: 100 }).entries.some((e) => /Supervisor: OpenCode/.test(e.what)))
  assert.throws(() => t.autopilot.setSettings(t.yo, { svHarness: 'unknown' as string }), /Unknown agent/)
  assert.throws(() => t.autopilot.setSettings(t.yo, { svProfile: '!!!bad' }), /Unknown profile/)
})

test('red checks run before any model call, regardless of supervisor settings', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { approvals: true, svHarness: 'opencode', svModel: 'gpt-4o' })

  // obviousRed: declined without a model call
  t.session('red-rm', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'r1', toolName: 'Bash', input: { command: 'rm ~/real.txt' } }]
  t.reply.decision = '{"action":"approve","tier":"green","why":"x"}'
  const before = t.sent.filter((r) => r.op === 'claude.complete').length
  await t.autopilot.sweep()
  assert.equal(t.sent.filter((r) => r.op === 'claude.complete').length, before)
  const deny = t.sent.find((r) => r.op === 'claude.answer' && (r as { requestId: string }).requestId === 'r1') as { result: { behavior: string } }
  assert.equal(deny.result.behavior, 'deny')

  // redQuestion: never answered, no model call
  t.session('red-q', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Delete old backups?' }] } }]
  const before2 = t.sent.filter((r) => r.op === 'claude.complete').length
  await t.autopilot.sweep()
  assert.equal(t.sent.filter((r) => r.op === 'claude.complete').length, before2)
  assert.ok(t.autopilot.state(t.yo).inbox.some((i) => i.session?.id === 'red-q'))

  // neverApprove: guest gate, no model call
  t.session('guest', { status: 'waiting' })
  t.reply.pending = [{ requestId: 'g1', toolName: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' }, ownerOnly: true, askedBy: { id: 2 } }]
  const before3 = t.sent.filter((r) => r.op === 'claude.complete').length
  await t.autopilot.sweep()
  assert.equal(t.sent.filter((r) => r.op === 'claude.complete').length, before3)
  assert.ok(t.autopilot.state(t.yo).inbox.some((i) => i.session?.id === 'guest'))
})

test('the OpenCode daily cap pauses the supervisor until the next morning', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { svHarness: 'opencode', svModel: 'gpt-4o', svDailyCap: 2 })
  t.session('a')
  t.session('b')
  t.session('c')
  const did = await t.autopilot.sweep()
  assert.equal(did.filter((d) => d.what === 'continue').length, 2)
  assert.ok(t.autopilot.state(t.yo).pausedUntil)
  assert.ok(t.autopilot.entries(t.yo, { limit: 100 }).entries.some((e) => /daily cap reached/.test(e.why ?? '')))
  assert.equal(t.autopilot.state(t.yo).supervisor.modelCallsToday, 2)
})

test('supervisor fallback: resets to defaults when the configured model or profile errors', async () => {
  const t = setup()
  t.autopilot.setEnabled(t.yo, true)
  t.autopilot.setSettings(t.yo, { svHarness: 'opencode', svProfile: 'gone', svModel: 'bad-model' })
  t.session('s1')
  t.reply.error = 'Unknown profile: gone'
  await t.autopilot.sweep()
  t.reply.error = null
  const s = t.autopilot.state(t.yo)
  assert.equal(s.supervisor.harness, 'claude')
  assert.equal(s.supervisor.profile, 'default')
  assert.equal(s.supervisor.model, 'sonnet')
  assert.ok(t.autopilot.entries(t.yo, { limit: 100 }).entries.some((e) => /reset to the default/.test(e.what)))
})
