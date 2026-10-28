import { Hono } from 'hono'
import { z } from 'zod'
import { query } from '../../core/http.ts'
import type { Db } from '../../core/db.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ClaudeService } from '../claude/service.ts'
import type { NotesService } from '../notes/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { ServicesService } from '../services/service.ts'
import type { SearchService } from './service.ts'

/** ⌘K: one query across projects, tasks, notes, Claude sessions and services, limited to what this member may see. */
export function searchRoutes(d: {
  db: Db; search: SearchService; notes: NotesService; projects: ProjectsService; claude: ClaudeService; services: ServicesService; activity: ActivityService
}, mw: ReturnType<typeof authMiddleware>) {
  const taskById = d.db.prepare(`select t.id, t.number, t.title, t.status, p.slug from tasks t join projects p on p.id = t.project_id where t.id = ?`)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/search', query(z.object({ q: z.string().max(200).default('') })), (c) => {
      const user = c.get('user')
      const text = c.req.valid('query').q.trim().slice(0, 100)
      if (!text) return c.json({ projects: [], tasks: [], notes: [], sessions: [], services: [] })
      const needle = text.toLowerCase()
      const hits = d.search.find(text)
      const snippet = new Map(hits.map((h) => [`${h.kind}:${h.ref}`, h.snippet]))
      const tasks = hits.filter((h) => h.kind === 'task').map((h) => taskById.get(Number(h.ref)) as { id: number; number: number; title: string; status: string; slug: string } | undefined)
        .filter((t) => !!t).slice(0, 12).map((t) => ({ key: `${t.slug}#${t.number}`, slug: t.slug, number: t.number, title: t.title, status: t.status, snippet: snippet.get(`task:${t.id}`) ?? '' }))
      // "app#12" or "#12" finds the task directly.
      const direct = text.match(/^([a-z0-9-]+)?#(\d+)$/)
      const notes = d.notes.visibleIds(user, hits.filter((h) => h.kind === 'note').map((h) => Number(h.ref))).slice(0, 10)
        .map((n) => ({ id: n.id, title: n.title, project: n.project, snippet: snippet.get(`note:${n.id}`) ?? '' }))
      return c.json({
        projects: d.projects.list(false, user.id).filter((p) => p.name.toLowerCase().includes(needle) || p.slug.includes(needle)).slice(0, 6),
        tasks: direct ? [...d.db.prepare(`select t.number, t.title, t.status, p.slug from tasks t join projects p on p.id = t.project_id where t.number = ? and (? is null or p.slug = ?) limit 6`)
          .all(Number(direct[2]), direct[1] ?? null, direct[1] ?? null).map((t) => {
            const r = t as { number: number; title: string; status: string; slug: string }
            return { key: `${r.slug}#${r.number}`, slug: r.slug, number: r.number, title: r.title, status: r.status, snippet: '' }
          }), ...tasks] : tasks,
        notes,
        sessions: d.claude.list(user, false).filter((s) => s.title.toLowerCase().includes(needle)).slice(0, 8).map((s) => ({ id: s.id, title: s.title, status: s.status })),
        services: d.services.list(user).filter((s) => s.name.includes(needle)).slice(0, 6).map((s) => ({ name: s.name, port: s.port, state: s.state })),
      })
    })
    .get('/activity', (c) => c.json({ activity: d.activity.list(null) }))
}
