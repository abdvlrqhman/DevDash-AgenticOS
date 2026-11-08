import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ProjectsService } from '../projects/service.ts'

// Skills for the member's agents. Everything happens in their agent (apps/agent/src/skills.ts), as their Linux user:
// their own skills in their home, a project's in its checkout (committed as them).

export type FileKind = 'text' | 'script' | 'binary'
export type SkillFile = { path: string; size: number; kind: FileKind; executable: boolean; link: boolean }
export type SkillSource =
  | { kind: 'github'; url: string; repo: string; ref: string | null; path: string; sha: string; installedAt: number }
  | { kind: 'upload'; file: string; installedAt: number }
  | { kind: 'written'; installedAt: number }
export type SkillSummary = {
  name: string; title: string | null; description: string | null; linked: boolean; files: number; runs: boolean; source: SkillSource | null; enabled?: boolean
}
export type BuiltInSkill = { name: string; description: string | null; from: string; kind: 'devdash' | 'plugin' | 'account'; enabled: boolean; profiles: string[] }
export type SkillDetail = {
  name: string; title: string | null; description: string | null; markdown: string; files: SkillFile[]; source: SkillSource | null; path: string; linked: boolean; enabled: boolean
}
export type PushState = { branch: string | null; upstream: string | null; ahead: number }
export type ReviewSource = { kind: 'github'; url: string; repo: string; ref: string | null; path: string; sha: string } | { kind: 'upload'; file: string }
export type ReviewSkill = {
  path: string; folder: string; title: string | null; description: string | null; markdown: string; files: SkillFile[]; size: number
  suggested: string; nameProblem: string | null; problems: string[]; collisions: string[]
}
export type Review = { id: string; source: ReviewSource; skills: ReviewSkill[] }
export type Changed = { name?: string; shadowed?: { profile: string; name: string }[]; commit?: { sha: string | null; branch: string | null }; push?: PushState }

const ARCHIVE_MAX = 10 * 1024 * 1024
const Name = z.string().min(1).max(64)
const Folder = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const ReviewId = z.string().regex(/^[a-f0-9]{24}$/)
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
const Write = z.object({ name: Name, description: z.string().max(1024), body: z.string().min(1).max(200_000), replace: z.boolean().default(false) })
/** A path parameter checked like a body field: a clear 400, not a 500. */
const param = <T>(schema: z.ZodType<T>, v: string, what: string) => {
  const r = schema.safeParse(v)
  if (!r.success) throw new AppError(400, 'invalid_input', `Invalid ${what}.`)
  return r.data
}
const Install = z.object({ path: z.string().max(1000), name: Name, project: Slug.optional(), replace: z.boolean().default(false) })

export function skillsRoutes(agents: AgentsService, projects: ProjectsService, mw: ReturnType<typeof authMiddleware>) {
  const as = (c: { get: (k: 'user') => { username: string } }) => c.get('user').username
  /** The project's main checkout (any member may change a project's skills, like its files). */
  const checkout = (slug: string, userId: number) => {
    const p = projects.get(slug, userId)
    if (p.archived) throw new AppError(409, 'archived', 'This project is archived.')
    return p.path
  }
  const ask = <T>(username: string, msg: object, timeoutMs = 60_000) => agents.request<T & { ok?: true }>(username, msg, timeoutMs)
  const scope = (c: { req: { valid: (t: 'query') => { project?: string } }; get: (k: 'user') => { id: number } }) => {
    const slug = c.req.valid('query').project
    return slug ? checkout(slug, c.get('user').id) : undefined
  }
  const ProjectQuery = query(z.object({ project: Slug.optional() }))

  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    // My skills
    .get('/', async (c) => c.json(await ask<{ skills: SkillSummary[]; builtIn: BuiltInSkill[]; profiles: string[]; shadowed: { profile: string; name: string }[] }>(as(c), { op: 'skills.list' })))
    .get('/mine/:name', async (c) => c.json(await ask<{ skill: SkillDetail }>(as(c), { op: 'skills.get', name: param(Folder, c.req.param('name'), 'skill name') })))
    .post('/mine', json(Write), async (c) => c.json(await ask<Changed>(as(c), { op: 'skills.write', ...c.req.valid('json') })))
    .put('/mine/:name/enabled', json(z.object({ enabled: z.boolean() })), async (c) =>
      c.json(await ask<Changed>(as(c), { op: 'skills.enable', name: param(Folder, c.req.param('name'), 'skill name'), enabled: c.req.valid('json').enabled })))
    .delete('/mine/:name', async (c) => c.json(await ask<Changed>(as(c), { op: 'skills.remove', name: param(Folder, c.req.param('name'), 'skill name') })))

    // A project's skills (.claude/skills in its checkout), each change its own commit.
    .get('/projects/:slug', async (c) => {
      const project = checkout(param(Slug, c.req.param('slug'), 'project'), c.get('user').id)
      return c.json(await ask<{ skills: SkillSummary[]; push: PushState }>(as(c), { op: 'skills.list', project }))
    })
    .get('/projects/:slug/skill/:name', async (c) => {
      const project = checkout(param(Slug, c.req.param('slug'), 'project'), c.get('user').id)
      return c.json(await ask<{ skill: SkillDetail }>(as(c), { op: 'skills.get', scope: 'project', project, name: param(Folder, c.req.param('name'), 'skill name') }))
    })
    .post('/projects/:slug', json(Write), async (c) => {
      const project = checkout(param(Slug, c.req.param('slug'), 'project'), c.get('user').id)
      return c.json(await ask<Changed>(as(c), { op: 'skills.write', scope: 'project', project, ...c.req.valid('json') }))
    })
    .delete('/projects/:slug/skill/:name', async (c) => {
      const project = checkout(param(Slug, c.req.param('slug'), 'project'), c.get('user').id)
      return c.json(await ask<Changed>(as(c), { op: 'skills.remove', scope: 'project', project, name: param(Folder, c.req.param('name'), 'skill name') }))
    })
    .post('/projects/:slug/push', async (c) => {
      const project = checkout(param(Slug, c.req.param('slug'), 'project'), c.get('user').id)
      return c.json(await ask<{ push: PushState }>(as(c), { op: 'skills.push', project }, 130_000))
    })

    // Review before install: fetched or unpacked into a new empty folder, shown, installed only when confirmed.
    .post('/review/github', json(z.object({ url: z.string().min(1).max(2000), project: Slug.optional() })), async (c) => {
      const { url, project } = c.req.valid('json')
      const at = project ? checkout(project, c.get('user').id) : undefined
      return c.json({ review: await ask<Review>(as(c), { op: 'skills.review.github', url, project: at }, 200_000) })
    })
    .post('/review/upload', query(z.object({ fileName: z.string().min(1).max(200), project: Slug.optional() })), async (c) => {
      const data = Buffer.from(await c.req.arrayBuffer())
      if (data.length > ARCHIVE_MAX) throw new AppError(400, 'too_big', 'Skill archives are at most 10 MB.')
      const { fileName, project } = c.req.valid('query')
      const at = project ? checkout(project, c.get('user').id) : undefined
      return c.json({ review: await ask<Review>(as(c), { op: 'skills.review.upload', fileName, data: data.toString('base64'), project: at }, 150_000) })
    })
    .get('/review/:id', ProjectQuery, async (c) =>
      c.json({ review: await ask<Review>(as(c), { op: 'skills.review.get', id: param(ReviewId, c.req.param('id'), 'review'), project: scope(c) }) }))
    .delete('/review/:id', async (c) => c.json(await ask(as(c), { op: 'skills.review.discard', id: param(ReviewId, c.req.param('id'), 'review') })))
    .post('/review/:id/install', json(Install), async (c) => {
      const { project: slug, ...rest } = c.req.valid('json')
      const project = slug ? checkout(slug, c.get('user').id) : undefined
      return c.json(await ask<Changed>(as(c), { op: 'skills.install', id: param(ReviewId, c.req.param('id'), 'review'), ...rest, ...(project ? { scope: 'project', project } : {}) }, 120_000))
    })
}
