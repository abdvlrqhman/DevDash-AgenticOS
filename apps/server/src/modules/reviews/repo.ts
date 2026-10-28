import type { Db } from '../../core/db.ts'

export type DeliveryStatus = 'ready' | 'opened' | 'merged' | 'dismissed'
export type DeliveryRow = {
  id: number; project_id: number; session_id: string; role: string; title: string; branch: string; base_branch: string
  commits: number; files: number; insertions: number; deletions: number; status: DeliveryStatus; pr_url: string | null
  merged_commit: string | null; merged_at: number | null; created_at: number; updated_at: number
}
export type Stats = { commits: number; files: number; insertions: number; deletions: number }

const MERGED_SHOWN_FOR = 7 * 86_400 // a just-shipped delivery lingers a week so "View PR ↗" stays within reach

export function reviewsRepo(db: Db) {
  const s = {
    bySession: db.prepare('select * from code_deliveries where session_id = ?'),
    byId: db.prepare('select * from code_deliveries where id = ?'),
    insert: db.prepare(`insert into code_deliveries (project_id, session_id, role, title, branch, base_branch, commits, files, insertions, deletions)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`),
    updateStats: db.prepare('update code_deliveries set commits = ?, files = ?, insertions = ?, deletions = ?, updated_at = unixepoch() where id = ?'),
    setStatus: db.prepare('update code_deliveries set status = ?, pr_url = coalesce(?, pr_url), updated_at = unixepoch() where id = ?'),
    markMerged: db.prepare(`update code_deliveries set status = 'merged', merged_commit = ?, merged_at = ?, updated_at = unixepoch() where id = ?`),
    // Cards still in play, whose branch could have landed in the default branch since: ready or an opened PR.
    liveByProject: db.prepare(`select * from code_deliveries where project_id = ? and status in ('ready', 'opened')`),
    byBranch: db.prepare('select * from code_deliveries where project_id = ? and branch = ?'),
    // Non-dismissed, with merged ones falling off after a week; newest first.
    list: db.prepare(`select * from code_deliveries where project_id = ?1
      and (status in ('ready', 'opened') or (status = 'merged' and updated_at > unixepoch() - ?2))
      order by (status = 'ready') desc, updated_at desc`),
    readyCount: db.prepare(`select count(*) as n from code_deliveries where project_id = ? and status = 'ready'`),
  }
  return {
    bySession: (sessionId: string) => s.bySession.get(sessionId) as DeliveryRow | undefined,
    byId: (id: number) => s.byId.get(id) as DeliveryRow | undefined,
    insert: (r: { projectId: number; sessionId: string; role: string; title: string; branch: string; baseBranch: string } & Stats) =>
      Number((s.insert.get(r.projectId, r.sessionId, r.role, r.title, r.branch, r.baseBranch, r.commits, r.files, r.insertions, r.deletions) as { id: number }).id),
    updateStats: (id: number, st: Stats) => void s.updateStats.run(st.commits, st.files, st.insertions, st.deletions, id),
    setStatus: (id: number, status: DeliveryStatus, prUrl: string | null = null) => void s.setStatus.run(status, prUrl, id),
    markMerged: (id: number, commit: string | null, mergedAt: number) => void s.markMerged.run(commit, mergedAt, id),
    liveByProject: (projectId: number) => s.liveByProject.all(projectId) as DeliveryRow[],
    byBranch: (projectId: number, branch: string) => s.byBranch.get(projectId, branch) as DeliveryRow | undefined,
    list: (projectId: number) => s.list.all(projectId, MERGED_SHOWN_FOR) as DeliveryRow[],
    readyCount: (projectId: number) => (s.readyCount.get(projectId) as { n: number }).n,
  }
}
