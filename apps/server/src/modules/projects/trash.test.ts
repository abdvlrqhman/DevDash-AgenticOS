import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { notesService } from '../notes/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { projectsService } from './service.ts'
import { KEEP_MS, projectTrash } from './trash.ts'

const ROOT = '/srv/devdash'

/** A project "app" added by Ann, with a task, a note, a running and an idle session, and a service in a worktree. */
function setup() {
  const db = openDb(':memory:')
  const user = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
  user.run(1, 'a@x.io', 'ann', 'Ann Lee', 'member')
  user.run(2, 'b@x.io', 'bob', 'Bob Day', 'member')
  user.run(3, 'c@x.io', 'cat', 'Cat Admin', 'admin')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1), (2, 'site', 'Site', 2)").run()
  const session = db.prepare("insert into claude_sessions (id, owner_id, title, cwd, status, project_id, mode) values (?, ?, ?, ?, ?, ?, 'chat')")
  session.run('s1', 1, 'Working one', `${ROOT}/projects/app`, 'working', 1)
  session.run('s2', 2, 'Idle one', `${ROOT}/worktrees/app/abc`, 'idle', null) // in a worktree, not linked: still the project's
  session.run('s3', 2, 'Elsewhere', `${ROOT}/projects/site`, 'working', 2)
  const hub = createHub()
  const activity = activityService({ db, hub })
  const search = searchService({ db })
  const tasks = tasksService({ db, hub, activity, search })
  const notes = notesService({ db, hub, activity, search })
  const projects = projectsService({ db, hub, agents: {} as AgentsService, activity, tasks, gitSafeDir: async () => {}, root: ROOT })
  const u = (id: number) => db.prepare('select id, username, name, email, role from users where id = ?').get(id) as unknown as User
  const ann = u(1), bob = u(2), cat = u(3)
  tasks.create({ user: ann }, { project: 'app', title: 'Ship it' })
  notes.create({ user: ann }, { project: 'app', title: 'How we deploy', body: 'carefully' })

  const calls: string[] = []
  const svc = [{ name: 'app-web', cwd: `${ROOT}/worktrees/app/abc`, owner: 'Bob Day' }, { name: 'site-web', cwd: `${ROOT}/projects/site`, owner: 'Bob Day' }]
  const trash = projectTrash({
    db, projects, activity, search, root: ROOT,
    claude: {
      inProjectFolders: (id, folders) => (db.prepare(`select s.id, s.title, s.status, s.mode, s.cwd, s.worktree, s.project_id, u.username as owner_username, u.name as owner_name
        from claude_sessions s join users u on u.id = s.owner_id where s.archived = 0`).all() as { id: string; title: string; status: string; mode: string; cwd: string; worktree: string | null; project_id: number | null; owner_username: string; owner_name: string }[])
        .filter((s) => s.project_id === id || folders.some((f) => s.cwd === f || s.cwd.startsWith(`${f}/`))),
      stopAndArchive: async (list) => { for (const s of list) { calls.push(`stop ${s.id}`); db.prepare('update claude_sessions set archived = 1 where id = ?').run(s.id) } },
    },
    services: {
      inFolders: (folders) => svc.filter((s) => folders.some((f) => s.cwd === f || s.cwd.startsWith(`${f}/`))).map((s) => ({ ...s, ownerUsername: 'bob', state: 'running' as const, desired: 'running' as const })),
      removeForProject: async (name) => { calls.push(`remove ${name}`); svc.splice(svc.findIndex((s) => s.name === name), 1) },
    },
    agents: { request: (async (_u: string, msg: { op: string }) => {
      if (msg.op !== 'git.risks') throw new Error('unexpected')
      return { changes: 2, worktrees: [{ path: `${ROOT}/worktrees/app/abc`, branch: 'dd/abc', changes: 1 }], remote: false, unpushed: null }
    }) as AgentsService['request'] },
    folders: {
      trash: async (id, slug) => { calls.push(`trash ${id}-${slug}`) },
      restore: async (id, slug) => { calls.push(`restore ${id}-${slug}`) },
      purge: async (id, slug) => { calls.push(`purge ${id}-${slug}`) },
    },
  })
  return { db, projects, tasks, notes, trash, calls, ann, bob, cat }
}

const code = (fn: () => unknown) => async () => {
  try { await fn() } catch (err) { return (err as { code?: string }).code }
  return 'ok'
}

test('only whoever added a project deletes it; an admin only once that account is disabled; enforced on the server', async () => {
  const { db, trash, calls, ann, bob, cat } = setup()
  assert.equal(await code(() => trash.check(bob, 'app'))(), 'forbidden')
  assert.equal(await code(() => trash.remove(bob, 'app', 'app'))(), 'forbidden')
  assert.equal(await code(() => trash.remove(cat, 'app', 'app'))(), 'forbidden', 'an admin cannot while Ann is active')
  assert.deepEqual(calls, [])
  assert.equal(await code(() => trash.check(ann, 'app'))(), 'ok')

  db.prepare('update users set disabled_at = unixepoch() where id = 1').run()
  assert.equal(await code(() => trash.check(cat, 'app'))(), 'ok', 'an admin can once Ann is disabled')
  assert.equal(await code(() => trash.check(bob, 'app'))(), 'forbidden', 'a member still cannot')
})

test('the dialog check lists what is at risk, live', async () => {
  const { trash, ann } = setup()
  const c = await trash.check(ann, 'app')
  assert.equal(c.repoUrl, null, 'no GitHub copy')
  assert.equal(c.git.changes, 2)
  assert.deepEqual(c.git.worktrees.map((w) => w.changes), [1])
  assert.deepEqual(c.sessions.live.map((s) => s.title), ['Working one'])
  assert.equal(c.sessions.total, 2)
  assert.deepEqual(c.services.map((s) => s.name), ['app-web'])
  assert.equal(c.openTasks, 1)
  assert.equal(c.notes, 1)
})

test('deleting needs the short name typed; then it stops sessions, removes services, moves the folders and hides the project', async () => {
  const { db, projects, tasks, notes, trash, calls, ann, bob } = setup()
  for (const confirm of ['', 'App', 'ap', 'site', 'app2']) {
    assert.equal(await code(() => trash.remove(ann, 'app', confirm))(), 'confirm', confirm)
  }
  assert.deepEqual(calls, [], 'a wrong name changes nothing')

  await trash.remove(ann, 'app', ' app ')
  assert.deepEqual(calls, ['stop s1', 'stop s2', 'remove app-web', 'trash 1-app'])
  assert.equal((db.prepare("select archived from claude_sessions where id = 's3'").get() as { archived: number }).archived, 0, 'other projects untouched')

  // Hidden everywhere: lists, the project page, folders, tasks, notes. The short name stays taken.
  assert.deepEqual(projects.list(false, 1).map((p) => p.slug), ['site'])
  assert.deepEqual(projects.list(true, 1).map((p) => p.slug), [], 'not under archived either')
  assert.equal(await code(() => projects.get('app', 1))(), 'not_found')
  assert.equal(projects.forPath(`${ROOT}/projects/app/src`), null)
  assert.deepEqual(tasks.list({}).map((t) => t.title), [])
  assert.equal(await code(() => tasks.get('app', 1))(), 'not_found')
  assert.deepEqual(notes.list(ann).map((n) => n.title), [])
  assert.equal(await code(() => projects.create(ann, { name: 'App', slug: 'app' }))(), 'taken')
  assert.equal(await code(() => trash.remove(ann, 'app', 'app'))(), 'not_found', 'deleting twice')

  // Recently deleted: only for whoever may restore it.
  assert.deepEqual(trash.deleted(ann).map((p) => p.slug), ['app'])
  assert.deepEqual(trash.deleted(bob).map((p) => p.slug), [])
  const [d] = trash.deleted(ann)
  assert.equal(d!.purgeAt - d!.deletedAt, 7 * 86400)
})

test('restore brings the folders and the project back as it was; sessions stay archived', async () => {
  const { db, projects, trash, calls, ann, bob } = setup()
  db.prepare('update projects set archived = 1 where id = 1').run()
  await trash.remove(ann, 'app', 'app')
  assert.equal(await code(() => trash.restore(bob, 'app'))(), 'forbidden')
  const p = await trash.restore(ann, 'app')
  assert.equal(p.slug, 'app')
  assert.equal(p.archived, true, 'it was archived before, so it is again')
  assert.equal(calls.at(-1), 'restore 1-app')
  assert.deepEqual(trash.deleted(ann), [])
  assert.equal((db.prepare("select archived from claude_sessions where id = 's1'").get() as { archived: number }).archived, 1)
  assert.equal(await code(() => trash.restore(ann, 'app'))(), 'not_found', 'nothing left to restore')
  assert.equal(projects.get('app', 1).name, 'App')
})

test('delete forever needs the name again and purges folders, row, tasks and notes; sessions keep their history', async () => {
  const { db, trash, calls, ann, bob } = setup()
  await trash.remove(ann, 'app', 'app')
  assert.equal(await code(() => trash.purge(bob, 'app', 'app'))(), 'forbidden')
  assert.equal(await code(() => trash.purge(ann, 'app', 'nope'))(), 'confirm')
  assert.ok(!calls.includes('purge 1-app'))
  await trash.purge(ann, 'app', 'app')
  assert.equal(calls.at(-1), 'purge 1-app')
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  assert.equal(n("select count(*) as n from projects where slug = 'app'"), 0)
  assert.equal(n('select count(*) as n from tasks where project_id = 1'), 0)
  assert.equal(n("select count(*) as n from notes where title = 'How we deploy'"), 0)
  assert.equal(n("select count(*) as n from claude_sessions where id = 's1' and project_id is null"), 1)
  assert.equal(n("select count(*) as n from activity where kind = 'project.purged'"), 1)
  assert.equal(n("select count(*) as n from search where kind = 'note'"), 0)
})

test('the janitor purges a deleted project after seven days, not before', async () => {
  const { db, trash, calls, ann } = setup()
  await trash.remove(ann, 'app', 'app')
  const at = (db.prepare("select deleted_at from projects where slug = 'app'").get() as { deleted_at: number }).deleted_at * 1000
  await trash.sweep(at + KEEP_MS - 60_000)
  assert.ok(!calls.includes('purge 1-app'))
  await trash.sweep(at + KEEP_MS + 1)
  assert.equal(calls.at(-1), 'purge 1-app')
  assert.equal((db.prepare("select count(*) as n from projects where slug = 'app'").get() as { n: number }).n, 0)
})
