// Team's one entry point: app.ts calls teamPlugin() and mounts its routes; nothing else in DevDash imports Team.
// DEVDASH_TEAM=0 switches it off on the whole server: no listeners, no tools, and the routes answer that it's off.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { authMiddleware } from '../auth/routes.ts'
import type { ClaudeService, SessionLabel, TurnEnd } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { TasksService } from '../tasks/service.ts'
import { registerTeamMcp } from './mcp.ts'
import { teamRoutes } from './routes.ts'
import { teamService } from './service.ts'

/** What a project's Claude page says about the roles' sessions: each role's chat, and its shifts. */
export function roleSessions(db: Db) {
  const q = db.prepare(`select r.chat_session_id as session_id, 'role' as kind, r.id, r.name from team_roles r
      where r.project_id = ?1 and r.chat_session_id is not null
    union all select sh.session_id, 'shift' as kind, r.id, r.name from team_shifts sh join team_roles r on r.id = sh.role_id
      where r.project_id = ?1 and sh.session_id is not null`)
  return (projectId: number): Map<string, SessionLabel> =>
    new Map((q.all(projectId) as { session_id: string; kind: 'role' | 'shift'; id: number; name: string }[])
      .map((r) => [r.session_id, { kind: r.kind, role: { id: r.id, name: r.name } }]))
}

export function teamPlugin(deps: {
  db: Db; hub: Hub; agents: AgentsService; claude: ClaudeService; projects: ProjectsService; activity: ActivityService; tasks: TasksService
  notify: (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>
  masterKey: Buffer
  mw: ReturnType<typeof authMiddleware>
  /** Reviews: an approved code proposal's session went quiet — check its branch for shippable work (Ready to review). */
  onProposalIdle?: (s: TurnEnd['session']) => void
}) {
  const on = process.env.DEVDASH_TEAM !== '0'
  // Even with Team off: they are still role sessions, not a person's.
  deps.claude.labelSessions(roleSessions(deps.db))
  const service = on ? teamService(deps) : null
  if (service) registerTeamMcp(deps.agents, service)
  return { service, routes: teamRoutes(service, deps.mw) }
}
