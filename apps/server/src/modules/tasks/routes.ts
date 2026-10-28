import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { PRIORITIES, STATUSES, type TasksService } from './service.ts'

const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
const Create = z.object({
  project: z.string().max(40), title: z.string().min(1).max(300), body: z.string().max(100_000).optional(),
  status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), due: Due.optional(), assignee: z.number().int().nullable().optional(),
})
const Patch = z.object({
  title: z.string().min(1).max(300).optional(), body: z.string().max(100_000).optional(), status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(), due: Due.optional(), assignee: z.number().int().nullable().optional(), sort: z.number().optional(),
})
const Give = z.object({ worktree: z.boolean().default(true), note: z.string().max(10_000).default(''), profile: z.string().max(21).optional() })

export type GiveToClaude = (user: AuthEnv['Variables']['user'], slug: string, number: number, o: z.infer<typeof Give>) => Promise<{ sessionId: string }>

export function tasksRoutes(tasks: TasksService, giveToClaude: GiveToClaude, mw: ReturnType<typeof authMiddleware>) {
  const num = (v: string) => Number.parseInt(v, 10)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ project: z.string().max(40).optional(), assignee: z.string().max(12).optional(), done: z.enum(['recent', 'all']).optional() })), (c) => {
      const f = c.req.valid('query')
      return c.json({
        tasks: tasks.list({
          project: f.project || undefined,
          assignee: f.assignee === 'me' ? c.get('user').id : f.assignee ? num(f.assignee) : undefined,
          includeOldDone: f.done === 'all',
        }),
      })
    })
    .post('/', json(Create), (c) => c.json({ task: tasks.create({ user: c.get('user') }, c.req.valid('json')) }))
    .get('/:slug/:number', (c) => c.json({ task: tasks.get(c.req.param('slug'), num(c.req.param('number'))) }))
    .patch('/:slug/:number', json(Patch), (c) => c.json({ task: tasks.update({ user: c.get('user') }, c.req.param('slug'), num(c.req.param('number')), c.req.valid('json')) }))
    .post('/:slug/:number/comments', json(z.object({ body: z.string().min(1).max(20_000) })), (c) =>
      c.json({ task: tasks.comment({ user: c.get('user') }, c.req.param('slug'), num(c.req.param('number')), c.req.valid('json').body) }))
    .post('/:slug/:number/claude', json(Give), async (c) =>
      c.json(await giveToClaude(c.get('user'), c.req.param('slug'), num(c.req.param('number')), c.req.valid('json'))))
}
