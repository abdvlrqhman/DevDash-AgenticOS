import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { HARNESSES, PERMISSION_MODES } from '../claude/service.ts'
import type { AssistantService } from './service.ts'

const Setup = z.object({ harness: z.enum(HARNESSES), profile: z.string().max(21).default('default'), tz: z.string().max(64).optional() })
const Settings = z.object({
  model: z.string().max(160).nullable().optional(),
  effort: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/i).nullable().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  fastMode: z.boolean().optional(),
  reachTailnet: z.boolean().optional(),
  drive: z.boolean().optional(),
})
const SchedulePatch = z.object({ enabled: z.boolean().optional(), title: z.string().max(80).optional(), prompt: z.string().max(8000).optional() })

/** The member's own personal agent: always their own, so every route acts on the signed-in member. */
export function assistantRoutes(assistant: AssistantService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(assistant.state(c.get('user'))))
    .put('/', json(Setup), async (c) => c.json(await assistant.setup(c.get('user'), c.req.valid('json'))))
    .patch('/', json(Settings), async (c) => c.json(await assistant.settings(c.get('user'), c.req.valid('json'))))
    .post('/new', async (c) => c.json(await assistant.fresh(c.get('user'))))
    .get('/conversations', (c) => c.json({ conversations: assistant.conversations(c.get('user')) }))
    .post('/conversations/:id', async (c) => c.json(await assistant.resume(c.get('user'), c.req.param('id'))))
    .patch('/schedules/:id', json(SchedulePatch), (c) =>
      c.json(assistant.updateSchedule(c.get('user'), Number(c.req.param('id')), c.req.valid('json'))))
    .delete('/schedules/:id', (c) => {
      assistant.deleteSchedule(c.get('user'), Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}
