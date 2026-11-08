import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService } from '../claude/service.ts'
import type { SearchService } from '../search/service.ts'
import type { ServicesService } from '../services/service.ts'
import type { ProjectRow, ProjectsService } from './service.ts'

/** How long a deleted project can be restored before the janitor purges it. */
export const KEEP_MS = 7 * 24 * 3_600_000
const SWEEP_EVERY_MS = 3_600_000

/** Moves a project's folders (its checkout and its session worktrees) into the trash and back, through the root helper. */
export type Folders = {
  trash: (id: number, slug: string) => Promise<void>
  restore: (id: number, slug: string) => Promise<void>
  purge: (id: number, slug: string) => Promise<void>
}

type Risks = {
  changes: number | null
  worktrees: { path: string; branch: string | null; changes: number | null }[]
  remote: boolean
  unpushed: { branch: string; commits: number }[] | null
}

/**
 * Deleting a project, with seven days to change your mind. Almost everything hangs off the project row with
 * `on delete cascade` (tasks, notes' links, builds, the team), so deleting is soft: the project is hidden everywhere and
 * its folders wait in /srv/devdash/trash; Restore puts both back, and the purge (by hand, or after seven days) removes
 * the folders and the row. Its sessions are stopped and archived (they stay readable), the services running from its
 * folders are stopped and removed. The GitHub repository is never touched.
 *
 * Only whoever added the project may delete, restore or purge it; an admin only once that person's account is disabled.
 */
export function projectTrash({ db, projects, claude, services, agents, activity, search, folders, root }: {
  db: Db; projects: ProjectsService; claude: Pick<ClaudeService, 'inProjectFolders' | 'stopAndArchive'>
  services: Pick<ServicesService, 'inFolders' | 'removeForProject'>; agents: Pick<AgentsService, 'request'>
  activity: ActivityService; search: Pick<SearchService, 'remove'>; folders: Folders; root: string
}) {
  const q = {
    openTasks: db.prepare("select count(*) as n from tasks where project_id = ? and status != 'done'"),
    notes: db.prepare('select id from notes where project_id = ?'),
    dropNote: db.prepare('delete from notes where id = ?'),
    tasks: db.prepare('select id from tasks where project_id = ?'),
  }
  const busy = new Set<string>()
  const foldersOf = (slug: string) => [projects.path(slug), `${root}/worktrees/${slug}`]

  function allowed(user: Pick<User, 'id' | 'role'>, p: ProjectRow) {
    if (projects.canDelete(user, p)) return
    throw new AppError(403, 'forbidden', p.creator_disabled_at === null
      ? `Only ${p.creator_name}, who added it, can delete ${p.name}.`
      : `Only ${p.creator_name}, who added it, or an admin can delete ${p.name}.`)
  }
  function confirmed(p: ProjectRow, confirm: string) {
    if (confirm.trim() !== p.slug) throw new AppError(400, 'confirm', `Type ${p.slug} to confirm.`)
  }
  async function once<T>(slug: string, fn: () => Promise<T>) {
    if (busy.has(slug)) throw new AppError(409, 'busy', `${slug} is already being deleted or restored.`)
    busy.add(slug)
    try { return await fn() } finally { busy.delete(slug) }
  }

  async function purge(p: ProjectRow, by: Pick<User, 'id'> | null) {
    await folders.purge(p.id, p.slug)
    // Notes would outlive the row (on delete set null) and turn up again unlinked: they go with their project.
    for (const { id } of q.notes.all(p.id) as { id: number }[]) { q.dropNote.run(id); search.remove('note', id) }
    for (const { id } of q.tasks.all(p.id) as { id: number }[]) search.remove('task', id)
    projects.purgeRow(p)
    activity.record({ projectId: null, userId: by?.id ?? null, kind: 'project.purged', url: '/projects',
      summary: by ? `deleted project ${p.name} for good` : `removed project ${p.name} for good, seven days after it was deleted` })
  }

  const api = {
    /** What deleting it would affect, checked now, for the dialog. */
    async check(user: User, slug: string) {
      const p = projects.live(slug)
      allowed(user, p)
      const dirs = foldersOf(slug)
      const sessions = claude.inProjectFolders(p.id, dirs)
      const git = await agents.request<Risks>(user.username, { op: 'git.risks', path: projects.path(slug) }, 60_000)
        .then((r) => ({ ...r, error: null as string | null }), (err: Error) => ({ changes: null, worktrees: [], remote: !!p.repo_url, unpushed: null, error: err.message }))
      return {
        slug: p.slug, name: p.name, repoUrl: p.repo_url, keepDays: KEEP_MS / 86_400_000,
        git,
        sessions: {
          total: sessions.length,
          live: sessions.filter((s) => s.status === 'working' || s.status === 'waiting').map((s) => ({ id: s.id, title: s.title, status: s.status, owner: s.owner_name })),
        },
        services: services.inFolders(dirs).map(({ name, owner, state }) => ({ name, owner, state })),
        openTasks: (q.openTasks.get(p.id) as { n: number }).n,
        notes: (q.notes.all(p.id) as unknown[]).length,
      }
    },

    async remove(user: User, slug: string, confirm: string) {
      const p = projects.live(slug)
      allowed(user, p)
      confirmed(p, confirm)
      return once(slug, async () => {
        const dirs = foldersOf(slug)
        await claude.stopAndArchive(claude.inProjectFolders(p.id, dirs))
        for (const s of services.inFolders(dirs)) await services.removeForProject(s.name)
        await folders.trash(p.id, slug)
        projects.markDeleted(p, user)
        activity.record({ projectId: null, userId: user.id, kind: 'project.deleted', summary: `deleted project ${p.name} (it can be restored for 7 days)`, url: '/projects' })
        return { slug, purgeAt: Math.floor(Date.now() / 1000) + KEEP_MS / 1000 }
      })
    },

    /** Recently deleted: the ones this member may restore or purge. */
    deleted(user: Pick<User, 'id' | 'role'>) {
      return projects.deletedRows().filter((p) => projects.canDelete(user, p)).map((p) => ({
        slug: p.slug, name: p.name, repoUrl: p.repo_url, deletedAt: p.deleted_at!, purgeAt: p.deleted_at! + KEEP_MS / 1000,
        creator: { name: p.creator_name },
      }))
    },

    async restore(user: User, slug: string) {
      const p = projects.trashed(slug)
      allowed(user, p)
      return once(slug, async () => {
        await folders.restore(p.id, slug)
        projects.markRestored(p)
        activity.record({ projectId: p.id, userId: user.id, kind: 'project.restored', summary: `restored project ${p.name}`, url: `/projects/${slug}` })
        return projects.get(slug, user.id)
      })
    },

    async purge(user: User, slug: string, confirm: string) {
      const p = projects.trashed(slug)
      allowed(user, p)
      confirmed(p, confirm)
      await once(slug, () => purge(p, user))
    },

    /** Purges what was deleted more than seven days ago. */
    async sweep(now = Date.now()) {
      for (const p of projects.deletedRows()) {
        if ((p.deleted_at! * 1000) + KEEP_MS > now || busy.has(p.slug)) continue
        await once(p.slug, () => purge(p, null)).catch((err) => console.error(`purge ${p.slug}:`, (err as Error).message))
      }
    },

    start() {
      setTimeout(() => void api.sweep(), 60_000).unref()
      setInterval(() => void api.sweep(), SWEEP_EVERY_MS).unref()
    },
  }
  return api
}

export type ProjectTrash = ReturnType<typeof projectTrash>
