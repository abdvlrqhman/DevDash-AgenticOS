import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { AutopilotService } from './service.ts'

const LogQuery = z.object({
  who: z.enum(['autopilot', 'sessions', 'settings']).optional(),
  tier: z.enum(['green', 'yellow', 'red', 'action', 'system']).optional(),
  project: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  order: z.enum(['new', 'old']).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
})
const Enabled = z.object({ enabled: z.boolean() })
const Rules = z.object({ rules: z.string().max(20_000).nullable() })
const Settings = z.object({
  tz: z.string().max(64).optional(),
  pingAt: z.string().max(5).optional(),
  quietMin: z.number().int().optional(),
  nightCap: z.number().int().optional(),
  maxNudges: z.number().int().optional(),
  approvals: z.boolean().optional(),
  promptWaitMin: z.number().int().optional(),
})

/** The member's own autopilot: every route acts on the signed-in member only. */
export function autopilotRoutes(autopilot: AutopilotService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(autopilot.state(c.get('user'))))
    .get('/log', query(LogQuery), (c) => c.json(autopilot.entries(c.get('user'), c.req.valid('query'))))
    .put('/enabled', json(Enabled), (c) => c.json(autopilot.setEnabled(c.get('user'), c.req.valid('json').enabled)))
    .put('/rules', json(Rules), (c) => c.json(autopilot.setRules(c.get('user'), c.req.valid('json').rules)))
    .patch('/settings', json(Settings), (c) => c.json(autopilot.setSettings(c.get('user'), c.req.valid('json'))))
    .put('/team/:projectId', json(z.object({ on: z.boolean() })), (c) =>
      c.json(autopilot.setTeam(c.get('user'), Number(c.req.param('projectId')), c.req.valid('json').on)))
    .post('/seen', (c) => c.json(autopilot.seen(c.get('user'))))
    .post('/inbox/:id/dismiss', (c) => c.json(autopilot.dismiss(c.get('user'), Number(c.req.param('id')))))
}
