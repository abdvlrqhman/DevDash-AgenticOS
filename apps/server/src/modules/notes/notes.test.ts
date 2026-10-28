import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import { searchService } from '../search/service.ts'
import { notesService } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1)").run()
  const hub = createHub()
  const notes = notesService({ db, hub, activity: activityService({ db, hub }), search: searchService({ db }) })
  return { notes, user: { id: 1, name: 'Ann' } }
}

test("a role's new weekly summary supersedes its previous one, with a link back", () => {
  const { notes, user } = setup()
  const ceo = { user, viaClaude: true, role: 'CEO' }
  const w1 = notes.create(ceo, { project: 'shop', title: 'Weekly summary, week of 10-05' })
  assert.equal(w1.status, 'confirmed')
  const w2 = notes.create(ceo, { project: 'shop', title: 'Weekly summary, week of 10-12' })
  const prev = notes.get(user, w1.id)
  assert.equal(prev.status, 'superseded')
  assert.equal(prev.supersededBy, w2.id)
  assert.equal(notes.get(user, w2.id).status, 'confirmed')

  // Another role's weekly summary leaves the CEO's current one alone.
  const cto = { user, viaClaude: true, role: 'CTO' }
  notes.create(cto, { project: 'shop', title: 'Weekly summary, week of 10-12' })
  assert.equal(notes.get(user, w2.id).status, 'confirmed')

  // Setting a superseded note back to confirmed clears the link.
  const back = notes.update(ceo, w1.id, { status: 'confirmed' })
  assert.equal(back.status, 'confirmed')
  assert.equal(back.supersededBy, null)

  // A one-off note (not a weekly summary) is never auto-superseded.
  const other = notes.create(ceo, { project: 'shop', title: 'Product list 10-13' })
  notes.create(ceo, { project: 'shop', title: 'Weekly summary, week of 10-19' })
  assert.equal(notes.get(user, other.id).status, 'confirmed')
})
