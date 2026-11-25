import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import { projectsService } from '../projects/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { registerMcp } from './rpc.ts'

test('task_create: for nobody, one member (username, name, first name or "me"), or everyone: a task each', async () => {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann Lee')
  add.run(2, 'b@x.io', 'bob', 'Bob Stone')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1)").run()
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  const agents = { onEvent: () => {}, onRpc: (m: string, fn: (u: string, p: unknown) => unknown) => void rpcs.set(m, fn), request: async () => ({}) } as unknown as AgentsService
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const projects = projectsService({ db, hub, agents, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  registerMcp({ db, agents, projects, tasks, notes: {} as never, services: {} as never })
  const create = (assignee?: string) => rpcs.get('mcp.task_create')!('ann', { sessionId: null, cwd: '/', args: { project: 'shop', title: 'Set up 2FA', ...(assignee ? { assignee } : {}) } }) as { assignee: string | null } | { assignee: string | null }[]

  assert.equal((create() as { assignee: string | null }).assignee, null)
  assert.equal((create('bob') as { assignee: string | null }).assignee, 'Bob Stone')
  assert.equal((create('Bob Stone') as { assignee: string | null }).assignee, 'Bob Stone')
  assert.equal((create('me') as { assignee: string | null }).assignee, 'Ann Lee')
  const all = create('everyone') as { assignee: string | null }[]
  assert.deepEqual(all.map((t) => t.assignee), ['Ann Lee', 'Bob Stone'], 'one task each')
  assert.throws(() => create('zed'), /No one on the team is "zed".*ann \(Ann Lee\)/)
})
