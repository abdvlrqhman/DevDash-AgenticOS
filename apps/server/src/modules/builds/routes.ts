import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { EXPIRY } from '../files/shares.ts'
import { attachment } from '../files/stream.ts'
import type { BuildsService } from './service.ts'

const Target = z.object({
  name: z.string().min(1).max(80), workflow: z.string().min(1).max(200), ref: z.string().max(200).default(''),
  inputs: z.record(z.string().max(100), z.string().max(2000)).default({}),
})
const Share = z.object({
  name: z.string().min(1).max(200), runNumber: z.number().int(), expires: z.enum(Object.keys(EXPIRY) as [keyof typeof EXPIRY]).default('7d'),
  password: z.string().max(256).optional(),
})

export function buildsRoutes(builds: BuildsService, mw: ReturnType<typeof authMiddleware>) {
  const n = (v: string) => Number.parseInt(v, 10)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/:slug', async (c) => c.json(await builds.overview(c.get('user'), c.req.param('slug'))))
    .post('/:slug/targets', json(Target), (c) => c.json({ target: builds.addTarget(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .delete('/:slug/targets/:id', (c) => {
      builds.removeTarget(c.req.param('slug'), n(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/:slug/targets/:id/start', async (c) => c.json(await builds.start(c.get('user'), c.req.param('slug'), n(c.req.param('id')))))
    .get('/:slug/runs/:run', async (c) => c.json(await builds.run(c.get('user'), c.req.param('slug'), n(c.req.param('run')))))
    .post('/:slug/runs/:run/cancel', async (c) => { await builds.action(c.get('user'), c.req.param('slug'), n(c.req.param('run')), 'cancel'); return c.json({ ok: true }) })
    .post('/:slug/runs/:run/rerun', async (c) => { await builds.action(c.get('user'), c.req.param('slug'), n(c.req.param('run')), 'rerun'); return c.json({ ok: true }) })
    .get('/:slug/jobs/:job/log', async (c) => c.json({ log: await builds.log(c.get('user'), c.req.param('slug'), n(c.req.param('job'))) }))
    .get('/:slug/artifacts/:id/:name', async (c) => {
      const f = await builds.artifactStream(c.get('user'), c.req.param('slug'), n(c.req.param('id')), c.req.param('name'))
      return new Response(f.body, { headers: { 'content-type': 'application/zip', 'content-disposition': attachment(f.name) } })
    })
    .post('/:slug/artifacts/:id/share', json(Share), async (c) =>
      c.json({ share: await builds.shareArtifact(c.get('user'), c.req.param('slug'), n(c.req.param('id')), c.req.valid('json')) }))
}
