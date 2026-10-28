import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openDb } from '../../core/db.ts'

// The 036 backfill attributes old team-written rows to their role, reversibly. Run its SQL against seeded data (the
// migration itself already ran on the empty db), then its UNDO lines.
const SQL = readFileSync(new URL('../../../migrations/036_backfill_team_authorship.sql', import.meta.url), 'utf8')
const UNDO = SQL.split('\n').filter((l) => l.startsWith('-- undo: ')).map((l) => l.slice('-- undo: '.length))

function seed() {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1)").run()
  db.prepare("insert into team_roles (id, project_id, name) values (1, 1, 'CEO'), (2, 1, 'CEO Ops')").run()
  const task = db.prepare('insert into tasks (project_id, number, title, created_by) values (1, ?, ?, 1)')
  task.run(5, 'Check who owns the Google Cloud project') // id 1, from a proposal
  task.run(15, 'A person wrote this one') // id 2, no proposal (and /tasks/shop/15 must not match 5 or 1)
  const comment = db.prepare('insert into task_comments (task_id, user_id, via_claude, body) values (?, 1, ?, ?)')
  comment.run(2, 1, 'CEO, done.') // id 1 → CEO
  comment.run(2, 1, '**CEO Ops, 2026-10-15: close it.**') // id 2 → longest name wins
  comment.run(2, 0, 'CEO, typed by a person') // id 3: not via Claude → untouched
  comment.run(2, 1, 'ceo, wrong case') // id 4 → untouched
  db.prepare(`insert into team_proposals (project_id, role_id, kind, title, status, outcome, expires_at)
    values (1, 1, 'other', 'Check who owns the Google Cloud project', 'done', 'It''s a task for Ann: [shop#5](/tasks/shop/5).', 0)`).run()
  const act = db.prepare('insert into activity (project_id, user_id, via_claude, kind, summary, url) values (1, 1, ?, ?, ?, ?)')
  act.run(1, 'task.created', 'created shop#5', '/tasks/shop/5') // id 1 → CEO
  act.run(1, 'task.status', 'moved shop#5', '/tasks/shop/5') // id 2: ambiguous kind → untouched
  act.run(1, 'task.created', 'created shop#15', '/tasks/shop/15') // id 3: its task has no role → untouched
  return db
}

const role = (db: ReturnType<typeof seed>, table: string, id: number) =>
  (db.prepare(`select via_role as r from ${table} where id = ?`).get(id) as { r: string | null }).r

test('036 backfills the role on team-written comments, tasks and task-created activity, and its UNDO clears them', () => {
  const db = seed()
  db.exec(SQL)

  assert.equal(role(db, 'task_comments', 1), 'CEO')
  assert.equal(role(db, 'task_comments', 2), 'CEO Ops')
  assert.equal(role(db, 'task_comments', 3), null)
  assert.equal(role(db, 'task_comments', 4), null)
  assert.equal(role(db, 'tasks', 1), 'CEO')
  assert.equal(role(db, 'tasks', 2), null)
  assert.equal(role(db, 'activity', 1), 'CEO')
  assert.equal(role(db, 'activity', 2), null)
  assert.equal(role(db, 'activity', 3), null)

  const counts = Object.fromEntries((db.prepare('select kind, count(*) as n from team_authorship_backfill group by kind').all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]))
  assert.deepEqual(counts, { activity: 1, task: 1, task_comment: 2 })

  // Running it again changes nothing (rows already set are skipped).
  db.exec(SQL)
  assert.equal((db.prepare('select count(*) as n from team_authorship_backfill').get() as { n: number }).n, 4)

  // A row attributed after the deploy (by the live code) survives the undo.
  db.prepare("update task_comments set via_role = 'CTO' where id = 4").run()

  assert.equal(UNDO.length, 4)
  for (const stmt of UNDO) db.exec(stmt)
  assert.equal(role(db, 'task_comments', 1), null)
  assert.equal(role(db, 'task_comments', 2), null)
  assert.equal(role(db, 'tasks', 1), null)
  assert.equal(role(db, 'activity', 1), null)
  assert.equal(role(db, 'task_comments', 4), 'CTO')
  assert.equal(db.prepare("select name from sqlite_master where name = 'team_authorship_backfill'").get(), undefined)
})
