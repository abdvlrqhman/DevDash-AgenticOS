import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import { projectsService } from '../projects/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { claudeService, recipients } from './service.ts'

const team = [{ id: 1, username: 'ann', name: 'Ann Lee' }, { id: 2, username: 'bstone', name: 'Bob Stone' }, { id: 3, username: 'bray', name: 'Bob Ray' }]

test('recipients: whoever asked by default, named members by username or name, or the whole team', () => {
  assert.deepEqual(recipients(undefined, team, team[0]!), [team[0]])
  assert.deepEqual(recipients([], team, team[1]!), [team[1]])
  assert.deepEqual(recipients(['@ANN', 'bob stone', 'bray'], team, team[0]!), [team[0], team[1], team[2]])
  assert.deepEqual(recipients('ann', team, team[1]!), [team[0]], 'a single name as a string')
  assert.deepEqual(recipients('everyone', team, team[0]!), team)
  assert.throws(() => recipients(['bob'], team, team[0]!), /More than one member is called "bob".*ann \(Ann Lee\)/, 'two Bobs: say which')
  assert.throws(() => recipients(['zed'], team, team[0]!), /No member is called "zed"/)
})

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  for (const u of team) add.run(u.id, `${u.username}@x.io`, u.username, u.name)
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('s1', 1, 'Fix login', '/home/ann', 1)").run()
  const agents = { onEvent: () => {}, request: async () => ({ ok: true }) } as unknown as AgentsService
  const hub = createHub()
  const sent: { userId: number; kind: string; title: string; body?: string; url?: string }[] = []
  const notify = async (userId: number, kind: string, n: { title: string; body?: string; url?: string }) => void sent.push({ userId, kind, ...n })
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const projects = projectsService({ db, hub, agents, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  const claude = claudeService({ db, agents, hub, notify, projects })
  const call = (username: string, sessionId: string | null, args: Record<string, unknown>) => claude.notifyFrom(username, { sessionId, args })
  return { db, sent, call }
}

test('notify: the agent says what and to whom; DevDash writes whose agent and where it links', async () => {
  const { db, sent, call } = setup()
  assert.equal(await call('ann', 's1', { message: '  Login fixed:\n 2 tests still flaky ' }), 'Sent to Ann Lee.')
  assert.deepEqual(sent.pop(), { userId: 1, kind: 'finished', title: 'Claude · Fix login', body: 'Login fixed: 2 tests still flaky', url: '/sessions/s1', tag: 'agent:s1' })
  await assert.rejects(Promise.resolve().then(() => call('ann', 's1', { message: 'again' })), /put everything in one/, 'one per 30 seconds per session')

  // A teammate sent the last message: by default it's theirs. Bob can't see this private session: no title, no session link.
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('s2', 1, 'Secret plan', '/home/ann', 1)").run()
  db.prepare("insert into claude_message_senders (session_id, message_uuid, user_id) values ('s2', 'm1', 2)").run()
  assert.equal(await call('ann', 's2', { message: 'Your build is ready' }), 'Sent to Bob Stone.')
  assert.deepEqual(sent.pop(), { userId: 2, kind: 'finished', title: "Ann's Claude", body: 'Your build is ready', url: '/', tag: 'agent:s2' })

  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('s3', 1, 'Deploy', '/home/ann', 1)").run()
  await call('ann', 's3', { message: 'Main is broken, hold merges', to: 'everyone', link: '/tasks/shop/12' })
  assert.deepEqual(sent.map((n) => [n.userId, n.url]).sort(), [[1, '/tasks/shop/12'], [2, '/tasks/shop/12'], [3, '/tasks/shop/12']])

  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started) values ('s4', 1, 'Other', '/home/ann', 1)").run()
  await assert.rejects(Promise.resolve().then(() => call('bob', 's4', { message: 'x' })), /Only a DevDash session/, "not someone else's session")
  await assert.rejects(Promise.resolve().then(() => call('ann', 's4', { message: ' ' })), /Give the message/)
  await assert.rejects(Promise.resolve().then(() => call('ann', 's4', { message: 'x', link: 'https://evil.example' })), /DevDash path/)

  // A teammate chatted, then the owner went on in the terminal: it's the owner's. A feature's own session sends nothing.
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started, mode) values ('s5', 1, 'Term', '/home/ann', 1, 'cli')").run()
  db.prepare("insert into claude_message_senders (session_id, message_uuid, user_id) values ('s5', 'm2', 2)").run()
  assert.equal(await call('ann', 's5', { message: 'Done' }), 'Sent to Ann Lee.')
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, started, listed) values ('s6', 1, 'Role', '/home/ann', 1, 0)").run()
  assert.match(String(await call('ann', 's6', { message: 'x' })), /^Not sent/)
})
