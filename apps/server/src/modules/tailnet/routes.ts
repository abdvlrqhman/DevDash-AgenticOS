import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { TailnetService } from './service.ts'

// Per-user tailnet. The auth key is a secret: it is posted once, sealed server-side, and
// never returned (status reports hasKey instead).
const Connect = z.object({ authKey: z.string().min(1).max(500) })

export function tailnetRoutes(tailnet: TailnetService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/status', async (c) => c.json(await tailnet.status(c.get('user'))))
    .post('/connect', json(Connect), async (c) => c.json(await tailnet.connect(c.get('user'), c.req.valid('json').authKey)))
    .post('/disconnect', async (c) => c.json(await tailnet.disconnect(c.get('user'))))
}
