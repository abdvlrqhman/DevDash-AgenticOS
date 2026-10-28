import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import { searchService } from '../search/service.ts'
import { closedNumbers, tasksService } from './service.ts'

test('closedNumbers finds every fixes/closes/resolves #N once', () => {
  assert.deepEqual(closedNumbers('Fix login. Fixes #12, closes #3\n\nresolved #12 and see #4'), [12, 3])
  assert.deepEqual(closedNumbers('prefix#5 and fixes#6 and fixes #x'), [])
})

test('commits move tasks: branch → review, default branch → done, each commit once', () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'Ann', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1)").run()
  const hub = createHub()
  const tasks = tasksService({ db, hub, activity: activityService({ db, hub }), search: searchService({ db }) })
  const me = { user: { id: 1, name: 'Ann' } }

  const t = tasks.create(me, { project: 'app', title: 'Login breaks on Safari' })
  assert.equal(t.key, 'app#1')
  assert.equal(tasks.create(me, { project: 'app', title: 'Second' }).number, 2)

  const commit = { sha: 'a'.repeat(40), email: 'a@x.io', subject: 'Fix Safari login, fixes #1', body: '' }
  tasks.fromCommits({ id: 1, slug: 'app' }, [commit], { onDefault: false, branch: 'dd/abc' })
  assert.equal(tasks.get('app', 1).status, 'review')

  tasks.update(me, 'app', 1, { status: 'in_progress' })
  tasks.fromCommits({ id: 1, slug: 'app' }, [commit], { onDefault: false, branch: 'dd/abc' }) // same commit again: no effect
  assert.equal(tasks.get('app', 1).status, 'in_progress')

  tasks.fromCommits({ id: 1, slug: 'app' }, [{ ...commit, sha: 'b'.repeat(40) }], { onDefault: true, branch: 'origin/main' })
  const done = tasks.get('app', 1)
  assert.equal(done.status, 'done')
  assert.ok(done.closedAt)
  assert.equal(done.links.filter((l) => l.kind === 'commit').length, 2)
  assert.equal(tasks.get('app', 2).status, 'todo')
})

test('a team role is shown as the author of what it creates, not the account it runs on', () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'Omar Haddad', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1)").run()
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  // The CEO role, running on Omar's account, creates a task and comments on it.
  const ceo = { user: { id: 1, name: 'Omar Haddad' }, viaClaude: true, role: 'CEO' }
  const t = tasks.create(ceo, { project: 'shop', title: 'Recruit testers' })
  assert.equal(t.creatorRole, 'CEO', 'the task is attributed to the role')
  tasks.comment(ceo, 'shop', t.number, 'Posted the recruiting message.')
  const full = tasks.get('shop', t.number)
  assert.equal(full.comments[0]!.role, 'CEO')
  assert.equal(full.comments[0]!.viaClaude, true)
  // The activity feed carries the role too, so "Omar Haddad" isn't shown as the author.
  assert.equal(activity.list(1).find((a) => a.kind === 'task.created')!.role, 'CEO')

  // A person's own action has no role and stays the person.
  const t2 = tasks.create({ user: { id: 1, name: 'Omar Haddad' } }, { project: 'shop', title: 'By hand' })
  assert.equal(t2.creatorRole, null)
})

test('a commit first seen on a branch still closes the task when it reaches the default branch (fast-forward)', () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'Ann', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1)").run()
  const hub = createHub()
  const tasks = tasksService({ db, hub, activity: activityService({ db, hub }), search: searchService({ db }) })
  tasks.create({ user: { id: 1, name: 'Ann' } }, { project: 'app', title: 'X' })
  const commit = { sha: 'c'.repeat(40), email: 'nobody@x.io', subject: 'closes #1', body: '' }
  tasks.fromCommits({ id: 1, slug: 'app' }, [commit], { onDefault: false, branch: 'feature' })
  assert.equal(tasks.get('app', 1).status, 'review')
  tasks.fromCommits({ id: 1, slug: 'app' }, [commit], { onDefault: true, branch: 'main' })
  assert.equal(tasks.get('app', 1).status, 'done')
})
