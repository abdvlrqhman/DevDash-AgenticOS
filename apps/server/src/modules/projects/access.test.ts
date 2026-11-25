import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { canSeeSql } from '../claude/repo.ts'
import { notesService } from '../notes/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { projectAccess } from './access.ts'
import { projectsService } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'admin')")
  add.run(1, 'a@x.io', 'ann', 'Ann Lee')
  add.run(2, 'b@x.io', 'bob', 'Bob Day')
  add.run(3, 'c@x.io', 'cat', 'Cat Ng')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'icetv', 'IceTV', 1), (2, 'shop', 'Shop', 2)").run()
  const hub = createHub()
  const access = projectAccess(db)
  const activity = activityService({ db, hub })
  const search = searchService({ db })
  const tasks = tasksService({ db, hub, activity, search, access })
  const notes = notesService({ db, hub, activity, search, access })
  const locks: unknown[] = []
  const projects = projectsService({ db, hub, agents: {} as AgentsService, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash', access, lockFolders: async (p) => void locks.push(p) })
  const u = (id: number) => db.prepare('select * from users where id = ?').get(id) as unknown as User
  return { db, access, tasks, notes, projects, locks, ann: u(1), bob: u(2), cat: u(3) }
}

test("a private project doesn't exist for anyone it isn't shared with: lists, pages, tasks, notes, sessions", async () => {
  const { db, access, tasks, notes, projects, locks, ann, bob, cat } = setup()
  tasks.create({ user: ann }, { project: 'icetv', title: 'Episode 2' })
  notes.create({ user: ann }, { title: 'Voice notes', project: 'icetv' })
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, project_id) values ('s1', 1, 'Render', '/srv/devdash/projects/icetv', 1, 1)").run()
  const seesSession = (userId: number) => !!db.prepare(`select 1 from claude_sessions s where s.id = 's1' and ${canSeeSql('?1')}`).get(userId)
  assert.ok(seesSession(2), 'a team project: its shared session is everyone\'s')

  await projects.setAccess(ann, 'icetv', { visibility: 'private', members: [3] })
  assert.deepEqual(locks.at(-1), { id: 1, slug: 'icetv', owner: 'ann', users: ['cat'] }, 'its folders lock to Ann and Cat')
  for (const [who, sees] of [[ann, true], [cat, true], [bob, false]] as const) {
    assert.equal(projects.list(false, who.id).some((p) => p.slug === 'icetv'), sees, `${who.username}: list`)
    assert.equal(tasks.list({ viewer: who.id }).some((t) => t.project.slug === 'icetv'), sees, `${who.username}: tasks`)
    assert.equal(notes.list(who).some((n) => n.title === 'Voice notes'), sees, `${who.username}: notes`)
    assert.equal(seesSession(who.id), sees, `${who.username}: its shared session`)
  }
  assert.throws(() => projects.get('icetv', bob.id), /There is no project icetv/, 'reads exactly like a missing one')
  assert.throws(() => tasks.create({ user: bob }, { project: 'icetv', title: 'x' }), /There is no project icetv/)
  assert.deepEqual(access.audience(1), [1, 3], 'its notifications go to Ann and Cat only')
  assert.deepEqual(access.audience(2), [1, 2, 3], 'a team project: everyone')
  assert.equal(projects.get('icetv', ann.id).members.map((m) => m.name).join(), 'Cat Ng')

  // A session in it shared with Bob by name: he sees that session, and so the project; nothing else changes for Cat.
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, project_id) values ('s9', 1, 'Thumbnail', '/srv/devdash/projects/icetv', 1)").run()
  db.prepare("insert into claude_session_viewers (session_id, user_id) values ('s9', 2)").run()
  assert.ok(projects.list(false, bob.id).some((p) => p.slug === 'icetv'), 'shared one of its sessions by name')
  assert.ok(db.prepare(`select 1 from claude_sessions s where s.id = 's9' and ${canSeeSql('?1')}`).get(bob.id))
  db.prepare("delete from claude_session_viewers where session_id = 's9'").run()

  await projects.setAccess(ann, 'icetv', { visibility: 'team' })
  assert.deepEqual(locks.at(-1), { id: 1, slug: 'icetv', owner: 'ann', users: null })
  assert.ok(projects.list(false, bob.id).some((p) => p.slug === 'icetv'), 'back on the team')
})

test('only its creator decides; going private is refused while someone it would hide from still works in it', async () => {
  const { db, projects, ann, bob } = setup()
  await assert.rejects(projects.setAccess(bob, 'icetv', { visibility: 'private' }), /Only the person who added the project/)
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, project_id) values ('s2', 2, 'Bob works here', '/srv/devdash/projects/icetv', 1)").run()
  await assert.rejects(projects.setAccess(ann, 'icetv', { visibility: 'private' }), /Bob Day still has sessions or services in it/)
  await projects.setAccess(ann, 'icetv', { visibility: 'private', members: [2] }) // shared with Bob: fine
  await assert.rejects(projects.setAccess(ann, 'icetv', { visibility: 'private', members: [99] }), /No such member/)
})
