import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'

export type ActivityInput = { projectId: number | null; userId: number | null; viaClaude?: boolean; role?: string | null; kind: string; summary: string; url?: string }

/** The team's recent activity (Home and project pages). Private things (private notes) are never recorded. */
export function activityService({ db, hub }: { db: Db; hub: Hub }) {
  const q = {
    insert: db.prepare('insert into activity (project_id, user_id, via_claude, via_role, kind, summary, url) values (?, ?, ?, ?, ?, ?, ?)'),
    list: db.prepare(`select a.id, a.kind, a.summary, a.url, a.via_claude, a.via_role, a.created_at, u.name as user_name, p.slug as project_slug, p.name as project_name
      from activity a left join users u on u.id = a.user_id left join projects p on p.id = a.project_id
      where (?1 is null or a.project_id = ?1) order by a.created_at desc, a.id desc limit ?2`),
    prune: db.prepare('delete from activity where created_at < unixepoch() - 90 * 86400'),
  }
  setInterval(() => q.prune.run(), 24 * 3_600_000).unref()
  return {
    record(e: ActivityInput) {
      q.insert.run(e.projectId, e.userId, e.viaClaude ? 1 : 0, e.role ?? null, e.kind, e.summary.slice(0, 300), e.url ?? null)
      hub.publish('activity', { type: 'changed' })
    },
    list(projectId: number | null, limit = 40) {
      return (q.list.all(projectId, Math.min(200, limit)) as {
        id: number; kind: string; summary: string; url: string | null; via_claude: number; via_role: string | null; created_at: number
        user_name: string | null; project_slug: string | null; project_name: string | null
      }[]).map((a) => ({
        id: a.id, kind: a.kind, summary: a.summary, url: a.url, viaClaude: a.via_claude === 1, role: a.via_role, at: a.created_at,
        user: a.user_name, project: a.project_slug ? { slug: a.project_slug, name: a.project_name! } : null,
      }))
    },
  }
}

export type ActivityService = ReturnType<typeof activityService>
