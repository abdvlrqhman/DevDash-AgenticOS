import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ApnsService } from './apns.ts'
import type { NotificationsService } from './service.ts'
import type { NtfyService } from './ntfy.ts'

const Subscription = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoints must be https'),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
})
const Prefs = z.object({ needs_you: z.boolean(), finished: z.boolean(), errors: z.boolean(), shared: z.boolean() })
// The iPhone app's APNs device token (hex; Apple says not to assume its length) and which Apple environment it is for.
const ApnsDevice = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{32,400}$/, 'Not an APNs device token'),
  environment: z.enum(['sandbox', 'production']),
  device: z.string().max(200),
})
// The space's APNs key. The .p8 file is posted once, sealed, and never returned.
const ApnsConfig = z.object({
  teamId: z.string().trim().min(1).max(20),
  keyId: z.string().trim().min(1).max(20),
  bundleId: z.string().trim().min(1).max(200),
  key: z.string().max(10_000).optional(),
})

export function notificationsRoutes(n: NotificationsService, apns: ApnsService, ntfy: NtfyService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(n.list(c.get('user').id)))
    // For native apps while they're closed (Android): server-sent events, a comment every 25 s to keep it open.
    .get('/stream', (c) => {
      const since = Number(c.req.query('since')) || 0
      c.header('cache-control', 'no-store')
      c.header('x-accel-buffering', 'no')
      return streamSSE(c, async (stream) => {
        const queue: string[] = []
        let wake: (() => void) | null = null
        const sub = n.listen(c.get('user').id, since, (e) => { queue.push(JSON.stringify(e)); wake?.() })
        for (const e of sub.missed) queue.push(JSON.stringify(e))
        stream.onAbort(() => { sub.stop(); wake?.() })
        try {
          while (!stream.aborted) {
            while (queue.length) await stream.writeSSE({ data: queue.shift()! })
            await new Promise<void>((r) => { wake = r; setTimeout(r, 25_000) })
            wake = null
            if (!queue.length && !stream.aborted) await stream.write(': ping\n\n')
          }
        } finally {
          sub.stop()
        }
      })
    })
    .post('/read', (c) => {
      n.readAll(c.get('user').id)
      return c.json({ ok: true })
    })
    .post('/test', async (c) => {
      await n.notify(c.get('user').id, 'needs_you', { title: 'Notifications work', body: 'This is how DevDash tells you Claude needs you.', url: '/account', tag: 'test' }, true)
      return c.json({ ok: true })
    })
    .get('/prefs', (c) => c.json({ prefs: n.prefs(c.get('user').id), publicKey: n.publicKey, apns: apns.configured() }))
    .put('/prefs', json(Prefs), (c) => c.json({ prefs: n.savePrefs(c.get('user').id, c.req.valid('json')) }))
    .post('/subscriptions', json(z.object({ subscription: Subscription, device: z.string().max(200) })), (c) => {
      const { subscription, device } = c.req.valid('json')
      n.subscribe(c.get('user').id, subscription, device)
      return c.json({ ok: true })
    })
    .post('/subscriptions/check', json(z.object({ endpoint: z.string().max(1000) })), (c) =>
      c.json({ subscribed: n.isSubscribed(c.get('user').id, c.req.valid('json').endpoint) }))
    .post('/subscriptions/remove', json(z.object({ endpoint: z.string().max(1000) })), (c) => {
      n.unsubscribe(c.get('user').id, c.req.valid('json').endpoint)
      return c.json({ ok: true })
    })
    // The iPhone app (signed in here) registers its device token at each launch; `configured` says whether the space can push.
    .post('/apns', json(ApnsDevice), (c) => c.json(apns.register(c.get('user').id, c.req.valid('json'))))
    .post('/apns/remove', json(z.object({ token: z.string().max(400) })), (c) => {
      apns.unregister(c.get('user').id, c.req.valid('json').token)
      return c.json({ ok: true })
    })
    // The member's own ntfy target (ntfy.ts). The access token is posted once, sealed, and never returned.
    .get('/ntfy', (c) => c.json(ntfy.status(c.get('user').id)))
    .put('/ntfy', json(z.object({ server: z.string().max(300).optional(), token: z.string().max(300).nullable().optional(), newTopic: z.boolean().optional() })),
      (c) => c.json(ntfy.configure(c.get('user').id, c.req.valid('json'))))
    .delete('/ntfy', (c) => c.json(ntfy.disable(c.get('user').id)))
    .post('/ntfy/test', async (c) => c.json(await ntfy.test(c.get('user').id)))
    .get('/apns/config', mw.requireAdmin, (c) => c.json(apns.info()))
    .put('/apns/config', mw.requireAdmin, json(ApnsConfig), (c) => c.json(apns.setConfig(c.get('user'), c.req.valid('json'))))
    .delete('/apns/config', mw.requireAdmin, (c) => c.json(apns.removeConfig()))
}
