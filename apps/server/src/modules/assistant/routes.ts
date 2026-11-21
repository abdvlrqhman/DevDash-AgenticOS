import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { agentCapabilities, HARNESSES, PERMISSION_MODES } from '../claude/service.ts'
import type { FollowService } from './follow.ts'
import type { AssistantService } from './service.ts'

const Setup = z.object({ harness: z.enum(HARNESSES.filter((h) => agentCapabilities(h).assistant)), profile: z.string().max(21).default('default'), tz: z.string().max(64).optional(), fullAccess: z.boolean().optional() })
const Settings = z.object({
  model: z.string().max(160).nullable().optional(),
  effort: z.string().min(1).max(160).nullable().optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  fastMode: z.boolean().optional(),
  reachTailnet: z.boolean().optional(),
  drive: z.boolean().optional(),
})
const Follow = z.object({ sessionId: z.string().min(1).max(100), goal: z.string().min(1).max(300) })
const SchedulePatch = z.object({ enabled: z.boolean().optional(), title: z.string().max(80).optional(), prompt: z.string().max(8000).optional() })

/** The member's own personal agent: always their own, so every route acts on the signed-in member. */
export function assistantRoutes(assistant: AssistantService, mw: ReturnType<typeof authMiddleware>, follow: FollowService) {
  // Every answer carries what Hamasa follows: the panel strip, the session chip and the list glyph read it.
  const full = (u: Parameters<AssistantService['state']>[0], st: ReturnType<AssistantService['state']>) => ({ ...st, following: follow.state(u) })
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(full(c.get('user'), assistant.state(c.get('user')))))
    .put('/', json(Setup), async (c) => c.json(full(c.get('user'), await assistant.setup(c.get('user'), c.req.valid('json')))))
    .patch('/', json(Settings), async (c) => c.json(full(c.get('user'), await assistant.settings(c.get('user'), c.req.valid('json')))))
    .post('/new', async (c) => c.json(full(c.get('user'), await assistant.fresh(c.get('user')))))
    .post('/seen', (c) => c.json(full(c.get('user'), assistant.seen(c.get('user')))))
    // Following sessions (in testing: an admin turns it on for themself).
    .put('/following', json(z.object({ on: z.boolean() })), (c) => {
      follow.setOn(c.get('user'), c.req.valid('json').on)
      return c.json(full(c.get('user'), assistant.state(c.get('user'))))
    })
    .post('/follows', json(Follow), (c) => {
      const b = c.req.valid('json')
      follow.follow(c.get('user'), b.sessionId, b.goal)
      return c.json(full(c.get('user'), assistant.state(c.get('user'))))
    })
    .delete('/follows/:sessionId', (c) => {
      follow.unfollow(c.get('user'), c.req.param('sessionId'))
      return c.json(full(c.get('user'), assistant.state(c.get('user'))))
    })
    .patch('/schedules/:id', json(SchedulePatch), (c) =>
      c.json(assistant.updateSchedule(c.get('user'), Number(c.req.param('id')), c.req.valid('json'))))
    .delete('/schedules/:id', (c) => {
      assistant.deleteSchedule(c.get('user'), Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}
