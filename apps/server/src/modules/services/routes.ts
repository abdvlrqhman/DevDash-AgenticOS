import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ServicesService } from './service.ts'

const Options = { autostart: z.boolean().optional(), restart: z.boolean().optional(), env: z.string().max(10_000).optional(), public: z.boolean().optional() }
const Create = z.object({ name: z.string().max(31), cwd: z.string().min(1).max(500), command: z.string().min(1).max(2000), ...Options })
const Edit = z.object({ cwd: z.string().min(1).max(500).optional(), command: z.string().min(1).max(2000).optional(), ...Options })

export function servicesRoutes(svc: ServicesService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json({ services: svc.list(c.get('user')) }))
    .post('/', json(Create), async (c) => c.json({ service: await svc.create(c.get('user'), c.req.valid('json')) }))
    .get('/ports', (c) => c.json({ ports: svc.ports() }))
    .get('/:name', (c) => c.json({ service: svc.get(c.get('user'), c.req.param('name')) }))
    .patch('/:name', json(Edit), async (c) => c.json({ service: await svc.edit(c.get('user'), c.req.param('name'), c.req.valid('json')) }))
    .post('/:name/start', async (c) => c.json({ service: await svc.start(c.get('user'), c.req.param('name')) }))
    .post('/:name/stop', async (c) => c.json({ service: await svc.stop(c.get('user'), c.req.param('name')) }))
    .post('/:name/restart', async (c) => c.json({ service: await svc.restart(c.get('user'), c.req.param('name')) }))
    .delete('/:name', async (c) => {
      await svc.remove(c.get('user'), c.req.param('name'))
      return c.json({ ok: true })
    })
}

