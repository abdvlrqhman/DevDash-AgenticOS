import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { openDb } from '../../core/db.ts'
import { letDevDashFrame, servicePages } from './service.ts'

test('services site: members or public only, routed by path, DevDash untouched', async () => {
  // A stand-in service that reports what it received.
  const upstream = createServer((req, res) => {
    if (req.url === '/go-home') return void res.writeHead(302, { location: '/home' }).end()
    if (req.url === '/strict') return void res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }).end('no framing')
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'text/plain' })
    res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, prefix: req.headers['x-forwarded-prefix'] }))
  })
  await new Promise<void>((r) => upstream.listen(20990, '127.0.0.1', () => r()))
  try {
    const db = openDb(':memory:')
    db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'A', 'x', 'x', 'member')").run()
    db.prepare("insert into services (name, owner_id, cwd, command, port, public) values ('shop', 1, '/tmp', 'x', 20990, 0), ('demo', 1, '/tmp', 'x', 20991, 1)").run()
    const auth = { sessionUser: (t?: string) => (t === 'member-token' ? { user: { id: 1 } } : null) }
    const pages = servicePages({ db, auth: auth as never, origin: 'https://dev.example.com', port: 8443 })
    const app = new Hono().use('*', pages.middleware).get('*', (c) => c.text('devdash'))
    const get = (path: string, headers: Record<string, string> = {}) => app.request(`https://dev.example.com:8443${path}`, { headers: { 'x-devdash-services': '1', ...headers } })

    assert.equal(await (await app.request('https://dev.example.com/service/shop/')).text(), 'devdash', 'without the services mark it is DevDash')
    assert.equal(pages.urlOf('shop'), 'https://dev.example.com:8443/service/shop/')
    assert.equal((await get('/service/shop')).headers.get('location'), '/service/shop/')
    assert.equal((await get('/service/shop/')).status, 401, 'members only')
    assert.equal((await get('/service/nope/')).status, 404)

    const page = await get('/service/shop/', { cookie: '__Host-devdash=member-token; app=1' })
    assert.equal(page.status, 200)
    assert.deepEqual(await page.json(), { url: '/', cookie: 'app=1', prefix: '/service/shop' }, "DevDash's cookie never reaches the service")
    assert.match(page.headers.get('set-cookie') ?? '', /^dd_svc=shop;/)

    const asset = await get('/assets/app.js', { cookie: '__Host-devdash=member-token', referer: 'https://dev.example.com:8443/service/shop/' })
    assert.equal(((await asset.json()) as { url: string }).url, '/assets/app.js', 'absolute paths go to the page’s service')
    assert.equal((await get('/service/shop/go-home', { cookie: '__Host-devdash=member-token' })).headers.get('location'), '/service/shop/home', 'redirects stay inside')

    // The in-app view: a service that refuses framing lets DevDash frame it, and still no one else.
    const strict = await get('/service/shop/strict', { cookie: '__Host-devdash=member-token' })
    assert.equal(strict.headers.get('x-frame-options'), null)
    assert.equal(strict.headers.get('content-security-policy'), "frame-ancestors 'self' https://dev.example.com")
    assert.equal(page.headers.get('content-security-policy'), null, 'a service that says nothing is left as it was')
    assert.match(await (await get('/service/shop/')).text(), /target="_top"/, 'signing in from inside the frame opens DevDash itself')

    const pub = await get('/service/demo/') // public, but nothing listens on 20991
    assert.equal(pub.status, 502)
  } finally {
    upstream.close()
  }
})

test("letting DevDash frame a service: only what refuses framing changes, and only DevDash is let in", () => {
  const D = 'https://dev.example.com'
  const run = (h: Record<string, string>) => { const x = new Headers(h); letDevDashFrame(x, D); return Object.fromEntries(x) }
  assert.deepEqual(run({ 'content-type': 'text/html' }), { 'content-type': 'text/html' })
  assert.deepEqual(run({ 'x-frame-options': 'SAMEORIGIN' }), { 'content-security-policy': `frame-ancestors 'self' ${D}` })
  assert.deepEqual(run({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), { 'content-security-policy': `default-src 'self'; frame-ancestors ${D}` })
  assert.deepEqual(run({ 'content-security-policy': "frame-ancestors 'self' https://partner.io" }), { 'content-security-policy': `frame-ancestors 'self' https://partner.io ${D}` })
  assert.deepEqual(run({ 'content-security-policy': 'frame-ancestors *' }), { 'content-security-policy': 'frame-ancestors *' })
  assert.deepEqual(run({ 'content-security-policy': `frame-ancestors ${D}` }), { 'content-security-policy': `frame-ancestors ${D}` })
  // X-Frame-Options alongside a policy that doesn't mention framing: the refusal is kept as its own policy.
  assert.deepEqual(run({ 'x-frame-options': 'DENY', 'content-security-policy': "script-src 'self'" }),
    { 'content-security-policy': `script-src 'self', frame-ancestors 'self' ${D}` })
})
