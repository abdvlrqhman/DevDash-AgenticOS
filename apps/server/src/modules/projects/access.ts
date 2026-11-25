import type { Db } from '../../core/db.ts'

// Who may see a project, its tasks, notes, sessions and team: everyone for a team project; for a private one, its
// creator, the members it's shared with, and whoever one of its sessions was shared with by name. Nobody else, admins
// included, sees that it exists. One rule, asked everywhere. (Its folders open to its creator and members only.)

/** SQL: whether member `who` (an expression) may see project alias `p`. */
export const seesSql = (p: string, who: string) =>
  `(${p}.visibility = 'team' or ${p}.created_by = ${who} or exists (select 1 from project_members pm where pm.project_id = ${p}.id and pm.user_id = ${who})
    or exists (select 1 from claude_session_viewers sv join claude_sessions ss on ss.id = sv.session_id where ss.project_id = ${p}.id and sv.user_id = ${who}))`

export function projectAccess(db: Db) {
  const q = {
    sees: db.prepare(`select 1 from projects p where p.id = ?1 and ${seesSql('p', '?2')}`),
    id: db.prepare('select id from projects where slug = ?'),
    visible: db.prepare(`select p.id from projects p where ${seesSql('p', '?1')}`),
    audience: db.prepare(`select u.id from users u join projects p on p.id = ?1 where u.disabled_at is null and ${seesSql('p', 'u.id')} order by u.id`),
    members: db.prepare('select u.id, u.username, u.name from project_members m join users u on u.id = m.user_id where m.project_id = ? and u.disabled_at is null order by u.name'),
    viewers: db.prepare(`select distinct u.id, u.username, u.name from claude_session_viewers v join claude_sessions s on s.id = v.session_id join users u on u.id = v.user_id
      where s.project_id = ?1 and u.disabled_at is null and u.id != (select created_by from projects where id = ?1)
      and u.id not in (select user_id from project_members where project_id = ?1) order by u.name`),
  }
  const sees = (userId: number, projectId: number | null | undefined) => projectId == null || !!q.sees.get(projectId, userId)
  return {
    sees,
    /** An unknown short name is "seen": the route itself says it doesn't exist, the same way for everyone. */
    seesSlug: (userId: number, slug: string) => {
      const p = q.id.get(slug) as { id: number } | undefined
      return !p || sees(userId, p.id)
    },
    visibleIds: (userId: number) => new Set((q.visible.all(userId) as { id: number }[]).map((r) => r.id)),
    /** Who a project's news is for: everyone on the team, or a private project's creator and members. */
    audience: (projectId: number | null | undefined): number[] | null => (projectId == null ? null : (q.audience.all(projectId) as { id: number }[]).map((r) => r.id)),
    members: (projectId: number) => q.members.all(projectId) as { id: number; username: string; name: string }[],
    /** Who sees it only because one of its sessions was shared with them by name. */
    viewers: (projectId: number) => q.viewers.all(projectId) as { id: number; username: string; name: string }[],
  }
}
export type ProjectAccess = ReturnType<typeof projectAccess>
