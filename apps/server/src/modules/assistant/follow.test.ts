import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openDb, type Db } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { autopilotService } from '../autopilot/service.ts'
import { claudeService } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { due, followService, hash, MAX_REPLIES, mayReply, reminder, STALE_S, type Item, type SessionSeen } from './follow.ts'
import { registerAssistantMcp } from './mcp.ts'
import { assistantService } from './service.ts'

const T = Math.floor(Date.now() / 1000)
const seen = (o: Partial<SessionSeen> = {}): SessionSeen => ({
  id: 'work', owner_id: 1, title: 'Polish the panel', status: 'idle', status_detail: null, archived: 0, last_activity_at: T, mode: 'chat', project_slug: 'shop', ...o,
})

test('due: what a followed session has to tell, from its row against the cursor alone', () => {
  const f = { seen_activity: T - 10, started_at: T - 100 }
  assert.equal(due(f, seen({ status: 'working' }), T), null, 'still working')
  assert.equal(due(f, seen(), T), 'finished')
  assert.equal(due({ ...f, seen_activity: T }, seen(), T), null, 'told already: the same state twice is nothing')
  assert.equal(due(f, seen({ status: 'error' }), T), 'failed')
  assert.equal(due(f, seen({ status: 'waiting' }), T, { waitingOn: 'question' }), 'asks')
  assert.equal(due(f, seen({ status: 'waiting' }), T + 30, { waitingOn: 'permission', approvalsWait: 130 }), 'hold', "autopilot's approvals go first")
  assert.equal(due(f, seen({ status: 'waiting' }), T + 131, { waitingOn: 'permission', approvalsWait: 130 }), 'approval')
  assert.equal(due(f, seen({ status: 'waiting' }), T, { waitingOn: 'permission', approvalsWait: null }), 'approval')
  assert.equal(due(f, seen({ archived: 1 }), T), 'gone')
  assert.equal(due(f, undefined, T), 'gone')
  assert.equal(due({ seen_activity: T, started_at: T }, seen(), T + STALE_S + 1), 'stale')
})

test('mayReply: the limits on answering for the member, each with its reason', () => {
  const ok = { own: true, cli: false, state: 'on', replies: 0, max: 5, tookOver: false, loop: false, tier: 'green', why: 'agreed: PR next', blocked: null }
  assert.equal(mayReply(ok), null)
  assert.match(mayReply({ ...ok, own: false })!, /teammate's session/)
  assert.match(mayReply({ ...ok, tier: 'red' })!, /Red is never/)
  assert.match(mayReply({ ...ok, tier: undefined })!, /Give tier/)
  assert.match(mayReply({ ...ok, why: ' ' })!, /Give why/)
  assert.match(mayReply({ ...ok, blocked: 'Autopilot is off (or paused) for them' })!, /Autopilot is off/)
  assert.match(mayReply({ ...ok, replies: 5 })!, /5 times/)
  assert.match(mayReply({ ...ok, state: 'waiting_you' })!, /wait until they write/)
  assert.match(mayReply({ ...ok, tookOver: true })!, /took over/)
  assert.match(mayReply({ ...ok, loop: true })!, /circles/)
  assert.match(mayReply({ ...ok, cli: true })!, /CLI/)
})

test('the reminder: every session oldest first, its goal, answer and budget, the question but never a way to approve', () => {
  const f = { id: 1, user_id: 1, session_id: 'a', goal: 'PR open', started_at: T, seen_activity: T, replies: 2, max_replies: 5, last_sent_uuid: null, replied_hash: null, state: 'on' as const }
  const items: Item[] = [
    { follow: f, session: seen({ id: 'a' }), kind: 'finished', answer: 'x'.repeat(3000), ask: null, tookOver: false, loop: false },
    { follow: { ...f, session_id: 'b' }, session: seen({ id: 'b', title: 'Push it' }), kind: 'approval', answer: null, ask: 'Bash: git push', tookOver: false, loop: false },
  ]
  const r = reminder('Ann', items, false)
  assert.match(r, /^<system-reminder>[\s\S]*<\/system-reminder>$/)
  assert.ok(r.indexOf('/sessions/a') < r.indexOf('/sessions/b'))
  assert.match(r, /Goal: "PR open"/)
  assert.match(r, /replies left: 3 of 5/)
  assert.match(r, /only Ann decides this; you never can/)
  assert.match(r, /Autopilot: off, so you only report/)
  assert.ok(r.length < 2500, 'long answers are clipped')
})

test('no tool answers a permission prompt for the member', () => {
  const src = readFileSync(new URL('../../../../../packages/claude-plugin/mcp/assistant.mjs', import.meta.url), 'utf8')
  const names = [...src.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]!)
  assert.ok(names.includes('follow_reply') && names.includes('follow_answer') && names.includes('session_follow'))
  assert.deepEqual(names.filter((n) => /approv|permi|allow|grant/.test(n)), [])
})

function setup(shared?: { db: Db }) {
  const db = shared?.db ?? openDb(':memory:')
  if (!shared) {
    const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
    add.run(1, 'a@x.io', 'ann', 'Ann Lee', 'admin')
    add.run(2, 'b@x.io', 'bob', 'Bob', 'member')
  }
  const sent: Record<string, unknown>[] = []
  const fake = { pending: [] as unknown[], history: [] as unknown[], failSendTo: null as string | null }
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  let onEvent: ((username: string, ev: Record<string, unknown>) => void) | undefined
  const agents = {
    onEvent: (fn: typeof onEvent) => { onEvent = fn },
    onRpc: (m: string, fn: (username: string, params: unknown) => unknown) => void rpcs.set(m, fn),
    request: async (_u: string, req: Record<string, unknown>) => {
      if (req.op === 'claude.send' && (req.launch as { id: string }).id === fake.failSendTo) throw new Error('agent unreachable')
      sent.push(req)
      if (req.op === 'claude.pending') return { pending: fake.pending }
      if (req.op === 'claude.history') return { messages: fake.history }
      if (req.op === 'claude.usage') return { usage: { limits: { five_hour: { utilization: 10 } } } }
      return { ok: true }
    },
  } as unknown as AgentsService
  const hub = createHub()
  const notified: { userId: number; kind: string; title: string; body?: string; tag?: string }[] = []
  const notify = async (userId: number, kind: string, n: { title: string; body?: string; tag?: string }) => void notified.push({ userId, kind, ...n })
  const claude = claudeService({ db, agents, hub, notify, projects: { forPath: () => null, rescan: () => {} } as unknown as ProjectsService })
  const assistant = assistantService({ db, hub, claude, notify })
  const autopilot = autopilotService({ db, hub, claude, notify })
  let clock = Date.now()
  const follow = followService({ db, hub, agents, claude, assistant, autopilot, notify, now: () => clock })
  registerAssistantMcp({ agents, claude, assistant, projects: {} as ProjectsService, notify, follow })
  const ann: User = { id: 1, name: 'Ann Lee', username: 'ann', email: '', role: 'admin' }
  const rpc = (method: string, sessionId: string, args: Record<string, unknown> = {}) =>
    Promise.resolve().then(() => rpcs.get(`mcp.${method}`)!('ann', { sessionId, args }))
  const emit = (ev: Record<string, unknown>) => onEvent?.('ann', ev)
  const sends = () => sent.filter((r) => r.op === 'claude.send').map((r) => ({ to: (r.launch as { id: string }).id, text: (r.content as { text?: string }[]).at(-1)!.text! }))
  const nowS = () => Math.floor(clock / 1000)
  /** A session of Ann's that's working on something. */
  const session = (id: string, title = `Session ${id}`) => {
    db.prepare(`insert into claude_sessions (id, owner_id, title, cwd, started, status, last_activity_at) values (?, 1, ?, '/home/ann', 1, 'working', ?)`).run(id, title, nowS() - 600)
    db.prepare('insert into claude_message_senders (session_id, message_uuid, user_id) values (?, ?, 1)').run(id, `${id}-goal`)
  }
  const set = (id: string, status: string, ago = 0) => db.prepare('update claude_sessions set status = ?, last_activity_at = ? where id = ?').run(status, nowS() - ago, id)
  /** Ann's chat, quiet for a while so a reminder may go. */
  const quietChat = (id: string) => set(id, 'idle', 120)
  return {
    db, hub, sent, fake, notified, claude, assistant, autopilot, follow, ann, rpc, emit, sends, session, set, quietChat,
    tick: (ms: number) => (clock += ms), nowS,
  }
}

async function ready(t = setup()) {
  const st = await t.assistant.setup(t.ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  t.follow.setOn(t.ann, true)
  t.session('work', 'Polish the panel')
  t.session('pr', 'Open the PR')
  t.follow.follow(t.ann, 'work', 'panel polished')
  t.follow.follow(t.ann, 'pr', 'PR open')
  t.quietChat(st.sessionId!)
  return { ...t, chat: st.sessionId! }
}
const reminders = (t: Awaited<ReturnType<typeof ready>>) => t.sends().filter((s) => s.to === t.chat && s.text.startsWith('<system-reminder>Sessions you follow'))

test('off by default, and only an admin turns it on for themself', async () => {
  const t = setup()
  await t.assistant.setup(t.ann, { harness: 'claude', profile: 'default', tz: 'UTC' })
  t.session('work')
  assert.throws(() => t.follow.follow(t.ann, 'work', 'x'), /isn't turned on/)
  assert.throws(() => t.follow.setOn({ ...t.ann, role: 'member' }, true), /admin/)
  t.follow.setOn(t.ann, true)
  assert.match(t.follow.follow(t.ann, 'work', 'done'), /Following "Session work"/)
  assert.equal(t.follow.state(t.ann).sessions.length, 1)
})

test('two sessions finishing together wake Hamasa once, oldest first; telling it again needs something new', async () => {
  const t = await ready()
  t.set('pr', 'idle', 20)
  t.set('work', 'waiting', 5)
  t.fake.pending = [{ requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Grey' }] }] } }]
  assert.equal(await t.follow.deliver(1), true)
  const r = reminders(t)
  assert.equal(r.length, 1)
  assert.ok(r[0]!.text.indexOf('Open the PR') < r[0]!.text.indexOf('Polish the panel'), 'oldest first')
  assert.match(r[0]!.text, /Asks: Which colour\? \[Blue \| Grey\]/)
  // The wake turn ends: then nothing new means nothing more, however often it looks.
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'PR session is done; the panel one asks blue or grey.' } })
  t.quietChat(t.chat)
  assert.equal(await t.follow.deliver(1), false)
  await t.follow.tick()
  assert.equal(reminders(t).length, 1)
})

test("their messages come first: nothing while the chat is busy, waits for them, or they just wrote", async () => {
  const t = await ready()
  t.set('work', 'idle', 5)
  t.set(t.chat, 'working')
  assert.equal(await t.follow.deliver(1), false)
  t.set(t.chat, 'waiting', 200)
  assert.equal(await t.follow.deliver(1), false)
  t.set(t.chat, 'idle', 10)
  assert.equal(await t.follow.deliver(1), false, 'they wrote 10 s ago')
  t.quietChat(t.chat)
  assert.equal(await t.follow.deliver(1), true)
})

test('switching to the other chat mid-wake: the woken one still answers it, and nothing wakes the other on top', async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'idle', 5)
  assert.equal(await t.follow.deliver(1), true)
  // They switch to their OpenCode chat while Hamasa answers in the Claude Code one.
  const other = (await t.assistant.switchTo(t.ann, 'opencode')).sessionId!
  t.quietChat(other)
  t.set('pr', 'idle', 5)
  assert.equal(await t.follow.deliver(1), false, 'still answering the last one')
  await t.rpc('follow_reply', t.chat, { id: 'work', text: 'Next step', tier: 'green', why: 'the agreed plan' })
  assert.equal(t.sends().filter((s) => s.to === 'work').length, 1)
  // That turn ends: the next wake goes to the chat they talk in now.
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'Continued the panel.' } })
  t.quietChat(other)
  assert.equal(await t.follow.deliver(1), true)
  assert.ok(t.sends().some((s) => s.to === other && s.text.startsWith('<system-reminder>Sessions you follow')))
})

test('a restart loses nothing and tells nothing twice: the cursor is in the database', async () => {
  const t = await ready()
  t.set('work', 'idle', 5) // finished while the server was down: no event ever came
  const after = setup({ db: t.db }) // the server again, on the same database, nothing in memory
  assert.equal(await after.follow.deliver(1), true)
  assert.equal(after.sends().filter((s) => s.to === t.chat).length, 1)
  const again = setup({ db: t.db })
  assert.equal(await again.follow.deliver(1), false)
  await again.follow.tick()
  assert.equal(again.sends().length, 0)
})

test('autopilot off: Hamasa only reports, and the reminder says so', async () => {
  const t = await ready()
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  assert.match(reminders(t)[0]!.text, /Autopilot: off, so you only report/)
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'Open the PR', tier: 'green', why: 'agreed' }), /Autopilot is off/)
  await assert.rejects(t.rpc('session_send', t.chat, { id: 'work', text: 'Open the PR' }), /follow_reply/, 'not around the limits either')
})

test(`at most ${MAX_REPLIES} automatic replies until they write; writing themself starts it again`, async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  for (let i = 0; i < MAX_REPLIES; i++) await t.rpc('follow_reply', t.chat, { id: 'work', text: `Step ${i + 2}`, tier: 'green', why: 'the agreed plan' })
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'One more', tier: 'green', why: 'plan' }), /5 times/)
  assert.equal(t.sends().filter((s) => s.to === 'work').length, MAX_REPLIES)
  assert.match(t.sends().filter((s) => s.to === 'work')[0]!.text, /^\(From Hamasa, Ann's personal agent, on autopilot\) Step 2/)
  const log = t.autopilot.entries(t.ann, {}).entries as { what: string; message: string | null }[]
  assert.equal(log.filter((e) => /^Hamasa continued \(green\)/.test(e.what)).length, MAX_REPLIES, 'each reply logged word for word')
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'x', tier: 'red', why: 'publish' }), /Red is never/)
  // Ann writes in her chat: the count starts again once that turn is over.
  t.emit({ ev: 'claude.status', id: t.chat, status: 'idle' })
  await t.claude.send(t.ann, t.chat, 'go on with it', [], [], [], { typed: true })
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'x', tier: 'green', why: 'plan' }), /writing to you now/)
  t.emit({ ev: 'claude.status', id: t.chat, status: 'idle' })
  assert.match(await t.rpc('follow_reply', t.chat, { id: 'work', text: 'Step 7', tier: 'green', why: 'she said go on' }) as string, /Sent/)
})

test('a person writing in the session takes over; the same answer after a reply is a loop', async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.fake.history = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Tests fail: snapshot mismatch.' }] } }]
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  await t.rpc('follow_reply', t.chat, { id: 'work', text: 'Update the snapshot', tier: 'green', why: 'agreed' })
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'Told it to update the snapshot.' } })
  t.tick(60_000)
  t.quietChat(t.chat)
  t.set('work', 'idle', 1) // …and it says exactly the same again
  await t.follow.deliver(1)
  assert.match(reminders(t).at(-1)!.text, /going in circles/)
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'Try again', tier: 'green', why: 'x' }), /told them|circles/)

  t.db.prepare("insert into claude_message_senders (session_id, message_uuid, user_id) values ('pr', 'typed-by-bob', 2)").run()
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'pr', text: 'x', tier: 'green', why: 'x' }), /took over/)
})

test('questions: answered within autopilot and marked; permissions and red questions never', async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'waiting', 5)
  t.fake.pending = [{ requestId: 'p1', toolName: 'Bash', input: { command: 'git push' } }]
  await t.follow.deliver(1)
  assert.match(reminders(t)[0]!.text, /Asks permission for: Bash: git push \(only Ann decides this; you never can\)/)
  await assert.rejects(t.rpc('follow_answer', t.chat, { id: 'work', answers: { x: 'yes' }, tier: 'green', why: 'x' }), /only Ann decides those/)

  t.fake.pending = [{ requestId: 'q2', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Publish the release now?' }] } }]
  await assert.rejects(t.rpc('follow_answer', t.chat, { id: 'pr', answers: { 'Publish the release now?': 'Yes' }, tier: 'green', why: 'x' }), /publishing/)

  t.fake.pending = [{ requestId: 'q3', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?' }] } }]
  await t.rpc('follow_answer', t.chat, { id: 'pr', answers: { 'Which colour?': 'Grey' }, tier: 'green', why: 'she said calm colours' })
  const answer = t.sent.find((r) => r.op === 'claude.answer') as { requestId: string; result: { updatedInput: { answers: Record<string, string> } } }
  assert.equal(answer.requestId, 'q3')
  assert.match(answer.result.updatedInput.answers['Which colour?']!, /^Grey \(answered by Hamasa for Ann/)
})

test('one ping when done or needed, none when it only continued, none when they are reading', async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  await t.rpc('follow_reply', t.chat, { id: 'work', text: 'Next step', tier: 'green', why: 'agreed' })
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'Continued the panel session.' } })
  assert.equal(t.notified.length, 0, 'it only continued: silent')

  t.quietChat(t.chat)
  t.set('pr', 'idle', 1)
  await t.follow.deliver(1)
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'The PR is open: #42. Done.' } })
  assert.deepEqual(t.notified.map((n) => [n.kind, n.title, n.body, n.tag]), [['finished', 'Hamasa', 'The PR is open: #42. Done.', 'assistant:1:follow']])

  t.quietChat(t.chat)
  t.set('work', 'error', 1)
  await t.follow.deliver(1)
  t.hub.viewers = () => [{ id: 1, name: 'Ann Lee' }] as never
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'It failed.' } })
  assert.equal(t.notified.length, 1, 'she has the chat open')
})

test("while followed, the session doesn't ping its owner itself; when Hamasa can't follow up, DevDash pings instead", async () => {
  const t = await ready()
  t.emit({ ev: 'claude.permission', id: 'work', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
  assert.equal(t.notified.length, 0)
  assert.match(t.claude.notifyFrom('ann', { sessionId: 'work', args: { message: 'done' } }) as string, /Hamasa is following/)

  // Waking fails: one ping from DevDash, the cursor goes back, the session pings itself again until the retry.
  t.set('work', 'idle', 5)
  t.fake.failSendTo = t.chat
  assert.equal(await t.follow.deliver(1), false)
  assert.deepEqual(t.notified.map((n) => [n.title, n.tag]), [["Hamasa couldn't follow up", 'assistant:1:follow']])
  t.emit({ ev: 'claude.status', id: 'work', status: 'error', detail: 'boom' })
  assert.equal(t.notified.length, 2, 'its own alert is back')
  t.fake.failSendTo = null
  assert.equal(await t.follow.deliver(1), false, 'not before the retry')
  t.tick(11 * 60_000)
  t.quietChat(t.chat)
  assert.equal(await t.follow.deliver(1), true)

  // The wake turn itself fails: the fallback ping again.
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'overloaded' } })
  assert.equal(t.notified.at(-1)!.title, "Hamasa couldn't follow up")
})

test('following only on their word; the supervisor leaves followed sessions to Hamasa', async () => {
  const t = await ready()
  t.session('other')
  await assert.rejects(t.rpc('session_follow', t.chat, { id: 'other', goal: 'x' }), /Only when Ann asks/)
  await t.claude.send(t.ann, t.chat, 'follow the other one', [], [], [], { typed: true })
  assert.match(await t.rpc('session_follow', t.chat, { id: 'other', goal: 'tests green' }) as string, /Following/)
  await assert.rejects(t.rpc('session_follow', t.chat, { id: t.chat, goal: 'x' }), /own conversations/)

  // Autopilot on, the session quiet for an hour after Ann's message: the sweep would nudge it, but Hamasa follows it.
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'idle', 3600)
  t.set('pr', 'idle', 3600)
  t.set('other', 'idle', 3600)
  await t.autopilot.sweep()
  assert.equal(t.sent.filter((r) => r.op === 'claude.complete').length, 0)
  assert.equal(hash('a'), hash('a'))
})

test('after Hamasa told them (waiting_you), the session finishing still wakes it once: report, no automatic reply', async () => {
  const t = await ready()
  t.autopilot.setEnabled(t.ann, true)
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: 'Step 1 is done; shall it go on?' } })
  assert.equal(t.follow.state(t.ann).sessions.find((s) => s.sessionId === 'work')!.state, 'waiting_you')
  // The session carries on and really finishes later.
  t.tick(120_000)
  t.set('work', 'working')
  assert.equal(await t.follow.deliver(1), false)
  t.set('work', 'idle', 0)
  t.quietChat(t.chat)
  assert.equal(await t.follow.deliver(1), true)
  assert.equal(await t.follow.deliver(1), false, 'once')
  assert.match(reminders(t).at(-1)!.text, /Polish the panel[\s\S]*automatic replies are paused until they write: report this/)
  await assert.rejects(t.rpc('follow_reply', t.chat, { id: 'work', text: 'Go on', tier: 'green', why: 'x' }), /told them/)
})

test('a wake-up with nothing new (follow_keep) changes nothing: still on, the same budget, no dot, no ping', async () => {
  const t = await ready()
  t.set('work', 'idle', 5)
  await t.follow.deliver(1)
  await assert.rejects(t.rpc('follow_keep', t.chat, { id: 'pr' }), /just woke you/, 'only for a session in this wake-up')
  assert.match(await t.rpc('follow_keep', t.chat, { id: 'work' }) as string, /Kept following quietly/)
  t.emit({ ev: 'claude.msg', id: t.chat, msg: { type: 'result', subtype: 'success', result: '' } })
  const f = t.follow.state(t.ann).sessions.find((s) => s.sessionId === 'work')!
  assert.deepEqual([f.state, f.replies], ['on', 0])
  assert.equal(t.notified.length, 0)
  assert.equal(t.assistant.state(t.ann).unread, false, 'nothing written, so no dot')
})

test("idle with a helper still running isn't done; the helper finishing is what wakes Hamasa", async () => {
  const t = await ready()
  t.emit({ ev: 'claude.tasks', id: 'work', tasks: [{ id: 'b1', type: 'local_agent', description: 'Write the files' }] })
  t.set('work', 'idle', 5) // the turn ended, its helper still works
  assert.equal(await t.follow.deliver(1), false, 'nothing to tell yet')
  t.tick(60_000)
  t.emit({ ev: 'claude.tasks', id: 'work', tasks: [] }) // the helper finished and wrote the files: no new turn
  t.quietChat(t.chat)
  assert.equal(await t.follow.deliver(1), true)
  assert.match(reminders(t)[0]!.text, /Polish the panel[\s\S]*finished a turn/)
})
