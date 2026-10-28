import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { deployService } from './deploy.ts'
import type { StatusService } from './service.ts'

export function statusRoutes(status: StatusService, deploys: ReturnType<typeof deployService>, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await status.get(c.get('user').role === 'admin')))
    .post('/claude-update', mw.requireAdmin, async (c) => {
      await status.updateClaude()
      return c.json({ ok: true })
    })
    .post('/backup', mw.requireAdmin, async (c) => {
      await status.backupNow()
      return c.json({ ok: true })
    })
    // Updating DevDash itself: anyone sees and asks, admins deploy (modules/status/deploy.ts).
    .get('/deploy', query(z.object({ refresh: z.enum(['1']).optional() })), async (c) =>
      c.json(await deploys.state(c.get('user').role === 'admin', c.req.valid('query').refresh === '1')))
    .post('/deploy/requests', json(z.object({ commit: z.string().max(40).optional(), note: z.string().max(2000).optional() })), async (c) => {
      const r = await deploys.request(c.get('user'), c.req.valid('json'))
      return c.json({ id: r.id, existing: r.existing })
    })
    .post('/deploy', mw.requireAdmin, json(z.object({ sha: z.string().max(40).optional(), requestId: z.number().int().positive().optional() })), async (c) =>
      c.json(await deploys.start(c.get('user'), c.req.valid('json'))))
    .post('/deploy/requests/:id/decline', mw.requireAdmin, (c) => {
      deploys.decline(c.get('user'), Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}
