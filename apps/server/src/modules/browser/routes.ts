import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { json, rateLimit } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { BrowserService } from './service.ts'

const WATCH_COOKIE = 'dd_watch'

export function browserRoutes(browser: BrowserService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    // Caddy asks this before every /browser/ request (forward_auth): a signed-in member, or a guest with a live invite.
    .get('/check', (c) => {
      if (mw.signedIn(c) || browser.invite(getCookie(c, WATCH_COOKIE))) return c.body(null, 204)
      return c.body(null, 401)
    })
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await browser.status()))
    .post('/open', async (c) => c.json({ url: await browser.open(c.get('user')) }))
    .post('/heartbeat', (c) => {
      browser.heartbeat()
      return c.json({ ok: true })
    })
    .post('/stop', async (c) => {
      console.log(`browser stopped by ${c.get('user').username}`)
      await browser.stop()
      return c.json({ ok: true })
    })
    .get('/invites', (c) => c.json({ invites: browser.invites() }))
    .post('/invites', json(z.object({ label: z.string().trim().min(1).max(60), hours: z.number().int().min(1).max(24 * 30), canControl: z.boolean().default(false) })),
      (c) => c.json({ invite: browser.createInvite(c.get('user'), c.req.valid('json')) }))
    .delete('/invites/:id', (c) => {
      browser.revokeInvite(Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}

/** /watch/<token>: a guest's way in. Sets the invite cookie for /browser/ and sends them to it, signed in. */
export function watchRoutes(browser: BrowserService, ip: (c: import('hono').Context) => string) {
  return new Hono().get('/:token', async (c) => {
    rateLimit(`watch:${ip(c)}`, 30, 10 * 60_000)
    const invite = browser.invite(c.req.param('token'))
    if (!invite) {
      c.header('x-robots-tag', 'noindex')
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:24rem;padding:1rem"><h1 style="font-size:1.2rem">This invite doesn't work</h1>
<p style="opacity:.7">It may have expired or been turned off. Ask the person who sent it for a new one.</p></main></body>`, 404)
    }
    setCookie(c, WATCH_COOKIE, c.req.param('token'), {
      path: '/browser/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: Math.max(60, invite.expires_at - Math.floor(Date.now() / 1000)),
    })
    return c.redirect(await browser.guestUrl(invite))
  })
}
