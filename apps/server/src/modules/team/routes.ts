import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { TRIGGERS } from './schedule.ts'
import { CLOSE_AS, MESSAGE_KINDS, MODELS, type TeamService } from './service.ts'
import { SOURCE_KINDS } from './sources.ts'

const RoleInput = z.object({
  name: z.string().trim().min(1).max(60),
  summary: z.string().trim().max(300).default(''),
  instructions: z.string().max(20_000).default(''),
  model: z.enum(MODELS).nullable().default(null),
})
const Slot = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), at: z.string().regex(/^\d{1,2}:\d{2}$/) })
const Message = z.object({
  kind: z.enum(MESSAGE_KINDS).default('reply'),
  body: z.string().trim().min(1).max(8000),
  evidence: z.string().max(8000).optional(),
  to: z.string().max(60).optional(),
  cc: z.array(z.string().max(60)).max(6).optional(),
  ask: z.string().max(300).optional(),
})
const Source = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(SOURCE_KINDS),
  description: z.string().max(500).default(''),
  config: z.object({
    path: z.string().max(500).optional(), baseUrl: z.string().max(500).optional(), url: z.string().max(500).optional(),
    secretIn: z.enum(['header', 'query']).optional(), secretName: z.string().max(60).optional(),
  }).default({}),
  secret: z.string().max(4000).nullable().optional(),
})
const Body = (max: number) => z.object({ body: z.string().trim().min(1).max(max) })
const id = (v: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, 'not_found', 'Not found.')
  return n
}

/** `team` is null when Team is switched off on this server (DEVDASH_TEAM=0): every route answers that it's off. */
export function teamRoutes(team: TeamService | null, mw: ReturnType<typeof authMiddleware>) {
  const t = () => {
    if (!team) throw new AppError(404, 'team_off', 'Team is switched off on this server.')
    return team
  }
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/projects/:slug', (c) => c.json(t().overview(c.req.param('slug'))))
    .put('/projects/:slug', json(z.object({ enabled: z.boolean(), tz: z.string().max(60).optional() })), (c) => {
      const { enabled, tz } = c.req.valid('json')
      if (enabled) t().enable(c.get('user'), c.req.param('slug'), tz)
      else t().disable(c.req.param('slug'))
      return c.json({ ok: true })
    })
    .put('/projects/:slug/settings', json(z.object({ paused: z.boolean().optional(), tz: z.string().max(60).optional() })), (c) => {
      t().settings(c.req.param('slug'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .post('/projects/:slug/goals', json(z.object({
      title: z.string().trim().min(1).max(200), measure: z.string().trim().max(300).default(''), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    })), (c) => {
      t().addGoal(c.req.param('slug'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .patch('/goals/:id', json(z.object({
      status: z.enum(['active', 'done', 'dropped']).optional(), progress: z.number().int().min(0).max(100).optional(), note: z.string().max(300).optional(),
    })), (c) => {
      t().updateGoal(id(c.req.param('id')), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .post('/projects/:slug/threads', json(Message.extend({ title: z.string().trim().min(1).max(200) })), (c) =>
      c.json(t().postAsPerson(c.get('user'), c.req.param('slug'), c.req.valid('json'))))
    .get('/projects/:slug/threads', query(z.object({
      status: z.enum(['open', 'waiting', 'closed', 'all']).default('all'), outcome: z.enum(CLOSE_AS).optional(),
      role: z.coerce.number().int().min(1).optional(), q: z.string().trim().max(200).optional(), offset: z.coerce.number().int().min(0).default(0),
    })), (c) => {
      const { offset, ...f } = c.req.valid('query')
      return c.json(t().threads(c.req.param('slug'), f, offset))
    })
    .get('/threads/:id', (c) => c.json(t().thread(id(c.req.param('id')))))
    .post('/threads/:id/messages', json(Message), (c) => {
      const th = t().thread(id(c.req.param('id')))
      return c.json(t().postAsPerson(c.get('user'), th.project.slug, { ...c.req.valid('json'), thread: th.thread.id }))
    })
    .post('/threads/:id/resolve', json(z.object({
      resolution: z.string().max(1000).default(''), as: z.enum(CLOSE_AS).default('done'), duplicateOf: z.number().int().min(1).optional(),
    })), (c) => {
      const { resolution, as, duplicateOf } = c.req.valid('json')
      t().resolveAsPerson(c.get('user'), id(c.req.param('id')), resolution, as, duplicateOf)
      return c.json({ ok: true })
    })
    .post('/threads/:id/reopen', (c) => {
      t().reopen(c.get('user'), id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/threads/:id/priority', json(z.object({ priority: z.enum(['normal', 'blocker']) })), (c) => {
      t().setThreadPriority(c.get('user'), id(c.req.param('id')), c.req.valid('json').priority)
      return c.json({ ok: true })
    })
    // One job per object: link a task (by its number) to a thread, or unlink it.
    .post('/threads/:id/tasks', json(z.object({ task: z.number().int().min(1) })), (c) => {
      t().linkTaskAsPerson(c.get('user'), id(c.req.param('id')), c.req.valid('json').task)
      return c.json({ ok: true })
    })
    .delete('/threads/:id/tasks/:task', (c) => {
      t().linkTaskAsPerson(c.get('user'), id(c.req.param('id')), id(c.req.param('task')), true)
      return c.json({ ok: true })
    })
    .post('/projects/:slug/sources', json(Source), (c) => {
      t().addSource(c.get('user'), c.req.param('slug'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .put('/sources/:id', json(Source.omit({ kind: true })), (c) => {
      t().updateSource(id(c.req.param('id')), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .delete('/sources/:id', (c) => {
      t().removeSource(id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/sources/:id/test', async (c) => c.json(await t().testSource(id(c.req.param('id')))))
    .get('/approvals', query(z.object({ status: z.enum(['pending', 'decided']).default('pending'), project: z.string().max(40).optional() })), (c) => {
      const { status, project } = c.req.valid('query')
      return c.json({ proposals: t().approvals(status, project) })
    })
    .get('/approvals/count', (c) => c.json({ pending: team ? team.pendingCount() : 0 }))
    .get('/approvals/projects', (c) => c.json({ projects: t().approvalProjects() }))
    .post('/proposals/:id/decide', json(z.object({ approve: z.boolean(), reply: z.string().max(4000).default('') })), async (c) => {
      const { approve, reply } = c.req.valid('json')
      return c.json({ proposal: await t().decide(c.get('user'), id(c.req.param('id')), approve, reply) })
    })
    .put('/projects/:slug/brief', json(z.object({ body: z.string().max(20_000) })), (c) => {
      t().saveBrief(c.get('user'), c.req.param('slug'), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .put('/projects/:slug/priorities', json(z.object({ body: z.string().max(4000) })), (c) => {
      t().savePriorities(c.req.param('slug'), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .put('/projects/:slug/close-guard', json(z.object({ money: z.boolean().optional(), production: z.boolean().optional(), person_decision: z.boolean().optional() })), (c) => {
      t().setCloseGuard(c.req.param('slug'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .post('/projects/:slug/decisions', json(Body(2000)), (c) => {
      t().addDecision(c.get('user'), c.req.param('slug'), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .delete('/projects/:slug/decisions/:id', (c) => {
      t().removeDecision(c.req.param('slug'), id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/projects/:slug/generate', json(z.object({ name: z.string().trim().min(1).max(60), summary: z.string().max(300).default('') })), async (c) => {
      const { name, summary } = c.req.valid('json')
      return c.json(await t().generate(c.get('user'), c.req.param('slug'), name, summary))
    })
    .post('/projects/:slug/roles', json(RoleInput.extend({ schedule: z.array(Slot).max(10).optional() })), (c) =>
      c.json({ role: t().createRole(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .put('/roles/:id/settings', json(z.object({
      autonomy: z.enum(['advisor', 'operator']),
      autoApprove: z.array(z.enum(['code', 'goal'])).max(2),
      schedule: z.array(Slot).max(10),
      triggers: z.array(z.enum(TRIGGERS)).max(TRIGGERS.length),
      paused: z.boolean(),
      dailyLimit: z.number().int().min(0).max(48),
      monthlyBudget: z.number().min(0).max(100_000).nullable(),
      lead: z.boolean().optional(),
      selfClose: z.enum(['default', 'always_ask', 'allow']).optional(),
    })), (c) => c.json({ role: t().roleSettings(id(c.req.param('id')), c.req.valid('json')) }))
    .get('/roles/:id', (c) => c.json(t().role(id(c.req.param('id')))))
    .put('/roles/:id', json(RoleInput), (c) => c.json({ role: t().updateRole(id(c.req.param('id')), c.req.valid('json')) }))
    .delete('/roles/:id', (c) => {
      t().archiveRole(id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/roles/:id/shift', async (c) => c.json({ role: await t().runShift(id(c.req.param('id'))) }))
    .post('/roles/:id/chat', async (c) => c.json(await t().chat(id(c.req.param('id')))))
    .post('/roles/:id/notebook', json(Body(2000)), (c) => {
      t().addNote(c.get('user'), id(c.req.param('id')), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .delete('/roles/:id/notebook/:note', (c) => {
      t().removeNote(id(c.req.param('id')), id(c.req.param('note')))
      return c.json({ ok: true })
    })
}
