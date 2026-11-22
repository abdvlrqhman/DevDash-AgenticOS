import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { HARNESSES, PERMISSION_MODES } from '../claude/service.ts'
import {
  SUBAGENT_COLORS,
  SUBAGENT_ICONS,
  SUBAGENT_SCOPES,
  type SubagentRunStatus,
  type SubagentsService,
} from './service.ts'

const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'stopped'] as const satisfies readonly SubagentRunStatus[]

const HarnessOrNull = z.union([z.enum(HARNESSES), z.literal(''), z.null()]).optional()
const PermOrNull = z.union([z.enum(PERMISSION_MODES), z.literal(''), z.null()]).optional()

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().max(64).optional(),
  description: z.string().max(240).optional(),
  instructions: z.string().min(1).max(16_000),
  icon: z.enum(SUBAGENT_ICONS).optional(),
  color: z.enum(SUBAGENT_COLORS).optional(),
  scope: z.enum(SUBAGENT_SCOPES).optional(),
  harness: HarnessOrNull,
  profile: z.string().max(64).optional(),
  model: z.string().max(120).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  permissionMode: PermOrNull,
  defaultProject: z.string().max(64).nullable().optional(),
  defaultCwd: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
})

const UpdateBody = CreateBody.partial()

const DefaultsBody = z.object({
  harness: HarnessOrNull,
  profile: z.string().max(64).optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  permissionMode: PermOrNull,
})

const RunBody = z.object({
  task: z.string().min(1).max(8_000),
  project: z.string().max(64).optional(),
  cwd: z.string().max(500).optional(),
})

const SendBody = z.object({
  message: z.string().min(1).max(8_000),
})

const RunsQuery = z.object({
  subagentId: z.string().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.string().optional(),
})

function parsePosInt(raw: string, label: string) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'bad_id', `Invalid ${label}.`)
  return n
}

/** Member-owned custom subagents and their run history. */
export function subagentsRoutes(subagents: SubagentsService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(subagents.overview(c.get('user'))))
    .get('/defaults', (c) => c.json({ defaults: subagents.defaults(c.get('user')) }))
    .put('/defaults', json(DefaultsBody), async (c) => {
      const defaults = await subagents.saveDefaults(c.get('user'), c.req.valid('json'))
      return c.json({ defaults })
    })
    .post('/', json(CreateBody), async (c) => {
      const subagent = await subagents.create(c.get('user'), c.req.valid('json'))
      return c.json({ subagent }, 201)
    })
    .get('/runs', query(RunsQuery), (c) => {
      const q = c.req.valid('query')
      const subagentId = q.subagentId ? parsePosInt(q.subagentId, 'subagentId') : undefined
      const limit = q.limit ? parsePosInt(q.limit, 'limit') : undefined
      return c.json({ runs: subagents.runs(c.get('user'), { subagentId, status: q.status, limit }) })
    })
    .delete('/runs', query(z.object({ subagentId: z.string().optional() })), (c) => {
      const subagentId = c.req.valid('query').subagentId
      subagents.clearHistory(c.get('user'), subagentId ? parsePosInt(subagentId, 'subagentId') : undefined)
      return c.json({ ok: true })
    })
    .get('/runs/:runId', (c) => {
      const run = subagents.getRun(c.get('user'), parsePosInt(c.req.param('runId'), 'runId'))
      return c.json({ run })
    })
    .post('/runs/:runId/send', json(SendBody), async (c) => {
      const run = await subagents.sendToRun(c.get('user'), parsePosInt(c.req.param('runId'), 'runId'), c.req.valid('json').message)
      return c.json({ run })
    })
    .post('/runs/:runId/stop', async (c) => {
      const run = await subagents.stopRun(c.get('user'), parsePosInt(c.req.param('runId'), 'runId'))
      return c.json({ run })
    })
    .delete('/runs/:runId', (c) => {
      subagents.deleteRun(c.get('user'), parsePosInt(c.req.param('runId'), 'runId'))
      return c.json({ ok: true })
    })
    .patch('/:id', json(UpdateBody), async (c) => {
      const subagent = await subagents.update(c.get('user'), parsePosInt(c.req.param('id'), 'id'), c.req.valid('json'))
      return c.json({ subagent })
    })
    .delete('/:id', (c) => {
      subagents.remove(c.get('user'), parsePosInt(c.req.param('id'), 'id'))
      return c.json({ ok: true })
    })
    .post('/:id/run', json(RunBody), async (c) => {
      const run = await subagents.runManual(c.get('user'), parsePosInt(c.req.param('id'), 'id'), c.req.valid('json'))
      return c.json({ run }, 201)
    })
}
