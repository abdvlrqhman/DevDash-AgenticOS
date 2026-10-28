import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { GoogleError } from './google.ts'
import type { StorageService } from './service.ts'

// Members' own cloud storage. The client secret is posted once, sealed, and never returned.
const AppInput = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().max(200).optional(),
  // Shown on the public /about and /privacy pages; empty clears it.
  contactEmail: z.union([z.email().max(200), z.literal('')]).nullable().optional(),
})
const Callback = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() })

export function storageRoutes(storage: StorageService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    // The callback page posts Google's answer here. Signed in or not (see storage.callback): the state says whose it is.
    .post('/google/callback', json(Callback), async (c) => c.json(await storage.callback(mw.signedIn(c), c.req.valid('json'))))
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await storage.status(c.get('user'))))
    .post('/google/connect', (c) => c.json(storage.connectUrl(c.get('user'))))
    .post('/disconnect', async (c) => c.json(await storage.disconnect(c.get('user'))))
    .get('/google/app', mw.requireAdmin, (c) => c.json(storage.appInfo()))
    .put('/google/app', mw.requireAdmin, json(AppInput), (c) => c.json(storage.setApp(c.get('user'), c.req.valid('json'))))
}

/**
 * rclone's `token_url`, at /internal/storage/token on the server's loopback port only (Caddy proxies /api/*, not this).
 * A standard OAuth refresh: the "refresh token" is the member's DevDash handle; the client credentials are ignored.
 */
export function storageTokenRoutes(storage: StorageService) {
  return new Hono().post('/token', async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
    if (form.grant_type !== 'refresh_token' || typeof form.refresh_token !== 'string') {
      return c.json({ error: 'unsupported_grant_type', error_description: 'Only refresh_token is supported.' }, 400)
    }
    try {
      return c.json(await storage.token(form.refresh_token))
    } catch (err) {
      if (err instanceof GoogleError && err.code === 'invalid_grant') return c.json({ error: 'invalid_grant', error_description: err.message }, 400)
      console.error('storage token:', err)
      return c.json({ error: 'temporarily_unavailable', error_description: 'Google did not answer; try again shortly.' }, 503)
    }
  })
}
