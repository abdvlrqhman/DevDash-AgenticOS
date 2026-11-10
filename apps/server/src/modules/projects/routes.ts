import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { SESSION_SHARING, type ProjectsService } from './service.ts'
import type { ProjectTrash } from './trash.ts'

const CHUNK = 32 * 1024 * 1024 // Cloudflare caps a request at 100 MB, so a big zip (up to 20 GB) arrives in pieces.
const UploadId = z.string().regex(/^[a-f0-9]{8,64}$/)
const Instructions = z.string().max(20_000)
/** A new project, from the page or the personal agent (assistant/mcp.ts project_create): one way to make one. */
export const Create = z.object({ name: z.string().max(80).default(''), slug: z.string().max(40).optional(), repoUrl: z.string().max(500).optional(), instructions: Instructions.optional() })
const FromZip = z.object({ name: z.string().max(80).default(''), slug: z.string().max(40).optional(), uploadId: UploadId, instructions: Instructions.optional() })
const Patch = z.object({ name: z.string().min(1).max(80).optional(), archived: z.boolean().optional(), sessionSharing: z.enum(SESSION_SHARING).optional(), instructions: Instructions.optional() })
const Connect = z.object({ repoUrl: z.string().min(1).max(500) })
/** The project's short name, typed to confirm deleting it. */
const Confirm = z.object({ confirm: z.string().max(80) })

export function projectsRoutes(projects: ProjectsService, trash: ProjectTrash, activity: ActivityService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ archived: z.enum(['0', '1']).default('0') })), (c) => c.json({ projects: projects.list(c.req.valid('query').archived === '1', c.get('user').id) }))
    .post('/', json(Create), async (c) => c.json({ project: await projects.create(c.get('user'), c.req.valid('json')) }))
    // Create from an uploaded .zip: stream the zip here in ≤32 MB pieces (the first says the whole size), then start the
    // import (unzip + git init + insert) in the background and ask how it's going.
    .post('/zip', query(z.object({ uploadId: UploadId, offset: z.coerce.number().int().min(0), total: z.coerce.number().int().min(0).optional() })), async (c) => {
      const data = Buffer.from(await c.req.arrayBuffer())
      if (data.length > CHUNK) throw new AppError(400, 'too_big', 'Upload pieces must be 32 MB or smaller.')
      const { uploadId, offset, total } = c.req.valid('query')
      return c.json(await projects.uploadZip(c.get('user'), uploadId, offset, data, total))
    })
    .get('/zip/status', query(z.object({ uploadId: UploadId })), (c) => c.json(projects.importStatus(c.get('user'), c.req.valid('query').uploadId)))
    .post('/zip/abort', json(z.object({ uploadId: UploadId })), async (c) => c.json(await projects.abortZip(c.get('user'), c.req.valid('json').uploadId)))
    .post('/from-zip', json(FromZip), (c) => c.json({ import: projects.startFromZip(c.get('user'), c.req.valid('json')) }))
    // Recently deleted (trash.ts): only whoever may restore or purge each one sees it.
    .get('/trash', (c) => c.json({ projects: trash.deleted(c.get('user')) }))
    .post('/trash/:slug/restore', async (c) => c.json({ project: await trash.restore(c.get('user'), c.req.param('slug')) }))
    .post('/trash/:slug/purge', json(Confirm), async (c) => { await trash.purge(c.get('user'), c.req.param('slug'), c.req.valid('json').confirm); return c.json({ ok: true }) })
    .get('/:slug', (c) => c.json({ project: projects.get(c.req.param('slug'), c.get('user').id) }))
    .patch('/:slug', json(Patch), (c) => c.json({ project: projects.update(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .post('/:slug/connect', json(Connect), async (c) => c.json({ project: await projects.connectRepo(c.get('user'), c.req.param('slug'), c.req.valid('json').repoUrl) }))
    .post('/:slug/fetch', async (c) => c.json({ project: await projects.fetch(c.req.param('slug'), c.get('user').id) }))
    .get('/:slug/commits', async (c) => c.json({ commits: await projects.commits(c.req.param('slug')) }))
    .get('/:slug/delete', async (c) => c.json({ check: await trash.check(c.get('user'), c.req.param('slug')) }))
    .post('/:slug/delete', json(Confirm), async (c) => c.json({ deleted: await trash.remove(c.get('user'), c.req.param('slug'), c.req.valid('json').confirm) }))
    .get('/:slug/activity', (c) => c.json({ activity: activity.list(projects.idOf(c.req.param('slug'))) }))
}
