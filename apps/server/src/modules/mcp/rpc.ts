import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { NotesService } from '../notes/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { ServicesService } from '../services/service.ts'
import type { Priority, Status, TasksService } from '../tasks/service.ts'

type Ctx = { sessionId: string | null; cwd: string; args: Record<string, unknown> }

/**
 * The DevDash tools Claude gets (packages/claude-plugin/mcp/devdash.mjs), called through the member's own agent.
 * Everything acts as that member and is marked "via Claude". The project comes from the argument, else the
 * session's project, else the folder Claude runs in.
 */
export function registerMcp({ db, agents, projects, tasks, notes, services, authorRole }: {
  db: Db; agents: AgentsService; projects: ProjectsService; tasks: TasksService; notes: NotesService; services: ServicesService
  /** When the calling session belongs to a team role, its name — so items it creates are attributed to the role, not the
   *  account the team runs as. Injected by the app (Team is optional, so core never imports it). */
  authorRole?: (username: string, sessionId: string | null) => string | null
}) {
  const q = {
    user: db.prepare("select id, username, name, email, role from users where username = ? and disabled_at is null"),
    sessionProject: db.prepare('select p.slug from claude_sessions s join projects p on p.id = s.project_id where s.id = ? and s.owner_id = ?'),
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const int = (v: unknown, what: string) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'bad_args', `${what} must be a positive whole number.`)
    return n
  }

  function context(username: string, params: unknown) {
    const c = (params ?? {}) as Ctx
    const user = q.user.get(username) as User | undefined
    if (!user) throw new AppError(403, 'forbidden', 'Unknown member.')
    const args = (c.args ?? {}) as Record<string, unknown>
    const slug = str(args.project)
      ?? (c.sessionId ? (q.sessionProject.get(c.sessionId, user.id) as { slug: string } | undefined)?.slug : undefined)
      ?? (typeof c.cwd === 'string' ? projects.forPath(c.cwd)?.slug : undefined)
    const need = () => {
      if (!slug) throw new AppError(400, 'no_project', `This session isn't in a DevDash project. Pass "project" (one of: ${projects.list().map((p) => p.slug).join(', ') || 'none yet'}).`)
      return slug
    }
    return { user, args, slug, need, actor: { user, viaClaude: true, role: authorRole?.(username, c.sessionId) ?? null } }
  }
  const on = (name: string, fn: (c: ReturnType<typeof context>) => unknown) => agents.onRpc(`mcp.${name}`, (username, params) => fn(context(username, params)))
  const brief = (t: ReturnType<TasksService['list']>[number]) => ({
    key: t.key, number: t.number, title: t.title, status: t.status, priority: t.priority, due: t.due, assignee: t.assignee?.name ?? null,
  })

  on('project_info', (c) => ({
    project: c.slug ? projects.get(c.slug, c.user.id) : null,
    projects: projects.list().map((p) => ({ slug: p.slug, name: p.name, openTasks: p.openTasks })),
  }))
  on('tasks_list', (c) => {
    const status = str(c.args.status) as Status | undefined
    return tasks.list({ project: c.slug, assignee: c.args.mine ? c.user.id : undefined })
      .filter((t) => !status || t.status === status).map(brief)
  })
  on('task_get', (c) => tasks.get(c.need(), int(c.args.number, 'number')))
  on('task_create', (c) => brief(tasks.create(c.actor, {
    project: c.need(), title: str(c.args.title) ?? '', body: str(c.args.body), status: str(c.args.status) as Status | undefined,
    priority: str(c.args.priority) as Priority | undefined, due: str(c.args.due) ?? null,
  })))
  on('task_update', (c) => brief(tasks.update(c.actor, c.need(), int(c.args.number, 'number'), {
    status: str(c.args.status) as Status | undefined, priority: str(c.args.priority) as Priority | undefined,
    due: c.args.due === null ? null : str(c.args.due), title: str(c.args.title), body: typeof c.args.body === 'string' ? c.args.body : undefined,
    assignee: c.args.assign_to_me ? c.user.id : undefined,
  })))
  on('task_comment', (c) => {
    const body = str(c.args.body)
    if (!body) throw new AppError(400, 'bad_args', 'Write something in body.')
    tasks.comment(c.actor, c.need(), int(c.args.number, 'number'), body)
    return 'Comment added.'
  })
  on('notes_list', (c) => notes.list(c.user, c.args.all_projects ? undefined : c.slug).map((n) => ({
    id: n.id, title: n.title, project: n.project?.slug ?? null, pinned: n.pinned, updatedAt: n.updatedAt, excerpt: n.body.slice(0, 200),
  })))
  on('note_get', (c) => notes.get(c.user, int(c.args.id, 'id')))
  on('note_upsert', (c) => {
    const fields = { title: str(c.args.title), body: typeof c.args.body === 'string' ? c.args.body : undefined, project: str(c.args.project) ?? c.slug ?? null, pinned: typeof c.args.pinned === 'boolean' ? c.args.pinned : undefined }
    if (c.args.id !== undefined) return notes.update(c.actor, int(c.args.id, 'id'), { ...fields, project: str(c.args.project) })
    if (!fields.title) throw new AppError(400, 'bad_args', 'A new note needs a title.')
    return notes.create(c.actor, { ...fields, title: fields.title })
  })
  on('services_list', (c) => services.list(c.user).map((s) => ({
    name: s.name, port: s.port, state: s.state, listening: s.listening, owner: s.owner.username, command: s.command, folder: s.cwd, session: s.session?.title ?? null,
  })))
}
