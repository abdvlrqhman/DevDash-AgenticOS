import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { notificationsService } from './service.ts'

test('notifications follow each member’s preferences', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'A', 'x', 'x', 'admin')").run()
  const hub = createHub()
  const sent: unknown[] = []
  hub.publish = (_t, payload) => void sent.push(payload)
  const n = notificationsService({ db, hub, dataDir: mkdtempSync(join(tmpdir(), 'dd-')), origin: 'https://dev.example.com' })

  assert.deepEqual(n.prefs(1), { needs_you: true, finished: true, errors: true, shared: false })
  await n.notify(1, 'shared', { title: 'off by default' })
  assert.equal(sent.length, 0)

  await n.notify(1, 'finished', { title: 'Claude finished: x', url: '/claude/x' })
  assert.equal(sent.length, 1)
  assert.equal(n.list(1).unread, 1)

  n.savePrefs(1, { needs_you: true, finished: false, errors: true, shared: true })
  await n.notify(1, 'finished', { title: 'muted' })
  assert.equal(sent.length, 1)
  await n.notify(1, 'finished', { title: 'test ignores prefs' }, true)
  assert.equal(sent.length, 2)

  n.readAll(1)
  assert.equal(n.list(1).unread, 0)
})

test('the native app’s stream gets what Web Push would, and what it missed while reconnecting', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'A', 'x', 'x', 'admin')").run()
  const hub = createHub()
  hub.publish = () => {}
  let active = false
  hub.isActive = () => active
  const n = notificationsService({ db, hub, dataDir: mkdtempSync(join(tmpdir(), 'dd-')), origin: 'https://dev.example.com' })

  const got: { id: number; title: string }[] = []
  const sub = n.listen(1, 0, (e) => got.push(e))
  assert.deepEqual(sub.missed, [], 'a first connection replays nothing')
  await n.notify(1, 'needs_you', { title: 'Claude needs you: x', url: '/claude/x' })
  assert.deepEqual(got.map((e) => e.title), ['Claude needs you: x'])

  active = true // using DevDash somewhere: it shows inside the app instead
  await n.notify(1, 'finished', { title: 'shown in the app' })
  assert.equal(got.length, 1)
  active = false

  sub.stop()
  await n.notify(1, 'finished', { title: 'while reconnecting' })
  assert.equal(got.length, 1, 'nothing after unsubscribing')
  const again = n.listen(1, got[0]!.id, () => {})
  assert.deepEqual(again.missed.map((e) => e.title), ['while reconnecting'], 'missed pushes only, not what showed inside the app')
  again.stop()
})
