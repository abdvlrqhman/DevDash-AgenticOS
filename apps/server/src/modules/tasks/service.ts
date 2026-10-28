import { transaction, type Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { User } from '../auth/repo.ts'
import type { SearchService } from '../search/service.ts'

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export type Status = (typeof STATUSES)[number]
export type Priority = (typeof PRIORITIES)[number]
const STATUS_LABEL: Record<Status, string> = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' }

/** "fixes #12", "Closes #3, resolves #4" … in a commit message. */
export const CLOSES_RE = /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d+)\b/gi
export function closedNumbers(message: string) {
  return [...new Set([...message.matchAll(CLOSES_RE)].map((m) => Number(m[1])))]
}

type Row = {
  id: number; project_id: number; number: number; title: string; body: string; status: Status; priority: Priority; due_date: string | null
  assignee_id: number | null; sort: number; created_by: number; created_at: number; updated_at: number; closed_at: number | null
  via_role: string | null
  slug: string; project_name: string; assignee_name: string | null; assignee_username: string | null; creator_name: string
}
/** Who's acting: a person, or — when a team role does it through its session — that role (`role`), run on the member's account. */
export type Actor = { user: Pick<User, 'id' | 'name'>; viaClaude?: boolean; role?: string | null }

const SELECT = `select t.*, p.slug, p.name as project_name, a.name as assignee_name, a.username as assignee_username, c.name as creator_name
  from tasks t join projects p on p.id = t.project_id left join users a on a.id = t.assignee_id join users c on c.id = t.created_by`

export function tasksService({ db, hub, activity, search, threadOf, onClosed }: {
  db: Db; hub: Hub; activity: ActivityService; search: SearchService
  /** The team thread a task belongs to, if any (for "From thread #N"). Injected by the app; core never imports Team. */
  threadOf?: (taskId: number) => { id: number; title: string; status: 'open' | 'resolved' } | null
  /** Fired when a task becomes done, so Team can offer to close the thread it came from. Injected by the app. */
  onClosed?: (taskId: number) => void
}) {
  const q = {
    list: db.prepare(`${SELECT} where p.archived = 0 and (?1 is null or p.slug = ?1) and (?2 is null or t.assignee_id = ?2)
      and (?3 is null or t.status = ?3) and (?4 = 1 or t.status != 'done' or t.closed_at > unixepoch() - 14 * 86400)
      order by t.sort, t.id`),
    one: db.prepare(`${SELECT} where p.slug = ? and t.number = ?`),
    byId: db.prepare(`${SELECT} where t.id = ?`),
    project: db.prepare('select id, slug, name, archived from projects where slug = ?'),
    next: db.prepare('update projects set next_task = next_task + 1 where id = ? returning next_task - 1 as n'),
    maxSort: db.prepare('select coalesce(max(sort), 0) as s from tasks where project_id = ? and status = ?'),
    insert: db.prepare(`insert into tasks (project_id, number, title, body, status, priority, due_date, assignee_id, sort, created_by, via_role)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`),
    update: db.prepare(`update tasks set title = ?, body = ?, status = ?, priority = ?, due_date = ?, assignee_id = ?, sort = ?,
      closed_at = ?, updated_at = unixepoch() where id = ?`),
    comments: db.prepare(`select c.id, c.body, c.via_claude, c.via_role, c.created_at, u.name as user_name, u.id as user_id
      from task_comments c join users u on u.id = c.user_id where c.task_id = ? order by c.id`),
    comment: db.prepare('insert into task_comments (task_id, user_id, via_claude, via_role, body) values (?, ?, ?, ?, ?)'),
    links: db.prepare('select kind, ref, title, meta, created_at from task_links where task_id = ? order by created_at'),
    link: db.prepare('insert or ignore into task_links (task_id, kind, ref, title, meta) values (?, ?, ?, ?, ?)'),
    linkMeta: db.prepare("select meta from task_links where task_id = ? and kind = 'commit' and ref = ?"),
    setLinkMeta: db.prepare("update task_links set meta = ? where task_id = ? and kind = 'commit' and ref = ?"),
    userByEmail: db.prepare('select id from users where email = ? collate nocase'),
    member: db.prepare('select id from users where id = ? and disabled_at is null'),
  }
  const changed = (slug: string) => hub.publish('tasks', { type: 'changed', project: slug })

  const dto = (t: Row) => ({
    id: t.id, number: t.number, key: `${t.slug}#${t.number}`, title: t.title, body: t.body, status: t.status, priority: t.priority,
    due: t.due_date, sort: t.sort, createdAt: t.created_at, updatedAt: t.updated_at, closedAt: t.closed_at,
    project: { slug: t.slug, name: t.project_name },
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name!, username: t.assignee_username! } : null,
    creator: t.creator_name, creatorRole: t.via_role,
  })
  const url = (t: { slug: string; number: number }) => `/tasks/${t.slug}/${t.number}`

  function find(slug: string, number: number) {
    const t = q.one.get(slug, number) as Row | undefined
    if (!t) throw new AppError(404, 'not_found', `There is no task ${slug}#${number}.`)
    return t
  }
  function checkAssignee(id: number | null | undefined) {
    if (id && !q.member.get(id)) throw new AppError(400, 'bad_assignee', 'That person is not a member.')
  }

  const api = {
    list(f: { project?: string; assignee?: number; status?: Status; includeOldDone?: boolean }) {
      return (q.list.all(f.project ?? null, f.assignee ?? null, f.status ?? null, f.includeOldDone ? 1 : 0) as Row[]).map(dto)
    },

    get(slug: string, number: number) {
      const t = find(slug, number)
      return {
        ...dto(t),
        comments: (q.comments.all(t.id) as { id: number; body: string; via_claude: number; via_role: string | null; created_at: number; user_name: string; user_id: number }[])
          .map((c) => ({ id: c.id, body: c.body, viaClaude: c.via_claude === 1, role: c.via_role, at: c.created_at, user: { id: c.user_id, name: c.user_name } })),
        links: (q.links.all(t.id) as { kind: 'commit' | 'session'; ref: string; title: string; meta: string; created_at: number }[])
          .map((l) => ({ kind: l.kind, ref: l.ref, title: l.title, meta: l.meta, at: l.created_at })),
        thread: threadOf?.(t.id) ?? null,
      }
    },

    create(a: Actor, input: { project: string; title: string; body?: string; status?: Status; priority?: Priority; due?: string | null; assignee?: number | null }) {
      const p = q.project.get(input.project) as { id: number; slug: string; archived: number } | undefined
      if (!p || p.archived) throw new AppError(404, 'not_found', `There is no project ${input.project}.`)
      checkAssignee(input.assignee)
      const status = input.status ?? 'todo'
      const t = transaction(db, () => {
        const number = (q.next.get(p.id) as { n: number }).n
        const sort = (q.maxSort.get(p.id, status) as { s: number }).s + 1
        const { id } = q.insert.get(p.id, number, input.title.trim(), input.body ?? '', status, input.priority ?? 'none', input.due ?? null, input.assignee ?? null, sort, a.user.id, a.role ?? null) as { id: number }
        return q.byId.get(id) as Row
      })
      search.put('task', t.id, `${t.slug}#${t.number} ${t.title}`, t.body)
      activity.record({ projectId: p.id, userId: a.user.id, viaClaude: a.viaClaude, role: a.role, kind: 'task.created', summary: `created ${t.slug}#${t.number} ${t.title}`, url: url(t) })
      changed(p.slug)
      return dto(t)
    },

    update(a: Actor, slug: string, number: number, patch: { title?: string; body?: string; status?: Status; priority?: Priority; due?: string | null; assignee?: number | null; sort?: number }) {
      const t = find(slug, number)
      if (patch.assignee !== undefined) checkAssignee(patch.assignee)
      const status = patch.status ?? t.status
      // A move to another column without a position goes to the bottom of it.
      const sort = patch.sort ?? (status !== t.status ? (q.maxSort.get(t.project_id, status) as { s: number }).s + 1 : t.sort)
      const closedAt = status === 'done' ? (t.closed_at ?? Math.floor(Date.now() / 1000)) : null
      q.update.run(patch.title?.trim() ?? t.title, patch.body ?? t.body, status, patch.priority ?? t.priority,
        patch.due === undefined ? t.due_date : patch.due, patch.assignee === undefined ? t.assignee_id : patch.assignee, sort, closedAt, t.id)
      if (patch.title !== undefined || patch.body !== undefined) search.put('task', t.id, `${t.slug}#${t.number} ${patch.title ?? t.title}`, patch.body ?? t.body)
      if (status !== t.status) {
        activity.record({ projectId: t.project_id, userId: a.user.id, viaClaude: a.viaClaude, role: a.role, kind: 'task.status', summary: `moved ${t.slug}#${t.number} to ${STATUS_LABEL[status]}`, url: url(t) })
        if (status === 'done') onClosed?.(t.id)
      }
      changed(slug)
      return dto(q.byId.get(t.id) as Row)
    },

    comment(a: Actor, slug: string, number: number, body: string) {
      const t = find(slug, number)
      q.comment.run(t.id, a.user.id, a.viaClaude ? 1 : 0, a.role ?? null, body.trim())
      activity.record({ projectId: t.project_id, userId: a.user.id, viaClaude: a.viaClaude, role: a.role, kind: 'task.comment', summary: `commented on ${t.slug}#${t.number}`, url: url(t) })
      changed(slug)
      return api.get(slug, number)
    },

    linkSession(slug: string, number: number, sessionId: string, title: string) {
      const t = find(slug, number)
      q.link.run(t.id, 'session', sessionId, title, '')
      changed(slug)
    },

    /**
     * Commits that say "fixes #N": on the default branch the task is done, on any other branch it goes to review.
     * Each (task, commit) counts once, so rescans and the same commit on several branches change nothing.
     */
    fromCommits(project: { id: number; slug: string }, commits: { sha: string; email: string; subject: string; body: string }[], where: { onDefault: boolean; branch: string }) {
      let touched = false
      for (const c of [...commits].reverse()) { // oldest first
        for (const n of closedNumbers(`${c.subject}\n${c.body}`)) {
          const t = q.one.get(project.slug, n) as Row | undefined
          if (!t) continue
          // Once per commit on a branch, and once more if it reaches the default branch (a fast-forward merge keeps the sha).
          const seen = q.linkMeta.get(t.id, c.sha) as { meta: string } | undefined
          if (seen && (!where.onDefault || seen.meta.startsWith('default:'))) continue
          const meta = `${where.onDefault ? 'default:' : ''}${where.branch}`
          if (seen) q.setLinkMeta.run(meta, t.id, c.sha)
          else q.link.run(t.id, 'commit', c.sha, c.subject.slice(0, 200), meta)
          touched = true
          const target: Status | null = where.onDefault ? (t.status === 'done' ? null : 'done') : (t.status === 'review' || t.status === 'done' ? null : 'review')
          if (!target) continue
          const author = (q.userByEmail.get(c.email) as { id: number } | undefined)?.id ?? null
          q.update.run(t.title, t.body, target, t.priority, t.due_date, t.assignee_id, (q.maxSort.get(t.project_id, target) as { s: number }).s + 1,
            target === 'done' ? Math.floor(Date.now() / 1000) : null, t.id)
          if (target === 'done') onClosed?.(t.id)
          activity.record({
            projectId: project.id, userId: author, kind: 'task.closed_by_commit',
            summary: `${target === 'done' ? 'closed' : 'sent to review'} ${t.slug}#${t.number} with ${c.sha.slice(0, 7)} on ${where.branch}`, url: url(t),
          })
        }
      }
      if (touched) changed(project.slug)
    },
  }
  return api
}

export type TasksService = ReturnType<typeof tasksService>
