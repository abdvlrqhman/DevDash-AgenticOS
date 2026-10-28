import { Hono } from 'hono'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ReviewsService } from './service.ts'

/** "Ready to review" endpoints, mounted under /api so the paths read /api/projects/:slug/deliveries/... */
export function reviewsRoutes(reviews: ReviewsService, mw: ReturnType<typeof authMiddleware>) {
  const id = (v: string) => Number.parseInt(v, 10)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/projects/:slug/deliveries', (c) => c.json(reviews.list(c.req.param('slug'))))
    .get('/projects/:slug/deliveries/:id/diff', async (c) => c.json(await reviews.diff(c.get('user'), c.req.param('slug'), id(c.req.param('id')))))
    .post('/projects/:slug/deliveries/:id/pr', async (c) => c.json({ delivery: await reviews.openPr(c.get('user'), c.req.param('slug'), id(c.req.param('id'))) }))
    .post('/projects/:slug/deliveries/:id/merge', async (c) => c.json({ delivery: await reviews.merge(c.get('user'), c.req.param('slug'), id(c.req.param('id'))) }))
    .post('/projects/:slug/deliveries/:id/dismiss', (c) => c.json(reviews.dismiss(c.get('user'), c.req.param('slug'), id(c.req.param('id')))))
}
