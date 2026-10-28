import type { Db } from '../../core/db.ts'

export type RoleRow = {
  id: number; project_id: number; name: string; summary: string; instructions: string; model: string | null
  chat_session_id: string | null; created_at: number; updated_at: number; archived: number
  autonomy: 'advisor' | 'operator'; auto_approve: string; schedule: string; triggers: string; schedule_state: string
  paused: number; daily_limit: number; monthly_budget: number | null; last_triggered: number; lead: number
  self_close: 'default' | 'always_ask' | 'allow'
}
export type SelfClose = RoleRow['self_close']
export type ShiftRow = {
  id: number; role_id: number; session_id: string | null; trigger: string; status: 'running' | 'done' | 'error'
  report: string | null; started_at: number; ended_at: number | null; cost_usd: number; thread_id: number | null
}
export type ProposalKind = 'task' | 'code' | 'goal' | 'other' | 'close'
export type ProposalRow = {
  id: number; project_id: number; role_id: number; kind: ProposalKind; title: string; why: string; payload: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'done'; reply: string | null; outcome: string | null
  decided_by: number | null; decided_at: number | null; created_at: number; expires_at: number; thread_id: number | null
  awaiting: 'people' | 'lead'; decided_by_role: number | null
  role_name: string; project_slug: string; project_name: string; decided_by_name: string | null; decided_by_role_name: string | null
}
export type GoalRow = {
  id: number; project_id: number; title: string; measure: string; due: string | null; status: 'active' | 'done' | 'dropped'
  progress: number; note: string | null; owner_role_id: number | null; owner_name: string | null; updated_at: number
}
export type ThreadRow = {
  id: number; project_id: number; title: string; owner_role_id: number | null; status: 'open' | 'resolved'; needs_people: number
  opened_by: string; resolution: string | null; created_at: number; updated_at: number; resolved_at: number | null
  closed_as: CloseAs | null; closed_by: string | null; ask: string | null; priority: 'normal' | 'blocker'
  owner_name: string | null; messages: number; last_at: number | null
}
/** How a thread was closed: done by its owner, or declined by a role in it (with a reason). */
export const CLOSE_AS = ['done', 'declined', 'duplicate', 'not_needed', 'elsewhere'] as const
export type CloseAs = typeof CLOSE_AS[number]
export type ThreadFilter = { status: 'open' | 'waiting' | 'closed' | 'all'; outcome?: CloseAs; role?: number; q?: string }
export type MessageKind = 'fyi' | 'question' | 'request' | 'alert' | 'reply'
export type MessageRow = {
  id: number; thread_id: number; kind: MessageKind; body: string; evidence: string | null
  author_user_id: number | null; author_role_id: number | null; author_session_id: string | null; author_label: string; created_at: number
}
export type SourceRow = {
  id: number; project_id: number; name: string; kind: 'postgres' | 'sqlite' | 'http' | 'page'; description: string
  config: string; secret: string | null; created_at: number
}
export type RoleSettings = {
  autonomy: 'advisor' | 'operator'; autoApprove: string[]; schedule: unknown[]; triggers: string[]
  paused: boolean; dailyLimit: number; monthlyBudget: number | null; selfClose: SelfClose
}

// node:sqlite rows have no prototype; plain objects compare and serialize like any other.
const plain = <T>(r: unknown) => (r ? ({ ...(r as object) } as T) : undefined)
const all = <T>(rows: unknown[]) => rows.map((r) => ({ ...(r as object) }) as T)

export function teamRepo(db: Db) {
  const s = {
    project: db.prepare(`select t.project_id, t.runs_as, t.enabled_at, t.paused, t.tz, t.activity_seen, t.priorities, t.close_guard, u.username, u.name
      from team_projects t join users u on u.id = t.runs_as where t.project_id = ?`),
    setCloseGuard: db.prepare(`update team_projects set close_guard = ? where project_id = ?`),
    projects: db.prepare(`select t.project_id, t.paused, t.tz, t.activity_seen, p.slug from team_projects t join projects p on p.id = t.project_id
      where p.archived = 0`),
    projectSettings: db.prepare(`update team_projects set paused = coalesce(?, paused), tz = coalesce(?, tz) where project_id = ?`),
    activitySeen: db.prepare(`update team_projects set activity_seen = ? where project_id = ?`),
    newActivity: db.prepare(`select id, kind, summary, via_claude from activity where project_id = ? and id > ? order by id limit 200`),
    lastActivity: db.prepare(`select coalesce(max(id), 0) as id from activity`),
    roleSettings: db.prepare(`update team_roles set autonomy = ?, auto_approve = ?, schedule = ?, triggers = ?, paused = ?, daily_limit = ?,
      monthly_budget = ?, self_close = ?, updated_at = unixepoch() where id = ?`),
    scheduleState: db.prepare(`update team_roles set schedule_state = ? where id = ?`),
    triggered: db.prepare(`update team_roles set last_triggered = ? where id = ?`),
    autoShiftsSince: db.prepare(`select count(*) as n from team_shifts where role_id = ? and trigger != 'manual' and started_at >= ?`),
    costSince: db.prepare(`select coalesce(sum(cost_usd), 0) as usd from team_shifts where role_id = ? and started_at >= ?`),
    shiftCost: db.prepare(`update team_shifts set cost_usd = cost_usd + ? where id = ?`),
    proposals: db.prepare(`select x.*, r.name as role_name, p.slug as project_slug, p.name as project_name, u.name as decided_by_name, lr.name as decided_by_role_name
      from team_proposals x join team_roles r on r.id = x.role_id join projects p on p.id = x.project_id
      left join users u on u.id = x.decided_by left join team_roles lr on lr.id = x.decided_by_role
      where (?1 is null or x.project_id = ?1) and (case when ?2 = 'pending' then x.status = 'pending' else x.status != 'pending' end)
      and (?4 is null or x.awaiting = ?4)
      order by x.id desc limit ?3`),
    proposal: db.prepare(`select x.*, r.name as role_name, p.slug as project_slug, p.name as project_name, u.name as decided_by_name, lr.name as decided_by_role_name
      from team_proposals x join team_roles r on r.id = x.role_id join projects p on p.id = x.project_id
      left join users u on u.id = x.decided_by left join team_roles lr on lr.id = x.decided_by_role
      where x.id = ?`),
    // People's badge: only proposals awaiting a person, not ones the lead can clear.
    pendingCount: db.prepare(`select count(*) as n from team_proposals x join projects p on p.id = x.project_id where x.status = 'pending' and x.awaiting = 'people' and p.archived = 0`),
    // Projects that have proposals a person must see: pending (awaiting people) or already decided. Pending first, then recent.
    proposalProjects: db.prepare(`select p.id as project_id, p.slug, p.name,
      count(*) filter (where x.status = 'pending' and x.awaiting = 'people') as pending,
      count(*) filter (where x.status != 'pending') as decided,
      count(*) filter (where x.status != 'pending' and x.decided_by_role is not null) as cleared,
      max(x.created_at) as last_at
      from team_proposals x join projects p on p.id = x.project_id where p.archived = 0
      group by p.id, p.slug, p.name having pending > 0 or decided > 0 order by pending desc, last_at desc`),
    // The distinct roles with a proposal awaiting a person, per project (for the avatars on each project's card).
    proposalRoles: db.prepare(`select distinct x.project_id, r.id, r.name from team_proposals x join team_roles r on r.id = x.role_id
      join projects p on p.id = x.project_id where x.status = 'pending' and x.awaiting = 'people' and p.archived = 0 order by r.id`),
    insertProposal: db.prepare(`insert into team_proposals (project_id, role_id, kind, title, why, payload, expires_at, awaiting) values (?, ?, ?, ?, ?, ?, ?, ?) returning id`),
    setProposalAwaiting: db.prepare(`update team_proposals set awaiting = ? where id = ?`),
    decide: db.prepare(`update team_proposals set status = ?, reply = ?, outcome = ?, decided_by = ?, decided_by_role = ?, decided_at = unixepoch() where id = ? and status = 'pending'`),
    expire: db.prepare(`update team_proposals set status = 'expired', decided_at = unixepoch() where status = 'pending' and expires_at < ? returning id, role_id, title`),
    goals: db.prepare(`select g.*, r.name as owner_name from team_goals g left join team_roles r on r.id = g.owner_role_id
      where g.project_id = ? and (g.status = 'active' or g.updated_at > unixepoch() - 14 * 86400) order by g.status = 'active' desc, g.due is null, g.due, g.id`),
    goal: db.prepare(`select g.*, r.name as owner_name from team_goals g left join team_roles r on r.id = g.owner_role_id where g.id = ?`),
    insertGoal: db.prepare(`insert into team_goals (project_id, title, measure, due, owner_role_id) values (?, ?, ?, ?, ?) returning id`),
    updateGoal: db.prepare(`update team_goals set status = coalesce(?, status), progress = coalesce(?, progress), note = coalesce(?, note),
      updated_at = unixepoch() where id = ?`),
    editGoal: db.prepare(`update team_goals set title = ?, measure = ?, due = ?, status = ?, progress = ?, note = ?, updated_at = unixepoch() where id = ?`),
    setLead: db.prepare(`update team_roles set lead = (id = ?) where project_id = ?`),
    unsetLead: db.prepare(`update team_roles set lead = 0 where id = ?`),
    lead: db.prepare(`select * from team_roles where project_id = ? and lead = 1 and archived = 0`),
    threads: db.prepare(`select t.*, r.name as owner_name, (select count(*) from team_messages m where m.thread_id = t.id) as messages,
      (select max(created_at) from team_messages m where m.thread_id = t.id) as last_at
      from team_threads t left join team_roles r on r.id = t.owner_role_id
      where t.project_id = ?1 and (t.status = 'open' or t.updated_at > unixepoch() - 7 * 86400)
      order by t.status = 'open' desc, t.priority = 'blocker' desc, t.updated_at desc limit ?2`),
    thread: db.prepare(`select t.*, r.name as owner_name, (select count(*) from team_messages m where m.thread_id = t.id) as messages,
      (select max(created_at) from team_messages m where m.thread_id = t.id) as last_at
      from team_threads t left join team_roles r on r.id = t.owner_role_id where t.id = ?`),
    // Everything in a project, people's list: waiting for people first, then open, then closed, each newest first.
    threadList: db.prepare(`select t.*, r.name as owner_name, (select count(*) from team_messages m where m.thread_id = t.id) as messages,
      (select max(created_at) from team_messages m where m.thread_id = t.id) as last_at
      from team_threads t left join team_roles r on r.id = t.owner_role_id
      where t.project_id = ?1 and (case ?2 when 'open' then t.status = 'open' when 'waiting' then t.status = 'open' and t.needs_people = 1
        when 'closed' then t.status = 'resolved' else 1 end)
      and (?3 is null or t.closed_as = ?3)
      and (?4 is null or t.owner_role_id = ?4 or exists (select 1 from team_thread_roles tr where tr.thread_id = t.id and tr.role_id = ?4))
      and (?5 is null or instr(lower(t.title), lower(?5)) > 0)
      order by case when t.status = 'resolved' then 2 when t.priority = 'blocker' then -1 when t.needs_people then 0 else 1 end, t.updated_at desc, t.id desc limit ?6 offset ?7`),
    threadCounts: db.prepare(`select count(*) filter (where status = 'open') as open, count(*) filter (where status = 'open' and needs_people = 1) as waiting,
      count(*) filter (where status = 'resolved') as closed, count(*) as "all" from team_threads where project_id = ?`),
    openByTitle: db.prepare(`select id from team_threads where project_id = ? and status = 'open' and lower(trim(title)) = lower(trim(?))`),
    insertThread: db.prepare(`insert into team_threads (project_id, title, owner_role_id, opened_by) values (?, ?, ?, ?) returning id`),
    touchThread: db.prepare(`update team_threads set updated_at = unixepoch() where id = ?`),
    threadState: db.prepare(`update team_threads set status = ?1, resolution = ?2, resolved_at = case when ?1 = 'resolved' then unixepoch() else null end,
      needs_people = case when ?1 = 'open' then 0 else needs_people end, closed_as = ?3, closed_by = ?4, updated_at = unixepoch() where id = ?5`),
    needsPeople: db.prepare(`update team_threads set needs_people = ? where id = ?`),
    setThreadAsk: db.prepare(`update team_threads set ask = ? where id = ?`),
    setThreadPriority: db.prepare(`update team_threads set priority = ? where id = ?`),
    threadRoles: db.prepare(`select r.id, r.name, tr.seen from team_thread_roles tr join team_roles r on r.id = tr.role_id where tr.thread_id = ?`),
    addThreadRole: db.prepare(`insert or ignore into team_thread_roles (thread_id, role_id) values (?, ?)`),
    seen: db.prepare(`update team_thread_roles set seen = ? where thread_id = ? and role_id = ?`),
    roleThreads: db.prepare(`select t.id, t.title, t.status, t.needs_people, t.priority, t.owner_role_id, tr.seen,
      (select max(id) from team_messages m where m.thread_id = t.id) as last_id
      from team_thread_roles tr join team_threads t on t.id = tr.thread_id where tr.role_id = ? and t.status = 'open'
      order by t.priority = 'blocker' desc, t.updated_at desc`),
    roleClosed: db.prepare(`select t.id, t.title, t.closed_as, t.closed_by, t.resolution from team_thread_roles tr join team_threads t on t.id = tr.thread_id
      where tr.role_id = ? and t.status = 'resolved' and t.resolved_at >= ? order by t.resolved_at desc limit 20`),
    messages: db.prepare(`select * from team_messages where thread_id = ? order by id`),
    insertMessage: db.prepare(`insert into team_messages (thread_id, kind, body, evidence, author_user_id, author_role_id, author_session_id, author_label)
      values (?, ?, ?, ?, ?, ?, ?, ?) returning id`),
    rolesSincePerson: db.prepare(`select count(*) as n from team_messages where thread_id = ?1 and author_role_id is not null
      and id > coalesce((select max(id) from team_messages where thread_id = ?1 and author_user_id is not null), 0)`),
    alertsToday: db.prepare(`select count(*) as n from team_messages where kind = 'alert' and author_label = ? and created_at >= ?`),
    threadProposals: db.prepare(`select x.*, r.name as role_name, p.slug as project_slug, p.name as project_name, u.name as decided_by_name, lr.name as decided_by_role_name
      from team_proposals x join team_roles r on r.id = x.role_id join projects p on p.id = x.project_id
      left join users u on u.id = x.decided_by left join team_roles lr on lr.id = x.decided_by_role
      where x.thread_id = ? order by x.id`),
    setProposalThread: db.prepare(`update team_proposals set thread_id = ? where id = ?`),
    shiftThread: db.prepare(`update team_shifts set thread_id = ? where id = ?`),
    pendingCloses: db.prepare(`select id, payload from team_proposals where project_id = ? and kind = 'close' and status = 'pending'`),
    // The code proposal whose approval started a session (its outcome links /claude/<id>), to note the merge of its branch.
    proposalBySession: db.prepare(`select id, role_id, project_id, thread_id, title from team_proposals
      where kind = 'code' and outcome like '%/claude/' || ? || ')%' order by id desc limit 1`),
    // One job per object: a task belongs to at most one thread (primary key task_id), a thread produces many.
    linkTask: db.prepare(`insert into team_thread_tasks (thread_id, task_id) values (?, ?)
      on conflict(task_id) do update set thread_id = excluded.thread_id, created_at = unixepoch()`),
    unlinkTask: db.prepare(`delete from team_thread_tasks where task_id = ?`),
    threadTasks: db.prepare(`select tt.task_id, t.number, t.title, t.status, t.closed_at, p.slug from team_thread_tasks tt
      join tasks t on t.id = tt.task_id join projects p on p.id = t.project_id where tt.thread_id = ? order by t.number`),
    taskThread: db.prepare(`select tt.thread_id, th.title, th.status from team_thread_tasks tt join team_threads th on th.id = tt.thread_id where tt.task_id = ?`),
    sources: db.prepare(`select * from team_sources where project_id = ? order by name`),
    source: db.prepare(`select * from team_sources where id = ?`),
    sourceByName: db.prepare(`select * from team_sources where project_id = ? and lower(name) = lower(?)`),
    insertSource: db.prepare(`insert into team_sources (project_id, name, kind, description, config, secret, created_by) values (?, ?, ?, ?, ?, ?, ?) returning id`),
    updateSource: db.prepare(`update team_sources set name = ?, description = ?, config = ?, secret = coalesce(?, secret) where id = ?`),
    removeSource: db.prepare(`delete from team_sources where id = ?`),
    enable: db.prepare(`insert into team_projects (project_id, runs_as) values (?, ?) on conflict(project_id) do update set runs_as = excluded.runs_as`),
    disable: db.prepare(`delete from team_projects where project_id = ?`),
    brief: db.prepare(`select b.body, b.updated_at, u.name as updated_by from team_briefs b left join users u on u.id = b.updated_by where b.project_id = ?`),
    saveBrief: db.prepare(`insert into team_briefs (project_id, body, updated_by, updated_at) values (?1, ?2, ?3, unixepoch())
      on conflict(project_id) do update set body = ?2, updated_by = ?3, updated_at = unixepoch()`),
    savePriorities: db.prepare(`update team_projects set priorities = ? where project_id = ?`),
    decisions: db.prepare(`select d.id, d.body, d.created_at, u.name as user_name, r.name as role_name from team_decisions d
      left join users u on u.id = d.user_id left join team_roles r on r.id = d.role_id where d.project_id = ? order by d.id desc limit ?`),
    addDecision: db.prepare(`insert into team_decisions (project_id, body, user_id, role_id) values (?, ?, ?, ?)`),
    removeDecision: db.prepare(`delete from team_decisions where id = ? and project_id = ?`),
    roles: db.prepare(`select * from team_roles where project_id = ? and archived = 0 order by id`),
    role: db.prepare(`select * from team_roles where id = ?`),
    roleBySession: db.prepare(`select r.* from team_roles r where r.archived = 0 and (r.chat_session_id = ?1
      or exists (select 1 from team_shifts s where s.role_id = r.id and s.session_id = ?1))`),
    insertRole: db.prepare(`insert into team_roles (project_id, name, summary, instructions, model, created_by) values (?, ?, ?, ?, ?, ?) returning id`),
    updateRole: db.prepare(`update team_roles set name = ?, summary = ?, instructions = ?, model = ?, updated_at = unixepoch() where id = ?`),
    setChat: db.prepare(`update team_roles set chat_session_id = ? where id = ?`),
    archiveRole: db.prepare(`update team_roles set archived = 1, updated_at = unixepoch() where id = ?`),
    notebook: db.prepare(`select n.id, n.body, n.source, n.created_at, u.name as user_name from team_notebook n left join users u on u.id = n.user_id
      where n.role_id = ? order by n.id desc limit ?`),
    addNote: db.prepare(`insert into team_notebook (role_id, body, source, user_id) values (?, ?, ?, ?)`),
    removeNote: db.prepare(`delete from team_notebook where id = ? and role_id = ?`),
    shifts: db.prepare(`select * from team_shifts where role_id = ? order by id desc limit ?`),
    shiftBySession: db.prepare(`select * from team_shifts where session_id = ?`),
    running: db.prepare(`select * from team_shifts where role_id = ? and status = 'running' order by id desc limit 1`),
    lastShiftAt: db.prepare(`select max(started_at) as at from team_shifts where role_id = ? and status != 'running'`),
    insertShift: db.prepare(`insert into team_shifts (role_id, session_id, trigger) values (?, ?, ?) returning id`),
    endShift: db.prepare(`update team_shifts set status = ?, report = coalesce(?, report), ended_at = unixepoch() where id = ? and status = 'running'`),
    report: db.prepare(`update team_shifts set report = ? where id = ?`),
    journal: db.prepare(`select j.id, j.body, j.session_id, j.created_at, u.name as user_name from team_journal j left join users u on u.id = j.user_id
      where j.project_id = ? and j.body != '' and j.created_at >= ? order by j.id desc limit ?`),
    journalUpto: db.prepare(`select max(upto) as upto from team_journal where session_id = ?`),
    addJournal: db.prepare(`insert into team_journal (project_id, session_id, user_id, body, upto) values (?, ?, ?, ?, ?)`),
    session: db.prepare(`select id, status, title, owner_id, project_id, listed from claude_sessions where id = ?`),
  }
  return {
    project: (projectId: number) => plain<{
      project_id: number; runs_as: number; enabled_at: number; paused: number; tz: string; activity_seen: number; priorities: string
      close_guard: string; username: string; name: string
    }>(s.project.get(projectId)),
    setCloseGuard: (projectId: number, guard: string) => void s.setCloseGuard.run(guard, projectId),
    projects: () => all<{ project_id: number; paused: number; tz: string; activity_seen: number; slug: string }>(s.projects.all()),
    projectSettings: (projectId: number, o: { paused?: boolean; tz?: string }) =>
      void s.projectSettings.run(o.paused === undefined ? null : o.paused ? 1 : 0, o.tz ?? null, projectId),
    activitySeen: (projectId: number, id: number) => void s.activitySeen.run(id, projectId),
    newActivity: (projectId: number, after: number) => all<{ id: number; kind: string; summary: string; via_claude: number }>(s.newActivity.all(projectId, after)),
    lastActivity: () => (s.lastActivity.get() as { id: number }).id,
    roleSettings: (id: number, o: RoleSettings) => void s.roleSettings.run(
      o.autonomy, JSON.stringify(o.autoApprove), JSON.stringify(o.schedule), JSON.stringify(o.triggers), o.paused ? 1 : 0, o.dailyLimit, o.monthlyBudget, o.selfClose, id),
    scheduleState: (id: number, state: Record<string, string>) => void s.scheduleState.run(JSON.stringify(state), id),
    triggered: (id: number, at: number) => void s.triggered.run(at, id),
    autoShiftsSince: (roleId: number, since: number) => (s.autoShiftsSince.get(roleId, since) as { n: number }).n,
    costSince: (roleId: number, since: number) => (s.costSince.get(roleId, since) as { usd: number }).usd,
    addShiftCost: (shiftId: number, usd: number) => void s.shiftCost.run(usd, shiftId),
    proposals: (projectId: number | null, status: 'pending' | 'decided', limit = 50, awaiting: 'people' | 'lead' | null = null) =>
      all<ProposalRow>(s.proposals.all(projectId, status, limit, awaiting)),
    proposal: (id: number) => plain<ProposalRow>(s.proposal.get(id)),
    pendingCount: () => (s.pendingCount.get() as { n: number }).n,
    proposalProjects: () => all<{ project_id: number; slug: string; name: string; pending: number; decided: number; cleared: number; last_at: number }>(s.proposalProjects.all()),
    proposalRoles: () => all<{ project_id: number; id: number; name: string }>(s.proposalRoles.all()),
    insertProposal: (p: { projectId: number; roleId: number; kind: ProposalKind; title: string; why: string; payload: object; expiresAt: number; awaiting?: 'people' | 'lead' }) =>
      (s.insertProposal.get(p.projectId, p.roleId, p.kind, p.title, p.why, JSON.stringify(p.payload), p.expiresAt, p.awaiting ?? 'people') as { id: number }).id,
    setProposalAwaiting: (id: number, awaiting: 'people' | 'lead') => void s.setProposalAwaiting.run(awaiting, id),
    decide: (id: number, status: ProposalRow['status'], o: { reply?: string | null; outcome?: string | null; by: number | null; byRole?: number | null }) =>
      Number(s.decide.run(status, o.reply ?? null, o.outcome ?? null, o.by, o.byRole ?? null, id).changes) > 0,
    expire: (now: number) => all<{ id: number; role_id: number; title: string }>(s.expire.all(now)),
    goals: (projectId: number) => all<GoalRow>(s.goals.all(projectId)),
    goal: (id: number) => plain<GoalRow>(s.goal.get(id)),
    insertGoal: (projectId: number, g: { title: string; measure: string; due: string | null; ownerRoleId: number | null }) =>
      (s.insertGoal.get(projectId, g.title, g.measure, g.due, g.ownerRoleId) as { id: number }).id,
    updateGoal: (id: number, g: { status?: GoalRow['status']; progress?: number; note?: string }) =>
      void s.updateGoal.run(g.status ?? null, g.progress ?? null, g.note ?? null, id),
    editGoal: (id: number, g: { title: string; measure: string; due: string | null; status: GoalRow['status']; progress: number; note: string | null }) =>
      void s.editGoal.run(g.title, g.measure, g.due, g.status, g.progress, g.note, id),
    setLead: (projectId: number, roleId: number, on: boolean) => void (on ? s.setLead.run(roleId, projectId) : s.unsetLead.run(roleId)),
    lead: (projectId: number) => plain<RoleRow>(s.lead.get(projectId)),
    threads: (projectId: number, limit = 30) => all<ThreadRow>(s.threads.all(projectId, limit)),
    thread: (id: number) => plain<ThreadRow>(s.thread.get(id)),
    openByTitle: (projectId: number, title: string) => (s.openByTitle.get(projectId, title) as { id: number } | undefined)?.id,
    insertThread: (projectId: number, title: string, ownerRoleId: number | null, openedBy: string) =>
      (s.insertThread.get(projectId, title, ownerRoleId, openedBy) as { id: number }).id,
    touchThread: (id: number) => void s.touchThread.run(id),
    threadList: (projectId: number, f: ThreadFilter, limit: number, offset: number) =>
      all<ThreadRow>(s.threadList.all(projectId, f.status, f.outcome ?? null, f.role ?? null, f.q || null, limit, offset)),
    threadCounts: (projectId: number) => plain<{ open: number; waiting: number; closed: number; all: number }>(s.threadCounts.get(projectId))!,
    /** Open clears how it was closed; closing says how and who. */
    threadState: (id: number, status: 'open' | 'resolved', resolution: string | null, closed?: { as: CloseAs; by: string }) =>
      void s.threadState.run(status, resolution, closed?.as ?? null, closed?.by ?? null, id),
    needsPeople: (id: number, on: boolean) => void s.needsPeople.run(on ? 1 : 0, id),
    setThreadAsk: (id: number, ask: string | null) => void s.setThreadAsk.run(ask, id),
    setThreadPriority: (id: number, priority: 'normal' | 'blocker') => void s.setThreadPriority.run(priority, id),
    threadRoles: (threadId: number) => all<{ id: number; name: string; seen: number }>(s.threadRoles.all(threadId)),
    addThreadRole: (threadId: number, roleId: number) => void s.addThreadRole.run(threadId, roleId),
    seen: (threadId: number, roleId: number, messageId: number) => void s.seen.run(messageId, threadId, roleId),
    roleThreads: (roleId: number) =>
      all<{ id: number; title: string; status: string; needs_people: number; priority: 'normal' | 'blocker'; owner_role_id: number | null; seen: number; last_id: number | null }>(s.roleThreads.all(roleId)),
    roleClosed: (roleId: number, since: number) =>
      all<{ id: number; title: string; closed_as: CloseAs | null; closed_by: string | null; resolution: string | null }>(s.roleClosed.all(roleId, since)),
    messages: (threadId: number) => all<MessageRow>(s.messages.all(threadId)),
    insertMessage: (m: { threadId: number; kind: MessageKind; body: string; evidence: string | null; userId?: number; roleId?: number; sessionId?: string; label: string }) =>
      (s.insertMessage.get(m.threadId, m.kind, m.body, m.evidence, m.userId ?? null, m.roleId ?? null, m.sessionId ?? null, m.label) as { id: number }).id,
    rolesSincePerson: (threadId: number) => (s.rolesSincePerson.get(threadId) as { n: number }).n,
    alertsToday: (label: string, since: number) => (s.alertsToday.get(label, since) as { n: number }).n,
    threadProposals: (threadId: number) => all<ProposalRow>(s.threadProposals.all(threadId)),
    setProposalThread: (id: number, threadId: number) => void s.setProposalThread.run(threadId, id),
    shiftThread: (shiftId: number, threadId: number) => void s.shiftThread.run(threadId, shiftId),
    pendingCloses: (projectId: number) => all<{ id: number; payload: string }>(s.pendingCloses.all(projectId)),
    proposalBySession: (sessionId: string) =>
      plain<{ id: number; role_id: number; project_id: number; thread_id: number | null; title: string }>(s.proposalBySession.get(sessionId)),
    linkTask: (threadId: number, taskId: number) => void s.linkTask.run(threadId, taskId),
    unlinkTask: (taskId: number) => void s.unlinkTask.run(taskId),
    threadTasks: (threadId: number) =>
      all<{ task_id: number; number: number; title: string; status: string; closed_at: number | null; slug: string }>(s.threadTasks.all(threadId)),
    taskThread: (taskId: number) => plain<{ thread_id: number; title: string; status: 'open' | 'resolved' }>(s.taskThread.get(taskId)),
    sources: (projectId: number) => all<SourceRow>(s.sources.all(projectId)),
    source: (id: number) => plain<SourceRow>(s.source.get(id)),
    sourceByName: (projectId: number, name: string) => plain<SourceRow>(s.sourceByName.get(projectId, name)),
    insertSource: (projectId: number, x: { name: string; kind: string; description: string; config: string; secret: string | null }, userId: number) =>
      (s.insertSource.get(projectId, x.name, x.kind, x.description, x.config, x.secret, userId) as { id: number }).id,
    updateSource: (id: number, x: { name: string; description: string; config: string; secret: string | null }) =>
      void s.updateSource.run(x.name, x.description, x.config, x.secret, id),
    removeSource: (id: number) => void s.removeSource.run(id),
    enable: (projectId: number, userId: number) => void s.enable.run(projectId, userId),
    disable: (projectId: number) => void s.disable.run(projectId),
    brief: (projectId: number) => plain<{ body: string; updated_at: number; updated_by: string | null }>(s.brief.get(projectId)),
    saveBrief: (projectId: number, body: string, userId: number | null) => void s.saveBrief.run(projectId, body, userId),
    savePriorities: (projectId: number, body: string) => void s.savePriorities.run(body, projectId),
    decisions: (projectId: number, limit = 30) =>
      all<{ id: number; body: string; created_at: number; user_name: string | null; role_name: string | null }>(s.decisions.all(projectId, limit)),
    addDecision: (projectId: number, body: string, by: { userId?: number; roleId?: number }) =>
      void s.addDecision.run(projectId, body, by.userId ?? null, by.roleId ?? null),
    removeDecision: (projectId: number, id: number) => void s.removeDecision.run(id, projectId),
    roles: (projectId: number) => all<RoleRow>(s.roles.all(projectId)),
    role: (id: number) => plain<RoleRow>(s.role.get(id)),
    roleBySession: (sessionId: string) => plain<RoleRow>(s.roleBySession.get(sessionId)),
    insertRole: (projectId: number, r: { name: string; summary: string; instructions: string; model: string | null }, userId: number) =>
      (s.insertRole.get(projectId, r.name, r.summary, r.instructions, r.model, userId) as { id: number }).id,
    updateRole: (id: number, r: { name: string; summary: string; instructions: string; model: string | null }) =>
      void s.updateRole.run(r.name, r.summary, r.instructions, r.model, id),
    setChat: (id: number, sessionId: string) => void s.setChat.run(sessionId, id),
    archiveRole: (id: number) => void s.archiveRole.run(id),
    notebook: (roleId: number, limit = 100) =>
      all<{ id: number; body: string; source: 'role' | 'person'; created_at: number; user_name: string | null }>(s.notebook.all(roleId, limit)),
    addNote: (roleId: number, body: string, by: { userId?: number }) => void s.addNote.run(roleId, body, by.userId ? 'person' : 'role', by.userId ?? null),
    removeNote: (roleId: number, id: number) => void s.removeNote.run(id, roleId),
    shifts: (roleId: number, limit = 20) => all<ShiftRow>(s.shifts.all(roleId, limit)),
    shiftBySession: (sessionId: string) => plain<ShiftRow>(s.shiftBySession.get(sessionId)),
    running: (roleId: number) => plain<ShiftRow>(s.running.get(roleId)),
    lastShiftAt: (roleId: number) => (s.lastShiftAt.get(roleId) as { at: number | null }).at,
    insertShift: (roleId: number, sessionId: string | null, trigger: string) => (s.insertShift.get(roleId, sessionId, trigger) as { id: number }).id,
    endShift: (id: number, status: 'done' | 'error', report: string | null) => Number(s.endShift.run(status, report, id).changes) > 0,
    setReport: (id: number, report: string) => void s.report.run(report, id),
    journal: (projectId: number, since = 0, limit = 30) =>
      all<{ id: number; body: string; session_id: string | null; created_at: number; user_name: string | null }>(s.journal.all(projectId, since, limit)),
    journalUpto: (sessionId: string) => (s.journalUpto.get(sessionId) as { upto: number | null }).upto ?? 0,
    addJournal: (projectId: number, sessionId: string, userId: number, body: string, upto: number) =>
      void s.addJournal.run(projectId, sessionId, userId, body, upto),
    session: (id: string) => plain<{ id: string; status: string; title: string; owner_id: number; project_id: number | null; listed: number }>(s.session.get(id)),
  }
}

export type TeamRepo = ReturnType<typeof teamRepo>
