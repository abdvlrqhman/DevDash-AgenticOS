import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { User } from '../auth/repo.ts'
import { MAX_PINS, pinsService, type Resolved } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  const pins = pinsService({ db, hub: createHub() })
  // What exists, and who may see it: Ann can't see the private "secret" session.
  const visible = { project: new Set(['app', 'site']), session: new Set(['s1', 'secret']), task: new Set(['app/1']) }
  let hide = new Set<string>()
  const resolver = (kind: keyof typeof visible) => (u: User, refs: string[]) =>
    new Map(refs.filter((r) => visible[kind].has(r) && !hide.has(r) && !(r === 'secret' && u.id === 1))
      .map((r) => [r, { title: `${kind} ${r}`, url: `/${kind}/${r}`, state: kind === 'session' ? 'working' : null } satisfies Resolved] as const))
  pins.register('project', resolver('project'))
  pins.register('session', resolver('session'))
  pins.register('task', resolver('task'))
  pins.register('note', () => { throw new Error('notes are down') })
  const user = (id: number, name: string): User => ({ id, name, username: name.toLowerCase(), email: '', role: 'member' })
  return { pins, ann: user(1, 'Ann'), bob: user(2, 'Bob'), setHidden: (h: string[]) => { hide = new Set(h) } }
}

const refs = (list: { kind: string; ref: string }[]) => list.map((p) => `${p.kind}:${p.ref}`)

test('each member pins what they can see, in their own order; others have their own pins', () => {
  const { pins, ann, bob } = setup()
  pins.pin(ann, 'project', 'app')
  pins.pin(ann, 'session', 's1')
  const list = pins.pin(ann, 'task', 'app/1')
  assert.deepEqual(refs(list), ['project:app', 'session:s1', 'task:app/1'])
  assert.deepEqual(list[1], { kind: 'session', ref: 's1', title: 'session s1', url: '/session/s1', state: 'working' })
  assert.deepEqual(refs(pins.pin(ann, 'project', 'app')), ['project:app', 'session:s1', 'task:app/1']) // twice is fine
  assert.deepEqual(pins.list(bob), [])

  assert.throws(() => pins.pin(ann, 'session', 'secret'), /can't see/) // not hers to see
  assert.throws(() => pins.pin(ann, 'project', 'gone'), /doesn't exist/)
  assert.throws(() => pins.pin(ann, 'note', '7'), /doesn't exist/) // a failing module refuses, it doesn't crash
  assert.deepEqual(refs(pins.pin(bob, 'session', 'secret')), ['session:secret'])

  assert.deepEqual(refs(pins.unpin(ann, 'session', 's1')), ['project:app', 'task:app/1'])
})

test('dragging reorders; pins hidden for now keep their place behind, and come back when visible again', () => {
  const { pins, ann, setHidden } = setup()
  for (const [k, r] of [['project', 'app'], ['project', 'site'], ['task', 'app/1']] as const) pins.pin(ann, k, r)
  setHidden(['site']) // e.g. a session someone stopped sharing: not shown, not lost
  assert.deepEqual(refs(pins.list(ann)), ['project:app', 'task:app/1'])
  // The sidebar only knows the two it shows; a stranger's pin in the list is ignored.
  const moved = pins.reorder(ann, [{ kind: 'task', ref: 'app/1' }, { kind: 'project', ref: 'app' }, { kind: 'session', ref: 'nope' }])
  assert.deepEqual(refs(moved), ['task:app/1', 'project:app'])
  setHidden([])
  assert.deepEqual(refs(pins.list(ann)), ['task:app/1', 'project:app', 'project:site'])
})

test(`a member can pin up to ${MAX_PINS} things`, () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann', 'x', 'x', 'member')").run()
  const pins = pinsService({ db, hub: createHub() })
  pins.register('project', (_u, r) => new Map(r.map((x) => [x, { title: x, url: `/p/${x}` }] as const)))
  const ann: User = { id: 1, name: 'Ann', username: 'ann', email: '', role: 'member' }
  for (let i = 0; i < MAX_PINS; i++) pins.pin(ann, 'project', `p${i}`)
  assert.throws(() => pins.pin(ann, 'project', 'one-more'), /up to 30/)
  assert.equal(pins.list(ann).length, MAX_PINS)
})
