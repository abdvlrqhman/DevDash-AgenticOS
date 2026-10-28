import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { avatarsService, MAX_AVATAR_BYTES, sniff } from './avatars.ts'
import { membersRoutes } from './routes.ts'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)])

function setup() {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann', 'x', 'x', 'member')").run()
  return avatarsService({ db, hub: createHub() })
}

test('a picture is judged by its bytes: JPEG, PNG and WebP pass; SVG, HTML and a renamed file do not', () => {
  assert.equal(sniff(JPEG), 'image/jpeg')
  assert.equal(sniff(PNG), 'image/png')
  assert.equal(sniff(WEBP), 'image/webp')
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null)
  assert.equal(sniff(Buffer.from('<!doctype html><script>alert(1)</script>')), null)
  assert.equal(sniff(Buffer.from('RIFF....AVI LIST')), null)
})

test('a member sets, replaces and removes their picture; the version changes every time', () => {
  const avatars = setup()
  assert.equal(avatars.versions().size, 0)
  const first = avatars.set(1, JPEG).avatarAt
  assert.deepEqual([...avatars.versions()], [[1, first]])
  assert.deepEqual(avatars.get(1), { mime: 'image/jpeg', data: JPEG, updatedAt: first })
  const second = avatars.set(1, PNG).avatarAt // even within the same second, a new address
  assert.ok(second > first)
  assert.equal(avatars.get(1).mime, 'image/png')
  assert.throws(() => avatars.set(1, Buffer.from('<svg/>')), /JPEG, PNG or WebP/)
  assert.throws(() => avatars.set(1, Buffer.concat([JPEG, Buffer.alloc(MAX_AVATAR_BYTES)])), /too big/)
  assert.deepEqual(avatars.remove(1), { avatarAt: null })
  assert.throws(() => avatars.get(1), (e: unknown) => e instanceof AppError && e.status === 404)
})

test('through the API: upload your own picture, everyone sees who has one, and it is served as an image only', async () => {
  const avatars = setup()
  const me = { id: 1, name: 'Ann', username: 'ann', email: '', role: 'member' as const }
  const mw = {
    requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('user', me); await next() },
    requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
  } as unknown as Parameters<typeof membersRoutes>[1]
  const auth = { members: () => ({ users: [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }], invites: [] }) } as unknown as Parameters<typeof membersRoutes>[0]
  const app = new Hono().route('/m', membersRoutes(auth, mw, () => '1.2.3.4', 'https://x', () => {}, avatars))
  app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof AppError ? err.status : 500))

  const put = await app.request('/m/me/avatar', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: WEBP })
  assert.equal(put.status, 200)
  const list = await (await app.request('/m')).json() as { users: { id: number; avatarAt: number | null }[] }
  assert.deepEqual(list.users.map((u) => [u.id, typeof u.avatarAt]), [[1, 'number'], [2, 'object']])

  const img = await app.request('/m/1/avatar')
  assert.equal(img.headers.get('content-type'), 'image/webp') // what the bytes are, not what the upload claimed
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
  assert.match(img.headers.get('cache-control')!, /immutable/)
  assert.match(img.headers.get('content-security-policy')!, /default-src 'none'; sandbox/)
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), WEBP)
  assert.equal((await app.request('/m/2/avatar')).status, 404)

  const big = await app.request('/m/me/avatar', { method: 'PUT', headers: { 'content-length': String(MAX_AVATAR_BYTES + 1) }, body: JPEG })
  assert.equal(big.status, 400)
  assert.equal((await app.request('/m/me/avatar', { method: 'DELETE' })).status, 200)
  assert.equal((await app.request('/m/1/avatar')).status, 404)
})
