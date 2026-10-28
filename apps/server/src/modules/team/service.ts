// Team: AI team members (roles) for a project. Built on DevDash, never the other way round: it starts Claude sessions
// through the Claude service, listens to their turns, and reads projects, activity and tasks.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService, TurnEnd } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { Priority, TasksService } from '../tasks/service.ts'
import { seal, unseal } from '../../core/crypto.ts'
import type { AgentsService } from '../agents/service.ts'
import { DIGEST_SYSTEM, GENERATE_SYSTEM, generatePrompt, roleSystem, roleTools, shiftPrompt } from './prompts.ts'
import { teamRepo, type CloseAs, type GoalRow, type MessageKind, type ProposalKind, type ProposalRow, type RoleRow, type SelfClose, type SourceRow, type ThreadFilter, type ThreadRow } from './repo.ts'
import { dueSlots, localParts, nextRun, slotKey, TRIGGERS, validSlots, validTz, type Slot, type Trigger } from './schedule.ts'
import { fetchHttp, fetchPage, queryPostgres, readOnlySql, rowsText, type SourceConfig, type SourceKind } from './sources.ts'

export const MODELS = ['opus', 'sonnet', 'haiku'] as const
export const KINDS = ['task', 'code', 'goal', 'other'] as const
const DIGEST_AFTER_MS = 5 * 60_000 // a session quiet this long gets its journal line
const STALE_SHIFT_S = 120
const PROPOSAL_DAYS = 7 // unanswered proposals expire, so stale plans don't run weeks later
const TRIGGER_COOLDOWN_S = 3600 // a trigger wakes a role at most once an hour
const PRIORITIES = new Set<Priority>(['none', 'low', 'medium', 'high', 'urgent'])
const HOP_LIMIT = 4 // role messages in a thread since a person last spoke, before it waits for people
const ALERTS_PER_DAY = 5 // per sender, so one noisy session or role can't keep waking everyone
export const MESSAGE_KINDS = ['fyi', 'question', 'request', 'alert', 'reply'] as const
export { CLOSE_AS, type CloseAs } from './repo.ts'
const THREADS_PAGE = 30
const SELF_CLOSE_MIN = 8 // confidence 8-10 lets an allowed role close directly; below that, people get a one-tap approval
export type CloseGuard = { money: boolean; production: boolean; person_decision: boolean }
export const DEFAULT_CLOSE_GUARD: CloseGuard = { money: true, production: true, person_decision: true }
const MONEY_RE = /\b(spend|spent|budget|pay|payment|paid|billing|invoice|refund|price|pricing|cost|charge|salary|subscription|\$|usd|eur|gbp)\b/i
const PROD_RE = /\b(production|prod|deploy|deployment|release|launch|rollout|go[- ]?live|hotfix|incident|outage)\b/i
const DECISION_RE = /\b(decide|decision|choose|choice|pick|which|whether|approve|approval|sign[- ]?off|strategy|policy)\b/i
/** Why a close must go to people whatever the confidence, or null. `byPerson`: a person made or owns it (a decision, not a status). */
function closeConcern(guard: CloseGuard, o: { text: string; byPerson: boolean }) {
  if (guard.money && MONEY_RE.test(o.text)) return 'it may involve money'
  if (guard.production && PROD_RE.test(o.text)) return 'it touches production or a release'
  if (guard.person_decision && o.byPerson && DECISION_RE.test(o.text)) return "it reads like a person's decision, not a status"
  return null
}
type ClosePayload = { target: { kind: 'task' | 'thread'; slug: string; number?: number; thread?: number; label: string }; confidence: number; evidence: string; concern?: string | null }
/** The closing line in the thread, before the reason. */
const CLOSED_LINE: Record<CloseAs, string> = {
  done: 'Resolved', declined: 'Declined', duplicate: 'Closed as a duplicate', not_needed: 'Closed as not needed', elsewhere: 'Closed: handled elsewhere',
}

/** Who writes in a thread: a person, a role, or any Claude session in the project. */
export type Author =
  | { kind: 'person'; user: User }
  | { kind: 'role'; roleId: number; sessionId?: string }
  | { kind: 'session'; sessionId: string; title: string; owner: User }
export type MessageInput = { thread?: number; to?: string; cc?: string[]; title?: string; kind: MessageKind; body: string; evidence?: string; ask?: string }
export type SourceInput = { name: string; kind: SourceKind; description: string; config: SourceConfig; secret?: string | null }

export type RoleInput = { name: string; summary: string; instructions: string; model: string | null }
export type RoleSettingsInput = {
  autonomy: 'advisor' | 'operator'; autoApprove: string[]; schedule: unknown[]; triggers: string[]
  paused: boolean; dailyLimit: number; monthlyBudget: number | null; lead?: boolean; selfClose?: SelfClose
}
export type ProposalInput = {
  kind: ProposalKind; title: string; why: string
  tasks?: { title: string; body?: string; priority?: string }[]
  prompt?: string
  goal?: { title: string; measure?: string; due?: string | null }
  details?: string
}
type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A Claude transcript as plain lines for a summary: what the person said, what Claude said and did. */
export function transcriptText(messages: unknown[]) {
  const lines: string[] = []
  for (const raw of messages) {
    const m = raw as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } }
    if (m.parent_tool_use_id) continue
    const content = m.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : []
    for (const b of blocks) {
      if (b.type === 'text') {
        const text = String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        if (text && !text.startsWith('<')) lines.push(`${m.type === 'user' ? 'Person' : 'Claude'}: ${clipText(text, 600)}`)
      } else if (b.type === 'tool_use' && m.type === 'assistant') {
        const i = (b.input ?? {}) as Record<string, unknown>
        const what = [i.description, i.file_path, i.command, i.pattern, i.url].find((v) => typeof v === 'string') as string | undefined
        lines.push(`Claude used ${String(b.name)}${what ? `: ${clipText(what, 120)}` : ''}`)
      }
    }
  }
  return lines.join('\n')
}

/** Which trigger an activity row is, if any. Rows a role or Claude made ("via Claude") never wake roles. */
export function activityTrigger(a: { kind: string; summary: string; via_claude: number }): Trigger | null {
  if (a.via_claude) return null
  if (a.kind === 'task.created') return 'task_created'
  if ((a.kind === 'task.status' && /to Done$/.test(a.summary)) || a.kind === 'task.closed_by_commit') return 'task_done'
  return null
}

export function teamService({ db, hub, claude, projects, activity, tasks, notify, agents, masterKey, onProposalIdle, digestAfterMs = DIGEST_AFTER_MS, tickMs = 60_000 }: {
  db: Db; hub: Hub; claude: ClaudeService; projects: ProjectsService; activity: ActivityService; tasks: TasksService; notify: Notify
  agents: AgentsService; masterKey: Buffer; digestAfterMs?: number; tickMs?: number
  /** An approved code proposal's session went quiet: the reviews module checks its branch for shippable work (Ready to review). */
  onProposalIdle?: (s: TurnEnd['session']) => void
}) {
  const repo = teamRepo(db)
  hub.authorize('team', () => true)
  const changed = (projectId: number) => hub.publish('team', { type: 'changed', projectId })

  const userById = (id: number) => {
    const u = db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null').get(id)
    return u ? ({ ...u } as User) : undefined
  }
  const members = () => (db.prepare('select id from users where disabled_at is null').all() as { id: number }[]).map((u) => u.id)
  const profileOf = (u: User) => (claude.defaults(u) as { profile: string }).profile

  /** The project with Team on, and the member its roles run as. */
  function on(slug: string) {
    const p = projects.bySlug(slug)
    const t = repo.project(p.id)
    if (!t) throw new AppError(409, 'team_off', 'Team is off for this project.')
    const runsAs = userById(t.runs_as)
    if (!runsAs) throw new AppError(409, 'no_account', 'The member this team runs as has no account any more. Turn Team off and on again to run it as you.')
    return { p, t, runsAs }
  }
  function findRole(id: number) {
    const r = repo.role(id)
    if (!r || r.archived) throw new AppError(404, 'not_found', 'This role does not exist.')
    const p = db.prepare('select id, slug, name from projects where id = ?').get(r.project_id) as { id: number; slug: string; name: string }
    return { r, p: { ...p } }
  }
  const settingsOf = (r: RoleRow) => ({
    autonomy: r.autonomy === 'advisor' ? 'advisor' as const : 'operator' as const,
    autoApprove: json<string[]>(r.auto_approve, []).filter((k) => (KINDS as readonly string[]).includes(k)),
    schedule: validSlots(json(r.schedule, [])),
    triggers: json<string[]>(r.triggers, []).filter((t): t is Trigger => (TRIGGERS as readonly string[]).includes(t)),
    paused: !!r.paused, dailyLimit: r.daily_limit, monthlyBudget: r.monthly_budget, lead: !!r.lead,
    selfClose: (['default', 'always_ask', 'allow'] as const).includes(r.self_close) ? r.self_close : 'default',
  })
  /** Whether this role may close a confident item directly: 'allow' always, 'always_ask' never, else operators only. */
  const canSelfClose = (s: ReturnType<typeof settingsOf>) => s.selfClose === 'allow' ? true : s.selfClose === 'always_ask' ? false : s.autonomy === 'operator'
  const sessionTools = (r: RoleRow, project: string) => {
    const s = settingsOf(r)
    return { instructions: roleSystem({ ...r, autonomy: s.autonomy, autoApprove: s.autoApprove }, project), toolPolicy: roleTools(s.autonomy) }
  }
  const tell = (title: string, body: string, url: string, tag: string, kind: NotificationKind = 'needs_you') => {
    for (const uid of members()) void notify(uid, kind, { title, body, url, tag }).catch(() => {})
  }
  const monthStart = () => {
    const d = new Date()
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
  }
  const dayStart = () => Math.floor(Date.now() / 86_400_000) * 86_400

  /** A shift whose session stopped without telling us (a restart mid-shift) is closed rather than shown running forever. */
  function settle(roleId: number) {
    const run = repo.running(roleId)
    if (!run) return null
    const s = run.session_id ? repo.session(run.session_id) : undefined
    const busy = s && (s.status === 'working' || s.status === 'waiting')
    if (!busy && Date.now() / 1000 - run.started_at > STALE_SHIFT_S) {
      repo.endShift(run.id, s?.status === 'error' ? 'error' : 'done', run.report ? null : 'The shift ended without a report.')
      return null
    }
    return run
  }

  function roleDto(r: RoleRow) {
    const running = settle(r.id)
    const last = repo.shifts(r.id, 3).find((x) => x.status !== 'running')
    const chat = r.chat_session_id ? repo.session(r.chat_session_id) : undefined
    const s = settingsOf(r)
    const t = repo.project(r.project_id)
    return {
      id: r.id, name: r.name, summary: r.summary, model: r.model,
      working: !!running || chat?.status === 'working',
      shift: running ? { id: running.id, startedAt: running.started_at, sessionId: running.session_id } : null,
      lastShift: last ? { at: last.ended_at ?? last.started_at, status: last.status, report: last.report } : null,
      chatSessionId: chat ? r.chat_session_id : null,
      ...s,
      nextShiftAt: !s.paused && t && !t.paused ? nextRun(s.schedule, t.tz, Date.now()) : null,
      usage: { costMonth: repo.costSince(r.id, monthStart()), autoShiftsToday: repo.autoShiftsSince(r.id, dayStart()) },
    }
  }

  function journal(projectId: number, since = 0, limit = 30) {
    const lines = [
      ...repo.journal(projectId, since, limit).map((j) => ({ id: `j${j.id}`, kind: 'session' as const, at: j.created_at, text: j.body, who: j.user_name, url: j.session_id ? `/claude/${j.session_id}` : null })),
      ...activity.list(projectId, limit).filter((a) => a.at >= since).map((a) => ({ id: `a${a.id}`, kind: 'activity' as const, at: a.at, text: a.summary, who: a.user, url: a.url })),
    ]
    return lines.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  const goalDto = (g: GoalRow) => ({
    id: g.id, title: g.title, measure: g.measure, due: g.due, status: g.status, progress: g.progress, note: g.note,
    owner: g.owner_name, updatedAt: g.updated_at,
  })
  const proposalDto = (x: ProposalRow) => ({
    id: x.id, kind: x.kind, title: x.title, why: x.why, payload: json<Record<string, unknown>>(x.payload, {}), status: x.status,
    reply: x.reply, outcome: x.outcome, decidedBy: x.decided_by_name, decidedByRole: x.decided_by_role_name, awaiting: x.awaiting,
    decidedAt: x.decided_at, createdAt: x.created_at, expiresAt: x.expires_at,
    role: { id: x.role_id, name: x.role_name }, project: { slug: x.project_slug, name: x.project_name },
  })

  // ---- Proposals: what roles want that needs a person ----

  /** Carries out an approved (or allowed) proposal as `user`; returns what happened, as Markdown. */
  async function execute(x: ProposalRow, user: User) {
    // A "close" proposal people approved: carry out the close, attributed to the approver.
    if (x.kind === 'close') {
      const pl = json<ClosePayload>(x.payload, { target: { kind: 'task', slug: x.project_slug, label: x.title }, confidence: 0, evidence: x.why })
      applyClose(x.project_id, pl, { user }, { kind: 'person', user })
      return `Closed ${pl.target.label}.`
    }
    const payload = json<ProposalInput>(x.payload, { kind: x.kind, title: x.title, why: x.why })
    // Tasks a role's approved proposal creates are the role's work, run on the member's account.
    const actor = { user, viaClaude: true, role: x.role_name }
    if (x.kind === 'task') {
      const made = (payload.tasks?.length ? payload.tasks : [{ title: x.title, body: x.why }]).slice(0, 10).map((t) => tasks.create(actor, {
        project: x.project_slug, title: t.title.slice(0, 200), body: t.body ?? '', status: 'backlog',
        priority: PRIORITIES.has(t.priority as Priority) ? (t.priority as Priority) : 'none',
      }))
      // One job per object: a task born from a thread's proposal is linked to it, both ways.
      if (x.thread_id) for (const t of made) repo.linkTask(x.thread_id, t.id)
      return `Added ${made.map((t) => `[${t.key}](/tasks/${x.project_slug}/${t.number})`).join(', ')} to the backlog.`
    }
    if (x.kind === 'code') {
      const d = claude.defaults(user) as { profile: string; model: string | null; effort: string | null; permission_mode: string }
      const prompt = `${payload.prompt?.trim() || x.title}\n\n(Proposed by the ${x.role_name} role on the DevDash team, approved by ${user.name}. Work on this branch; commit when done.)`
      const s = await claude.create(user, {
        prompt, images: [], cwd: '', profile: d.profile, model: d.model, effort: d.effort, permissionMode: d.permission_mode,
        mode: 'chat', project: x.project_slug, worktree: true,
        // Unlisted: it lives under the project's "From approvals" group, not everyone's global session list.
      }, { title: `${x.role_name}: ${x.title}`, origin: { kind: 'proposal', role: x.role_name }, listed: false })
      return `Claude started on it in its own branch: [${s.title}](/claude/${s.id}).`
    }
    if (x.kind === 'goal') {
      const g = payload.goal ?? { title: x.title }
      repo.insertGoal(x.project_id, { title: g.title.slice(0, 200), measure: (g.measure ?? '').slice(0, 300), due: validDue(g.due), ownerRoleId: x.role_id })
      return `Goal set: ${g.title}.`
    }
    const t = tasks.create(actor, {
      project: x.project_slug, title: x.title.slice(0, 200), status: 'todo', assignee: user.id,
      body: [x.why, payload.details].filter(Boolean).join('\n\n'),
    })
    if (x.thread_id) repo.linkTask(x.thread_id, t.id)
    return `It's a task for ${user.name}: [${t.key}](/tasks/${x.project_slug}/${t.number}).`
  }
  const validDue = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

  async function propose(roleId: number, input: ProposalInput, sessionId?: string) {
    const { r, p } = findRole(roleId)
    const { runsAs } = on(p.slug)
    const s = settingsOf(r)
    // Routine task/goal proposals go to the lead to clear (fewer reach a person); the proposer's own, code, other, or
    // no lead at all, go to people as before.
    const lead = repo.lead(p.id)
    const awaiting = lead && lead.id !== r.id && (input.kind === 'task' || input.kind === 'goal') ? 'lead' as const : 'people' as const
    const id = repo.insertProposal({
      projectId: p.id, roleId: r.id, kind: input.kind, title: input.title.trim().slice(0, 200), why: input.why.trim().slice(0, 4000),
      payload: input, expiresAt: Math.floor(Date.now() / 1000) + PROPOSAL_DAYS * 86_400, awaiting,
    })
    // Proposed during a shift about a thread: it shows in that thread too.
    const threadId = sessionId ? repo.shiftBySession(sessionId)?.thread_id : null
    if (threadId) repo.setProposalThread(id, threadId)
    // What the role may do on its own goes ahead now, run as the member the team runs as; the rest waits.
    const alone = (input.kind === 'task' && s.autonomy === 'operator') || s.autoApprove.includes(input.kind)
    if (alone) {
      const outcome = await execute(repo.proposal(id)!, runsAs)
      repo.decide(id, 'done', { outcome, by: null })
      changed(p.id)
      return { status: 'done' as const, outcome }
    }
    if (awaiting === 'lead') {
      // Wake the lead to clear it; if it can't start now, it finds the proposal in its next shift's context.
      auto(lead!, `a teammate's proposal to clear: "${clipText(input.title, 80)}"`)
      changed(p.id)
      hub.publish('team', { type: 'approvals' })
      return { status: 'pending' as const, outcome: null }
    }
    for (const uid of members()) {
      void notify(uid, 'needs_you', { title: `${r.name} (${p.name}): ${input.title}`, body: 'Waiting for your approval', url: '/approvals', tag: `team-proposal:${id}` }).catch(() => {})
    }
    changed(p.id)
    hub.publish('team', { type: 'approvals' })
    return { status: 'pending' as const, outcome: null }
  }

  // ---- The project journal: a line for each stretch of work in the project's Claude sessions ----
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  function scheduleDigest(sessionId: string) {
    clearTimeout(timers.get(sessionId))
    const t = setTimeout(() => {
      timers.delete(sessionId)
      void digest(sessionId).catch((err) => console.error('team journal:', (err as Error).message))
    }, digestAfterMs)
    t.unref?.()
    timers.set(sessionId, t)
  }
  async function digest(sessionId: string) {
    const s = repo.session(sessionId)
    if (!s?.project_id || !s.listed || !repo.project(s.project_id)) return
    if (s.status === 'working' || s.status === 'waiting') return scheduleDigest(sessionId)
    const owner = userById(s.owner_id)
    if (!owner) return
    const messages = await claude.transcript(sessionId)
    const from = repo.journalUpto(sessionId)
    if (messages.length <= from) return
    const text = transcriptText(messages.slice(from))
    let body = ''
    if (text.length >= 80) {
      const out = await claude.complete(owner.username, `Session "${s.title}":\n\n${text.slice(-24_000)}`, { system: DIGEST_SYSTEM, model: 'haiku', profile: profileOf(owner) })
      body = /^NONE\b/.test(out.trim()) ? '' : out.trim().slice(0, 600)
    }
    repo.addJournal(s.project_id, sessionId, owner.id, body, messages.length)
    if (body) {
      changed(s.project_id)
      wake(s.project_id, 'work', `new work in the project: ${clipText(body.split('\n')[0]!, 120)}`)
    }
  }

  // ---- Working on their own: schedules, triggers and limits ----

  /** Why a role can't start a shift on its own right now, or null when it can. */
  function blocked(r: RoleRow) {
    const t = repo.project(r.project_id)
    if (!t || t.paused || r.paused || r.archived) return 'paused'
    if (settle(r.id)) return 'busy'
    if (repo.autoShiftsSince(r.id, dayStart()) >= r.daily_limit) return 'daily limit'
    if (r.monthly_budget !== null && repo.costSince(r.id, monthStart()) >= r.monthly_budget) return 'monthly budget'
    return null
  }
  function auto(r: RoleRow, label: string, threadId?: number) {
    const why = blocked(r)
    if (why) return false
    void runShift(r.id, label, threadId).catch((err) => console.error(`team: ${r.name} could not start a shift:`, (err as Error).message))
    return true
  }
  function wake(projectId: number, trigger: Trigger, label: string) {
    const now = Math.floor(Date.now() / 1000)
    for (const r of repo.roles(projectId)) {
      if (!settingsOf(r).triggers.includes(trigger) || now - r.last_triggered < TRIGGER_COOLDOWN_S) continue
      if (auto(r, label)) repo.triggered(r.id, now)
    }
  }

  /** Runs every minute: due schedules, new activity that triggers roles, proposals nobody answered. */
  function tick(now = Date.now()) {
    for (const x of repo.expire(Math.floor(now / 1000))) {
      repo.addNote(x.role_id, `Expired without an answer after ${PROPOSAL_DAYS} days: ${x.title}`, {})
    }
    for (const t of repo.projects()) {
      if (t.paused) continue
      for (const r of repo.roles(t.project_id)) {
        const s = settingsOf(r)
        const due = dueSlots(s.schedule, json<Record<string, string>>(r.schedule_state, {}), t.tz, now)
        if (!due.length || r.paused) continue
        const state = { ...json<Record<string, string>>(r.schedule_state, {}), ...Object.fromEntries(due.map((d) => [slotKey(d.slot), d.date])) }
        repo.scheduleState(r.id, state)
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][localParts(t.tz, now).weekday]
        auto(r, `scheduled, ${day} ${due[0]!.slot.at}`)
      }
      const rows = repo.newActivity(t.project_id, t.activity_seen)
      if (!rows.length) continue
      repo.activitySeen(t.project_id, rows.at(-1)!.id)
      for (const a of rows) {
        const trig = activityTrigger(a)
        if (trig) wake(t.project_id, trig, `${trig === 'task_done' ? 'a task was done' : 'a new task'}: ${clipText(a.summary, 120)}`)
      }
    }
  }
  const ticker = setInterval(() => {
    try {
      tick()
    } catch (err) {
      console.error('team tick:', (err as Error).message)
    }
  }, tickMs)
  ticker.unref?.()

  const onTurnEnd = (e: TurnEnd) => {
    const s = e.session
    const shift = repo.shiftBySession(s.id)
    if (shift) {
      if (e.costUsd) repo.addShiftCost(shift.id, e.costUsd)
      if (shift.status === 'running') {
        const fallback = e.result?.trim() || (e.ok ? 'Finished without a report.' : 'The shift stopped with an error.')
        repo.endShift(shift.id, e.ok || e.aborted ? 'done' : 'error', shift.report ? null : fallback)
        // The lead's report is the team's digest: it goes to everyone's phone.
        const role = repo.role(shift.role_id)
        const report = repo.shiftBySession(s.id)?.report
        if (role?.lead && e.ok && report) {
          const p = db.prepare('select slug, name from projects where id = ?').get(role.project_id) as { slug: string; name: string }
          tell(`${p.name}: ${role.name}'s digest`, clipText(report.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim(), 300),
            `/projects/${p.slug}/team/${role.id}`, `team-digest:${role.id}`, 'finished')
        }
      }
    }
    const role = shift ? repo.role(shift.role_id) : repo.roleBySession(s.id)
    if (role) changed(role.project_id)
    if (s.listed && s.project_id && repo.project(s.project_id)) scheduleDigest(s.id)
    // An approved code proposal's session (execute(), kind 'code') just went quiet: it may have committed shippable work
    // on its branch. The reviews module turns that into a "Ready to review" delivery. The claude module never imports Team.
    if (s.origin_kind === 'proposal' && s.worktree && !s.archived) onProposalIdle?.(s)
  }
  const stopListening = claude.onTurnEnd(onTurnEnd)

  /** A shift now: the role works on its own in a Claude session nobody is typing in, and reports. */
  async function runShift(id: number, trigger = 'manual', threadId?: number) {
    const { r, p } = findRole(id)
    const { runsAs } = on(p.slug)
    if (settle(r.id)) throw new AppError(409, 'busy', `${r.name} is already on a shift.`)
    const label = trigger === 'manual' ? 'started by hand' : trigger
    const s = await claude.create(runsAs, {
      prompt: shiftPrompt(label, threadId), images: [], cwd: '', profile: profileOf(runsAs), model: r.model, effort: null,
      permissionMode: 'dontAsk', mode: 'chat', project: p.slug,
    }, { title: `${r.name}: shift`, ...sessionTools(r, p.name), listed: false, shared: true })
    const shiftId = repo.insertShift(r.id, s.id, trigger)
    if (threadId) repo.shiftThread(shiftId, threadId)
    changed(p.id)
    return roleDto(repo.role(id)!)
  }

  // ---- Threads: one issue, one thread, between roles, Claude sessions and people ----

  const threadDto = (t: ThreadRow) => ({
    id: t.id, title: t.title, status: t.status, needsPeople: !!t.needs_people, ask: t.ask, priority: t.priority, openedBy: t.opened_by, resolution: t.resolution,
    closedAs: t.closed_as, closedBy: t.closed_by, resolvedAt: t.resolved_at,
    owner: t.owner_role_id ? { id: t.owner_role_id, name: t.owner_name } : null, messages: t.messages, lastAt: t.last_at ?? t.created_at,
    createdAt: t.created_at, roles: repo.threadRoles(t.id).map((r) => ({ id: r.id, name: r.name })),
  })
  /** A role by the name someone wrote: exact first, then the one whose name starts with it or contains it. */
  function roleNamed(projectId: number, name: string) {
    const roles = repo.roles(projectId)
    const n = name.trim().toLowerCase()
    return roles.find((r) => r.name.toLowerCase() === n) ?? roles.find((r) => r.name.toLowerCase().startsWith(n)) ?? roles.find((r) => r.name.toLowerCase().includes(n))
  }
  const authorLabel = (a: Author) =>
    a.kind === 'person' ? a.user.name : a.kind === 'role' ? repo.role(a.roleId)!.name : `Claude session "${clipText(a.title, 60)}" (${a.owner.name})`

  /** Posts to a thread (or opens one): routes it to the right role, wakes whoever must act, and keeps roles from looping. */
  function message(projectId: number, a: Author, input: MessageInput) {
    const label = authorLabel(a)
    // Roles are kept short so threads stay readable (the point, one link, the recommendation); people and sessions aren't clipped.
    const body = input.body.trim().slice(0, a.kind === 'role' ? 900 : 8000)
    const evidence = input.evidence?.trim().slice(0, a.kind === 'role' ? 1200 : 8000) || null
    if (!body) throw new AppError(400, 'bad_args', 'Write the message.')
    const now = Math.floor(Date.now() / 1000)
    let kind = input.kind
    if (kind === 'alert' && a.kind !== 'person' && repo.alertsToday(label, now - 86_400) >= ALERTS_PER_DAY) {
      throw new AppError(429, 'alerts', `${label} sent ${ALERTS_PER_DAY} alerts today. Send this as a "request" instead; the owner sees it on its next shift.`)
    }

    let t: ThreadRow
    if (input.thread) {
      const found = repo.thread(input.thread)
      if (!found || found.project_id !== projectId) throw new AppError(404, 'not_found', `There is no thread #${input.thread} in this project.`)
      if (found.status === 'resolved') {
        if (a.kind !== 'person') throw new AppError(409, 'resolved', `Thread #${found.id} is resolved. Open a new one if something changed.`)
        repo.threadState(found.id, 'open', null)
      }
      if (a.kind === 'role' && found.needs_people) throw new AppError(409, 'waiting', `Thread #${found.id} waits for people now. Put your point in your report.`)
      t = found
    } else {
      const title = input.title?.trim().slice(0, 200)
      if (!title) throw new AppError(400, 'bad_args', 'A new thread needs a title (or pass the thread id to add to one).')
      if (a.kind !== 'person' && !evidence) throw new AppError(400, 'evidence', 'Add the evidence: the numbers, files or links that show it.')
      const existing = repo.openByTitle(projectId, title)
      if (existing) t = repo.thread(existing)!
      else {
        // To the role it names; else the lead; else it waits for people.
        const owner = (input.to && roleNamed(projectId, input.to)) || repo.lead(projectId) || null
        t = repo.thread(repo.insertThread(projectId, title, owner?.id ?? null, label))!
        if (owner) repo.addThreadRole(t.id, owner.id)
        else repo.needsPeople(t.id, true)
      }
    }
    // One thread, one voice: a role may post only in a thread it owns or was asked into. For input from someone else's
    // thread, it messages that owner (opening/adding) instead of piling into it uninvited.
    if (input.thread && a.kind === 'role') {
      const belongs = t.owner_role_id === a.roleId || repo.threadRoles(t.id).some((x) => x.id === a.roleId)
      if (!belongs) throw new AppError(403, 'not_in_thread', `You're not on thread #${t.id} — message its owner with team_message \`to:\` instead of posting in it.`)
    }
    if (kind === 'reply' && !input.thread) kind = 'fyi'
    for (const name of [input.to, ...(input.cc ?? [])]) {
      const r = name && roleNamed(projectId, name)
      if (r) repo.addThreadRole(t.id, r.id)
    }
    if (a.kind === 'role') repo.addThreadRole(t.id, a.roleId)
    const id = repo.insertMessage({
      threadId: t.id, kind, body, evidence, label,
      userId: a.kind === 'person' ? a.user.id : a.kind === 'session' ? a.owner.id : undefined,
      roleId: a.kind === 'role' ? a.roleId : undefined, sessionId: a.kind === 'person' ? undefined : a.sessionId,
    })
    if (a.kind === 'role') repo.seen(t.id, a.roleId, id)
    // A person stepped in: the roles may carry on, and the ask is answered (an ownerless thread keeps waiting).
    if (a.kind === 'person' && t.needs_people && t.owner_role_id) {
      repo.needsPeople(t.id, false)
      repo.setThreadAsk(t.id, null)
    }
    repo.touchThread(t.id)
    const p = db.prepare('select slug, name from projects where id = ?').get(projectId) as { slug: string; name: string }
    const url = `/projects/${p.slug}/team/threads/${t.id}`

    // A role hands a thread to people, either because it set an explicit ask or because roles went back and forth too long.
    let note = ''
    const ask = a.kind === 'role' ? input.ask?.trim().replace(/\s+/g, ' ').slice(0, 300) || null : null
    if (a.kind === 'role' && (ask || repo.rolesSincePerson(t.id) >= HOP_LIMIT)) {
      if (ask) repo.setThreadAsk(t.id, ask)
      repo.needsPeople(t.id, true)
      const decision = ask ?? repo.thread(t.id)?.ask
      tell(`${p.name}: "${t.title}" needs a person`, decision ? `Decision needed: ${decision}` : `${HOP_LIMIT} messages between roles without a decision.`, url, `team-thread:${t.id}`)
      note = ask ? ` Handed to people — asked: "${ask}".` : ' The roles have gone back and forth enough: this thread now waits for people.'
    } else if (kind === 'alert') {
      tell(`Alert in ${p.name}: ${t.title}`, clipText(body, 200), url, `team-thread:${t.id}`)
    }
    // Who must act now: the owner on an alert or a person's message (within its limits); others see it on their next shift.
    const owner = t.owner_role_id ? repo.role(t.owner_role_id) : undefined
    const fromOwner = a.kind === 'role' && a.roleId === owner?.id
    if (owner && !owner.archived && !fromOwner && (kind === 'alert' || a.kind === 'person')) {
      auto(owner, kind === 'alert' ? `an alert in thread "${clipText(t.title, 80)}"` : `${label} wrote in thread "${clipText(t.title, 80)}"`, t.id)
    }
    changed(projectId)
    return { thread: t.id, message: id, note }
  }

  /**
   * Closes a thread. The owner (or a person) closes it as done or declines it; any other role in it may only decline it
   * (not ours, a duplicate, not needed, handled elsewhere), always with a reason. People see it in the thread and the list,
   * without their phones going off, and can reopen it.
   */
  function closeThread(threadId: number, by: Author, o: { as: CloseAs; reason: string; duplicateOf?: number }) {
    const t = repo.thread(threadId)
    if (!t) throw new AppError(404, 'not_found', 'No such thread.')
    if (t.status === 'resolved') throw new AppError(409, 'closed', `Thread #${t.id} is already closed.`)
    const reason = o.reason.trim().replace(/\s+/g, ' ').slice(0, 1000)
    if (by.kind === 'role') {
      const owner = t.owner_role_id === by.roleId
      if (!owner && !repo.threadRoles(t.id).some((r) => r.id === by.roleId)) {
        throw new AppError(403, 'not_in_thread', `You're not in thread #${t.id}: only its owner and the roles in it close it.`)
      }
      if (t.needs_people) throw new AppError(409, 'waiting', `Thread #${t.id} waits for people now. Put your point in your report.`)
      if (!owner && o.as === 'done') {
        throw new AppError(403, 'not_owner', `Only the owner (${t.owner_name ?? 'people'}) closes this thread as done. If it isn't yours or isn't needed, decline it (as: declined, duplicate, not_needed or elsewhere) and say why.`)
      }
    }
    if (o.as !== 'done' && !reason) throw new AppError(400, 'reason', 'Say why in one line: who has it, what it duplicates, or why it isn\'t needed.')
    let dup = ''
    if (o.as === 'duplicate' && o.duplicateOf) {
      const other = repo.thread(o.duplicateOf)
      if (!other || other.project_id !== t.project_id || other.id === t.id) throw new AppError(404, 'not_found', `There is no other thread #${o.duplicateOf} in this project.`)
      dup = ` of #${other.id} (${clipText(other.title, 80)})`
    }
    const label = authorLabel(by)
    const outcome = dup ? `Duplicate${dup}${reason ? `: ${reason}` : ''}` : reason
    repo.threadState(threadId, 'resolved', outcome.slice(0, 1000) || null, { as: o.as, by: label })
    repo.insertMessage({
      threadId, kind: 'fyi', body: `${CLOSED_LINE[o.as]}${dup}${reason ? `: ${reason}` : '.'}`, evidence: null, label,
      userId: by.kind === 'person' ? by.user.id : undefined, roleId: by.kind === 'role' ? by.roleId : undefined,
    })
    // One job per object: when a thread is settled, offer to close the open tasks it produced.
    if (o.as === 'done') offerCloseLinkedTasks(t)
    changed(t.project_id)
  }

  /**
   * One job per object: link a task to a thread (or unlink it), both ways. Resolves the task by its number within the
   * thread's project, notes it in the thread, and returns the task key. A task belongs to at most one thread.
   */
  function linkTaskToThread(t: ThreadRow, taskNumber: number, by: Author, unlink = false) {
    const p = db.prepare('select slug, name from projects where id = ?').get(t.project_id) as { slug: string; name: string }
    let task
    try {
      task = tasks.get(p.slug, taskNumber)
    } catch {
      throw new AppError(404, 'not_found', `There is no task ${p.slug}#${taskNumber} to link.`)
    }
    const label = authorLabel(by)
    if (unlink) repo.unlinkTask(task.id)
    else repo.linkTask(t.id, task.id)
    repo.insertMessage({
      threadId: t.id, kind: 'fyi', body: `${unlink ? 'Unlinked' : 'Linked'} task ${task.key}: ${clipText(task.title, 100)}.`, evidence: null, label,
      userId: by.kind === 'person' ? by.user.id : undefined, roleId: by.kind === 'role' ? by.roleId : undefined,
    })
    repo.touchThread(t.id)
    changed(t.project_id)
    return task.key
  }

  // ---- Confidence-based closing: a role closes a task or thread directly when confident and allowed, else asks people ----

  const closeGuardOf = (projectId: number): CloseGuard => ({ ...DEFAULT_CLOSE_GUARD, ...json<Partial<CloseGuard>>(repo.project(projectId)?.close_guard, {}) })
  const closeUrl = (t: ClosePayload['target']) => t.kind === 'task' ? `/tasks/${t.slug}/${t.number}` : `/projects/${t.slug}/team/threads/${t.thread}`
  const hasPendingClose = (projectId: number, kind: 'task' | 'thread', ref: number) =>
    repo.pendingCloses(projectId).some((x) => { const t = json<ClosePayload>(x.payload, null as never)?.target; return t?.kind === kind && (kind === 'task' ? t.number === ref : t.thread === ref) })

  /** Actually close the target (task → done, thread → resolved), attributed to `actor` (its role when a role did it). */
  function applyClose(projectId: number, p: ClosePayload, actor: { user: User; role?: string }, by: Author) {
    const { target, confidence, evidence } = p
    if (target.kind === 'task' && target.number != null) {
      const before = tasks.get(target.slug, target.number)
      if (before.status !== 'done') tasks.update({ user: actor.user, viaClaude: true, role: actor.role }, target.slug, target.number, { status: 'done' })
    } else if (target.kind === 'thread' && target.thread != null) {
      const t = repo.thread(target.thread)
      if (t && t.status !== 'resolved') closeThread(target.thread, by, { as: 'done', reason: evidence })
    }
    activity.record({ projectId, userId: actor.user.id, viaClaude: true, role: actor.role ?? null,
      kind: 'team.close', summary: `closed ${target.label} (${confidence}/10): ${clipText(evidence.replace(/\s+/g, ' '), 160)}`, url: closeUrl(target) })
  }

  /** A one-tap "Close? Yes/No" for people, through the proposals pipeline. */
  function proposeClose(r: RoleRow, p: { id: number; slug: string; name: string }, payload: ClosePayload) {
    if (hasPendingClose(p.id, payload.target.kind, (payload.target.number ?? payload.target.thread)!)) return
    const id = repo.insertProposal({
      projectId: p.id, roleId: r.id, kind: 'close', title: `Close ${payload.target.label}`,
      why: payload.evidence.trim().slice(0, 4000), payload, expiresAt: Math.floor(Date.now() / 1000) + PROPOSAL_DAYS * 86_400, awaiting: 'people',
    })
    for (const uid of members()) {
      void notify(uid, 'needs_you', { title: `${r.name} (${p.name}): close ${payload.target.label}?`, body: clipText(payload.evidence, 140) || 'Close this?', url: '/approvals', tag: `team-proposal:${id}` }).catch(() => {})
    }
    changed(p.id)
    hub.publish('team', { type: 'approvals' })
  }

  /** When a thread is resolved, offer to close the open tasks it produced (through its owner role). */
  function offerCloseLinkedTasks(t: ThreadRow) {
    const owner = t.owner_role_id ? repo.role(t.owner_role_id) : null
    if (!owner || owner.archived) return
    const p = db.prepare('select slug, name from projects where id = ?').get(t.project_id) as { slug: string; name: string }
    for (const x of repo.threadTasks(t.id)) {
      if (x.closed_at) continue
      proposeClose(owner, { id: t.project_id, slug: p.slug, name: p.name },
        { target: { kind: 'task', slug: x.slug, number: x.number, label: `${x.slug}#${x.number}` }, confidence: 0, evidence: `Its thread #${t.id} "${clipText(t.title, 80)}" was resolved.` })
    }
  }

  /** A thread as a role reads it (and marks it seen). */
  function threadText(roleId: number, threadId: number) {
    const { p } = findRole(roleId)
    const t = repo.thread(threadId)
    if (!t || t.project_id !== p.id) throw new AppError(404, 'not_found', `There is no thread #${threadId} in this project.`)
    const msgs = repo.messages(threadId)
    if (msgs.length) repo.seen(threadId, roleId, msgs.at(-1)!.id)
    const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')
    const proposals = repo.threadProposals(threadId)
    const linked = repo.threadTasks(threadId)
    return [
      `# Thread #${t.id}: ${t.title}`,
      `Status: ${t.status === 'resolved' ? `closed (${t.closed_as ?? 'done'}) by ${t.closed_by ?? 'someone'}` : 'open'}${t.needs_people ? ', waiting for people' : ''} · owner: ${t.owner_name ?? 'nobody (people decide)'} · opened by ${t.opened_by}`,
      t.priority === 'blocker' ? '**BLOCKER** — a person marked this top priority: deal with it before other work this shift.' : '',
      t.ask && t.needs_people ? `**Decision asked of people:** ${t.ask}` : '',
      ...msgs.map((m) => `## ${m.author_label} · ${m.kind} · ${day(m.created_at)}\n${m.body}${m.evidence ? `\n\nEvidence:\n${m.evidence}` : ''}`),
      linked.length ? `## Tasks for this thread (the work it turned into — track status there, don't repeat it here)\n${linked.map((x) => `- ${x.slug}#${x.number} ${x.title} [${x.status}]`).join('\n')}` : '',
      proposals.length ? `## Proposals in this thread\n${proposals.map((x) => `- [${x.status}] ${x.title}${x.reply ? ` (reply: "${x.reply}")` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
  }

  // ---- Data sources: read-only, keys never leave the server ----

  const sourceDto = (x: SourceRow) => {
    const c = json<SourceConfig>(x.config, {})
    return { id: x.id, name: x.name, kind: x.kind, description: x.description, config: c, hasSecret: !!x.secret, createdAt: x.created_at }
  }
  const secretOf = (x: SourceRow) => (x.secret ? unseal(masterKey, x.secret, `team-source:${x.project_id}`).toString('utf8') : null)
  function checkSource(input: SourceInput) {
    const c = input.config
    if (input.kind === 'sqlite' && !c.path?.startsWith('/')) throw new AppError(400, 'bad_source', 'Give the full path of the SQLite file on the server.')
    if (input.kind === 'http') {
      if (!/^https?:\/\//.test(c.baseUrl ?? '')) throw new AppError(400, 'bad_source', 'Give the API\'s base URL, starting with https://.')
      if (input.secret && !c.secretName) throw new AppError(400, 'bad_source', 'Say where the key goes: a header name (e.g. Authorization) or a query parameter (e.g. key).')
    }
    if (input.kind === 'page' && !/^https?:\/\//.test(c.url ?? '')) throw new AppError(400, 'bad_source', 'Give the page\'s URL, starting with https://.')
    const config: SourceConfig = input.kind === 'sqlite' ? { path: c.path } : input.kind === 'page' ? { url: c.url }
      : input.kind === 'http' ? { baseUrl: c.baseUrl, secretIn: c.secretIn === 'query' ? 'query' : 'header', secretName: c.secretName?.trim() || undefined } : {}
    return JSON.stringify(config)
  }
  const where = (x: SourceRow) => {
    const c = json<SourceConfig>(x.config, {})
    return x.kind === 'postgres' ? 'Postgres database' : x.kind === 'sqlite' ? `SQLite file ${c.path}`
      : x.kind === 'http' ? `API under ${c.baseUrl}${c.secretName ? `, key in ${c.secretIn === 'query' ? 'parameter' : 'header'} ${c.secretName}` : ''}` : `page ${c.url}`
  }
  // A database without its connection string, or an API that names where its key goes but has none.
  const needsKey = (x: SourceRow) => !x.secret && (x.kind === 'postgres' || (x.kind === 'http' && !!json<SourceConfig>(x.config, {}).secretName))
  const keyLater = (x: SourceRow, person: string) =>
    `It has no ${x.kind === 'postgres' ? 'connection string' : 'key'} yet: ask ${person} to paste it on the Team tab (Data sources → ${x.name} → Key). It goes straight to the server, encrypted; nobody sees it again, Claude included.`
  function sourceRef(projectId: number, ref: string | number) {
    const id = typeof ref === 'number' ? ref : /^#?\d+$/.test(ref.trim()) ? Number(ref.trim().replace('#', '')) : null
    const x = id !== null ? repo.source(id) : repo.sourceByName(projectId, String(ref).trim())
    if (!x || x.project_id !== projectId) throw new AppError(404, 'not_found', `There is no source ${ref} in this project. See team_source_list.`)
    return x
  }

  /** Reads a source for a role (or a test from people). Results are text, cut to a size Claude can use. */
  async function readSource(x: SourceRow, what: { sql?: string; path?: string }) {
    const c = json<SourceConfig>(x.config, {})
    if (x.kind === 'postgres') {
      const url = secretOf(x)
      if (!url) throw new AppError(400, 'bad_source', 'This database has no connection string.')
      return queryPostgres(url, what.sql ?? 'select current_database(), now()')
    }
    if (x.kind === 'sqlite') {
      const { runsAs } = on((db.prepare('select slug from projects where id = ?').get(x.project_id) as { slug: string }).slug)
      const sql = readOnlySql(what.sql ?? "select name from sqlite_master where type = 'table' order by name")
      const r = await agents.request<{ fields: string[]; rows: unknown[][]; total: number }>(runsAs.username, { op: 'sqlite.query', path: c.path, sql }, 30_000)
      return rowsText(r.fields, r.rows, r.total)
    }
    if (x.kind === 'http') return fetchHttp(c, secretOf(x), what.path ?? '')
    return fetchPage(c)
  }

  // A role's chat keeps the instructions and tools it was given; after an update it gets the current ones (for its next start).
  for (const t of repo.projects()) {
    const name = projects.bySlug(t.slug).name
    for (const r of repo.roles(t.project_id)) if (r.chat_session_id && repo.session(r.chat_session_id)) claude.configure(r.chat_session_id, sessionTools(r, name))
  }

  return {
    overview(slug: string) {
      const p = projects.bySlug(slug)
      const t = repo.project(p.id)
      const brief = repo.brief(p.id)
      return {
        project: { slug: p.slug, name: p.name },
        enabled: !!t,
        paused: !!t?.paused,
        tz: t?.tz ?? 'UTC',
        runsAs: t ? { id: t.runs_as, name: t.name } : null,
        brief: { body: brief?.body ?? '', updatedAt: brief?.updated_at ?? null, updatedBy: brief?.updated_by ?? null },
        priorities: t?.priorities ?? '',
        closeGuard: t ? closeGuardOf(p.id) : DEFAULT_CLOSE_GUARD,
        decisions: repo.decisions(p.id).map((d) => ({ id: d.id, body: d.body, at: d.created_at, by: d.role_name ?? d.user_name })),
        roles: t ? repo.roles(p.id).map(roleDto) : [],
        goals: t ? repo.goals(p.id).map(goalDto) : [],
        pending: t ? repo.proposals(p.id, 'pending', 200, 'people').length : 0,
        journal: t ? journal(p.id) : [],
        threads: t ? repo.threads(p.id).map(threadDto) : [],
        sources: t ? repo.sources(p.id).map(sourceDto) : [],
        digest: (() => {
          const lead = t && repo.lead(p.id)
          const last = lead ? repo.shifts(lead.id, 5).find((s) => s.status === 'done' && s.report) : undefined
          return lead && last ? { role: { id: lead.id, name: lead.name }, at: last.ended_at ?? last.started_at, report: last.report! } : null
        })(),
      }
    },

    // ---- Threads (people) ----
    thread(id: number) {
      const t = repo.thread(id)
      if (!t) throw new AppError(404, 'not_found', 'No such thread.')
      const p = db.prepare('select slug, name from projects where id = ?').get(t.project_id) as { slug: string; name: string }
      return {
        thread: threadDto(t), project: { slug: p.slug, name: p.name },
        messages: repo.messages(id).map((m) => ({
          id: m.id, kind: m.kind, body: m.body, evidence: m.evidence, at: m.created_at, author: m.author_label,
          role: m.author_role_id ? { id: m.author_role_id } : null, person: !!m.author_user_id && !m.author_session_id && !m.author_role_id,
          sessionId: m.author_session_id,
        })),
        proposals: repo.threadProposals(id).map(proposalDto),
        tasks: repo.threadTasks(id).map((x) => ({ number: x.number, title: x.title, status: x.status, slug: x.slug, done: !!x.closed_at })),
        roles: repo.roles(t.project_id).map((r) => ({ id: r.id, name: r.name })),
      }
    },
    /** The thread a task belongs to, if any (for the task page's "From thread #N"). Injected into the tasks service. */
    taskThread(taskId: number) {
      const r = repo.taskThread(taskId)
      return r ? { id: r.thread_id, title: r.title, status: r.status } : null
    },
    /**
     * A delivery's branch was merged into the default branch (the reviews module detected it on a fetch, or a session
     * reported it). Note it on the code proposal's thread so the topic stays in one place; if it has none, tell the role.
     */
    noteDeliveryMerged(sessionId: string, mergeCommit: string | null) {
      const x = repo.proposalBySession(sessionId)
      if (!x) return
      const where = mergeCommit ? ` (${mergeCommit.slice(0, 7)})` : ''
      if (x.thread_id && repo.thread(x.thread_id)) {
        repo.insertMessage({ threadId: x.thread_id, kind: 'fyi', label: 'DevDash', evidence: null,
          body: `The work for "${clipText(x.title, 80)}" was merged into the default branch${where}. Its "Ready to review" card is cleared.` })
        repo.touchThread(x.thread_id)
      } else {
        repo.addNote(x.role_id, `Your branch for "${clipText(x.title, 80)}" was merged into the default branch${where}. The review card is cleared.`, {})
      }
      changed(x.project_id)
    },
    /** Link a task to a thread, or unlink it (by hand, as a person) — the two-way "one job per object" link. */
    linkTaskAsPerson(user: User, threadId: number, taskNumber: number, unlink = false) {
      const t = repo.thread(threadId)
      if (!t) throw new AppError(404, 'not_found', 'No such thread.')
      return linkTaskToThread(t, taskNumber, { kind: 'person', user }, unlink)
    },
    postAsPerson(user: User, slug: string, input: MessageInput) {
      const { p } = on(slug)
      return message(p.id, { kind: 'person', user }, input)
    },
    resolveAsPerson(user: User, id: number, resolution: string, as: CloseAs = 'done', duplicateOf?: number) {
      closeThread(id, { kind: 'person', user }, { as, reason: resolution, duplicateOf })
    },
    reopen(user: User, id: number) {
      const t = repo.thread(id)
      if (!t) throw new AppError(404, 'not_found', 'No such thread.')
      if (t.status === 'open') return
      repo.threadState(id, 'open', null)
      repo.insertMessage({ threadId: id, kind: 'fyi', body: `Reopened by ${user.name}.`, evidence: null, label: user.name, userId: user.id })
      changed(t.project_id)
    },
    /** A person marks a thread a blocker (or clears it): the owning role treats it as top priority this shift. */
    setThreadPriority(user: User, id: number, priority: 'normal' | 'blocker') {
      const t = repo.thread(id)
      if (!t) throw new AppError(404, 'not_found', 'No such thread.')
      if (t.priority === priority) return
      repo.setThreadPriority(id, priority)
      repo.insertMessage({ threadId: id, kind: 'fyi', body: priority === 'blocker' ? `${user.name} marked this a blocker: top priority.` : `${user.name} cleared the blocker.`, evidence: null, label: user.name, userId: user.id })
      // Wake the owner so it picks up the new priority straight away.
      const owner = t.owner_role_id ? repo.role(t.owner_role_id) : undefined
      if (priority === 'blocker' && owner && !owner.archived) auto(owner, `a blocker in thread "${clipText(t.title, 80)}"`, t.id)
      changed(t.project_id)
    },
    /** All of a project's threads, open and closed, a page at a time (`offset` is the cursor `next` gave). */
    threads(slug: string, f: ThreadFilter, offset = 0) {
      const p = projects.bySlug(slug)
      const rows = repo.threadList(p.id, f, THREADS_PAGE + 1, offset)
      return {
        project: { slug: p.slug, name: p.name },
        threads: rows.slice(0, THREADS_PAGE).map(threadDto),
        next: rows.length > THREADS_PAGE ? offset + THREADS_PAGE : null,
        counts: repo.threadCounts(p.id),
        roles: repo.roles(p.id).map((r) => ({ id: r.id, name: r.name })),
      }
    },

    // ---- Data sources (people) ----
    /** keyLater: a Claude session adds it and the person pastes the key on the Team tab, so it never passes through the chat. */
    addSource(user: User, slug: string, input: SourceInput, o: { keyLater?: boolean } = {}) {
      const { p } = on(slug)
      if (repo.sourceByName(p.id, input.name)) throw new AppError(409, 'taken', `There is already a source called ${input.name}.`)
      const secret = input.secret?.trim() ? seal(masterKey, Buffer.from(input.secret.trim()), `team-source:${p.id}`) : null
      if (input.kind === 'postgres' && !secret && !o.keyLater) throw new AppError(400, 'bad_source', 'Give the connection string (postgres://user:password@host:5432/db), ideally a read-only user.')
      const id = repo.insertSource(p.id, { name: input.name.trim(), kind: input.kind, description: input.description.trim(), config: checkSource(input), secret }, user.id)
      changed(p.id)
      return id
    },
    updateSource(id: number, input: Omit<SourceInput, 'kind'>) {
      const x = repo.source(id)
      if (!x) throw new AppError(404, 'not_found', 'No such source.')
      const secret = input.secret?.trim() ? seal(masterKey, Buffer.from(input.secret.trim()), `team-source:${x.project_id}`) : null
      repo.updateSource(id, { name: input.name.trim(), description: input.description.trim(), config: checkSource({ ...input, kind: x.kind }), secret })
      changed(x.project_id)
    },
    removeSource(id: number) {
      const x = repo.source(id)
      if (!x) throw new AppError(404, 'not_found', 'No such source.')
      repo.removeSource(id)
      changed(x.project_id)
    },
    /** Tries a source the way a role would: a first look at what's there. */
    async testSource(id: number) {
      const x = repo.source(id)
      if (!x) throw new AppError(404, 'not_found', 'No such source.')
      const text = await readSource(x, {})
      return { preview: text.slice(0, 2000) }
    },

    /** Team on for a project; its roles run as whoever turns it on (their Linux account and Claude plan). */
    enable(user: User, slug: string, tz?: string) {
      const p = projects.bySlug(slug)
      const fresh = !repo.project(p.id)
      repo.enable(p.id, user.id)
      // Triggers start from now: turning Team on doesn't replay old activity.
      if (fresh) repo.activitySeen(p.id, repo.lastActivity())
      if (tz && validTz(tz)) repo.projectSettings(p.id, { tz })
      changed(p.id)
    },
    disable(slug: string) {
      const p = projects.bySlug(slug)
      repo.disable(p.id)
      changed(p.id)
    },
    settings(slug: string, o: { paused?: boolean; tz?: string }) {
      const { p } = on(slug)
      if (o.tz !== undefined && !validTz(o.tz)) throw new AppError(400, 'bad_tz', 'Unknown time zone.')
      repo.projectSettings(p.id, o)
      changed(p.id)
    },

    saveBrief(user: User, slug: string, body: string) {
      const p = projects.bySlug(slug)
      repo.saveBrief(p.id, body.trim(), user.id)
      changed(p.id)
    },
    /** The founder's "what matters now", in their words: it outranks the roles' own plans in every role's context. */
    savePriorities(slug: string, body: string) {
      const { p } = on(slug)
      repo.savePriorities(p.id, body.trim().slice(0, 4000))
      changed(p.id)
    },
    addDecision(user: User, slug: string, body: string) {
      const p = projects.bySlug(slug)
      repo.addDecision(p.id, body.trim(), { userId: user.id })
      changed(p.id)
    },
    removeDecision(slug: string, id: number) {
      const p = projects.bySlug(slug)
      repo.removeDecision(p.id, id)
      changed(p.id)
    },

    addGoal(slug: string, g: { title: string; measure: string; due: string | null }) {
      const { p } = on(slug)
      repo.insertGoal(p.id, { title: g.title.trim(), measure: g.measure.trim(), due: validDue(g.due), ownerRoleId: null })
      changed(p.id)
    },
    updateGoal(id: number, g: { status?: GoalRow['status']; progress?: number; note?: string }) {
      const goal = repo.goal(id)
      if (!goal) throw new AppError(404, 'not_found', 'No such goal.')
      repo.updateGoal(id, g)
      changed(goal.project_id)
    },
    /** Edit a goal's wording and schedule too — title, measure, due — plus status/progress/note; only the given fields change. */
    editGoal(id: number, g: { title?: string; measure?: string; due?: string | null; status?: GoalRow['status']; progress?: number; note?: string }) {
      const goal = repo.goal(id)
      if (!goal) throw new AppError(404, 'not_found', 'No such goal.')
      repo.editGoal(id, {
        title: g.title !== undefined ? g.title.trim().slice(0, 200) : goal.title,
        measure: g.measure !== undefined ? g.measure.trim().slice(0, 300) : goal.measure,
        due: g.due !== undefined ? validDue(g.due) : goal.due,
        status: g.status && (['active', 'done', 'dropped'] as const).includes(g.status) ? g.status : goal.status,
        progress: g.progress !== undefined ? Math.max(0, Math.min(100, Math.round(g.progress))) : goal.progress,
        note: g.note !== undefined ? g.note.slice(0, 300) : goal.note,
      })
      changed(goal.project_id)
    },

    /** Instructions for a role, drafted by Claude from its name, one line and what the team knows about the project. */
    async generate(user: User, slug: string, name: string, summary: string) {
      const p = projects.bySlug(slug)
      const prompt = generatePrompt({
        project: p.name, brief: repo.brief(p.id)?.body ?? '', name, summary,
        others: repo.roles(p.id).filter((r) => r.name !== name).map((r) => `${r.name}${r.summary ? ` (${r.summary})` : ''}`),
      })
      return { instructions: await claude.complete(user.username, prompt, { system: GENERATE_SYSTEM, model: 'sonnet', profile: profileOf(user) }) }
    },

    createRole(user: User, slug: string, input: RoleInput & { schedule?: unknown[] }) {
      const { p } = on(slug)
      const id = repo.insertRole(p.id, input, user.id)
      // The first CEO leads unless someone else already does.
      if (input.name.trim().toUpperCase() === 'CEO' && !repo.lead(p.id)) repo.setLead(p.id, id, true)
      if (input.schedule) {
        const r = repo.role(id)!
        repo.roleSettings(id, { ...settingsOf(r), schedule: validSlots(input.schedule) })
      }
      changed(p.id)
      return roleDto(repo.role(id)!)
    },
    updateRole(id: number, input: RoleInput) {
      const { r, p } = findRole(id)
      repo.updateRole(id, input)
      const next = repo.role(id)!
      // Its chat picks up the new instructions the next time Claude starts for it.
      if (r.chat_session_id && repo.session(r.chat_session_id)) claude.configure(r.chat_session_id, { title: next.name, ...sessionTools(next, p.name) })
      changed(p.id)
      return roleDto(next)
    },
    roleSettings(id: number, o: RoleSettingsInput) {
      const { r, p } = findRole(id)
      repo.roleSettings(id, {
        autonomy: o.autonomy === 'advisor' ? 'advisor' : 'operator',
        autoApprove: o.autoApprove.filter((k) => k === 'code' || k === 'goal'),
        schedule: validSlots(o.schedule),
        triggers: o.triggers.filter((t) => (TRIGGERS as readonly string[]).includes(t)),
        paused: o.paused, dailyLimit: Math.max(0, Math.min(48, Math.round(o.dailyLimit))),
        monthlyBudget: o.monthlyBudget === null ? null : Math.max(0, o.monthlyBudget),
        selfClose: o.selfClose && (['default', 'always_ask', 'allow'] as const).includes(o.selfClose) ? o.selfClose : settingsOf(r).selfClose,
      })
      if (o.lead !== undefined && o.lead !== !!r.lead) repo.setLead(p.id, id, o.lead)
      const next = repo.role(id)!
      // Every chat that's open gets its role's current instructions (being the lead changes two roles at once).
      for (const x of repo.roles(p.id)) {
        if (x.chat_session_id && repo.session(x.chat_session_id)) claude.configure(x.chat_session_id, sessionTools(x, p.name))
      }
      changed(p.id)
      return roleDto(next)
    },
    archiveRole(id: number) {
      const { p } = findRole(id)
      repo.archiveRole(id)
      changed(p.id)
    },

    role(id: number) {
      const { r, p } = findRole(id)
      const t = repo.project(p.id)
      return {
        role: { ...roleDto(r), instructions: r.instructions, createdAt: r.created_at },
        project: { slug: p.slug, name: p.name, tz: t?.tz ?? 'UTC', paused: !!t?.paused },
        shifts: repo.shifts(id, 30).map((s) => ({
          id: s.id, trigger: s.trigger, status: s.status, report: s.report, startedAt: s.started_at, endedAt: s.ended_at, sessionId: s.session_id, costUsd: s.cost_usd,
        })),
        notebook: repo.notebook(id).map((n) => ({ id: n.id, body: n.body, by: n.source === 'person' ? n.user_name : null, at: n.created_at })),
        proposals: repo.proposals(p.id, 'pending').filter((x) => x.role_id === id).map(proposalDto),
      }
    },

    runShift: (id: number) => runShift(id),

    /** The role's chat: one long conversation the whole team shares. Made the first time someone opens it. */
    async chat(id: number) {
      const { r, p } = findRole(id)
      if (r.chat_session_id && repo.session(r.chat_session_id)) return { sessionId: r.chat_session_id }
      const { runsAs } = on(p.slug)
      const s = await claude.create(runsAs, {
        prompt: '', images: [], cwd: '', profile: profileOf(runsAs), model: r.model, effort: null,
        permissionMode: 'dontAsk', mode: 'chat', project: p.slug,
      }, { title: r.name, ...sessionTools(r, p.name), listed: false, shared: true, sharedCanSend: true })
      repo.setChat(r.id, s.id)
      changed(p.id)
      return { sessionId: s.id }
    },

    addNote(user: User, id: number, body: string) {
      const { p } = findRole(id)
      repo.addNote(id, body.trim(), { userId: user.id })
      changed(p.id)
    },
    removeNote(id: number, noteId: number) {
      const { p } = findRole(id)
      repo.removeNote(id, noteId)
      changed(p.id)
    },

    // ---- Approvals ----
    // People see only proposals awaiting a person; the ones the lead can clear stay off their list.
    approvals: (status: 'pending' | 'decided', slug?: string) =>
      repo.proposals(slug ? projects.bySlug(slug).id : null, status, status === 'pending' ? 200 : 40, status === 'pending' ? 'people' : null).map(proposalDto),
    pendingCount: () => repo.pendingCount(),
    /** Each project with any proposals: how many wait, how many are decided, who's waiting, and when it last stirred. */
    approvalProjects() {
      const byProject = new Map<number, { id: number; name: string }[]>()
      for (const r of repo.proposalRoles()) {
        const list = byProject.get(r.project_id) ?? []
        list.push({ id: r.id, name: r.name })
        byProject.set(r.project_id, list)
      }
      return repo.proposalProjects().map((p) => ({
        slug: p.slug, name: p.name, pending: p.pending, decided: p.decided, cleared: p.cleared, lastAt: p.last_at, roles: byProject.get(p.project_id) ?? [],
      }))
    },
    /** A person answers a proposal. Either way the role finds the answer (and the reason) in its notebook. */
    async decide(user: User, id: number, approve: boolean, reply: string) {
      const x = repo.proposal(id)
      if (!x) throw new AppError(404, 'not_found', 'No such proposal.')
      if (x.status !== 'pending') throw new AppError(409, 'decided', `Already ${x.status === 'expired' ? 'expired' : 'answered'}.`)
      const note = reply.trim()
      if (approve) {
        const outcome = await execute(x, user)
        repo.decide(id, 'done', { reply: note || null, outcome, by: user.id })
        repo.addNote(x.role_id, `Approved by ${user.name}: ${x.title}${note ? `. They said: "${note}"` : ''}`, {})
      } else {
        repo.decide(id, 'rejected', { reply: note || null, by: user.id })
        repo.addNote(x.role_id, `Rejected by ${user.name}: ${x.title}. ${note ? `Reason: "${note}"` : 'No reason given.'}`, {})
      }
      changed(x.project_id)
      hub.publish('team', { type: 'approvals' })
      return proposalDto(repo.proposal(id)!)
    },

    // ---- What roles call from their sessions (the DevDash plugin's team tools) ----

    /** The role a session belongs to, if the session is one of its own and runs as `username`. */
    roleOf(username: string, sessionId: string | null) {
      if (!sessionId) return null
      const r = repo.roleBySession(sessionId)
      const s = repo.session(sessionId)
      const owner = s && userById(s.owner_id)
      if (!r || !owner || owner.username !== username) return null
      return { r, p: findRole(r.id).p }
    },

    /** Everything a role reads at the start of a chat or shift, as one Markdown page. */
    context(roleId: number) {
      const { r, p } = findRole(roleId)
      const last = repo.lastShiftAt(r.id)
      const since = last ?? Math.floor(Date.now() / 1000) - 7 * 86_400
      const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
      const brief = repo.brief(p.id)?.body.trim()
      const priorities = repo.project(p.id)?.priorities.trim()
      const toApprove = r.lead ? repo.proposals(p.id, 'pending', 50, 'lead') : []
      const others = repo.roles(p.id).filter((x) => x.id !== r.id)
      const notes = repo.notebook(r.id, 60)
      const decisions = repo.decisions(p.id, 20)
      const goals = repo.goals(p.id).filter((g) => g.status === 'active')
      const waiting = repo.proposals(p.id, 'pending').filter((x) => x.role_id === r.id)
      const lines = journal(p.id, since, 40)
      const latest = (x: RoleRow) => repo.shifts(x.id, 3).find((s) => s.status !== 'running' && s.report)
      const mine = repo.roleThreads(r.id)
      const openThreads = repo.threads(p.id).filter((t) => t.status === 'open' && !mine.some((m) => m.id === t.id))
      const closed = repo.roleClosed(r.id, since)
      return [
        `# ${p.name}: team context (${day(Date.now() / 1000)} UTC)`,
        ...(priorities ? [`## What matters now (the founder's priorities — these outrank your own plans)\n${priorities}`] : []),
        `## Brief\n${brief || '(No brief yet. Ask the team for one, or suggest one in your report.)'}`,
        `## Goals\n${goals.length ? goals.map((g) => `- #${g.id} ${g.title}${g.measure ? ` (measure: ${g.measure})` : ''}${g.due ? `, due ${g.due}` : ''}: ${g.progress}%${g.note ? `, ${g.note}` : ''}${g.owner_name ? ` [owner: ${g.owner_name}]` : ''}`).join('\n') : '(none yet: propose some with team_propose, kind "goal")'}`,
        `## Decisions, newest first\n${decisions.length ? decisions.map((d) => `- ${d.body} (${d.role_name ?? d.user_name ?? 'someone'}, ${day(d.created_at)})`).join('\n') : '(none yet)'}`,
        `## The team\n- You: ${r.name}${r.summary ? `: ${r.summary}` : ''}\n${others.map((x) => {
          const s = latest(x)
          return `- ${x.name}${x.summary ? `: ${x.summary}` : ''}${s ? `\n  Latest report (${day(s.ended_at ?? s.started_at)}): ${clipText(s.report!.replace(/\s+/g, ' '), 600)}` : ''}`
        }).join('\n')}`.trim(),
        `## Your proposals waiting for people\n${waiting.length ? waiting.map((x) => `- [${x.kind}] ${x.title} (since ${day(x.created_at)})${x.awaiting === 'lead' ? ' — with the lead' : ''}`).join('\n') : '(none)'}`,
        ...(r.lead ? [`## Proposals awaiting your approval (you can clear these for the team — team_decide)\n${toApprove.length ? toApprove.map((x) => `- #${x.id} [${x.kind}] ${x.title} — from ${x.role_name}: ${clipText(x.why.replace(/\s+/g, ' '), 200)}`).join('\n') : '(none)'}`] : []),
        `## Your threads\n${mine.length ? mine.map((t) => `- #${t.id} ${t.title}${t.priority === 'blocker' ? ' [BLOCKER — top priority this shift]' : ''}${t.owner_role_id === r.id ? ' (you own it)' : ' (you\'re in it: you may decline it)'}${t.needs_people ? ' (waiting for people)' : ''}${(t.last_id ?? 0) > t.seen ? ' — NEW MESSAGES: read with team_thread' : ''}`).join('\n') : '(none)'}`,
        ...(closed.length ? [`## Your threads closed since your last shift (people may reopen them)\n${closed.map((t) => `- #${t.id} ${t.title}: ${t.closed_as === 'done' || !t.closed_as ? 'resolved' : `closed as ${t.closed_as.replace('_', ' ')}`} by ${t.closed_by ?? 'someone'}${t.resolution ? ` (${clipText(t.resolution, 200)})` : ''}`).join('\n')}`] : []),
        `## Open threads owned by others (don't post in these unless asked; if you have something, team_message the owner)\n${openThreads.length ? openThreads.map((t) => `- #${t.id} ${t.title}${t.priority === 'blocker' ? ' [blocker]' : ''} (owner: ${t.owner_name ?? 'people'})`).join('\n') : '(none)'}`,
        `## Data sources\n${repo.sources(p.id).length ? repo.sources(p.id).map((x) => `- ${x.name} (${x.kind})${x.description ? `: ${x.description}` : ''}`).join('\n') : '(none yet)'}`,
        `## Your notebook, newest first\n${notes.length ? notes.map((n) => `- ${n.body}${n.source === 'person' ? ` (${n.user_name ?? 'a person'})` : ''} [${day(n.created_at)}]`).join('\n') : '(empty)'}`,
        `## What happened ${last ? `since your last shift (${day(last)})` : 'in the last 7 days'}\n${lines.length ? lines.map((l) => `- ${day(l.at)} ${l.who ? `${l.who}: ` : ''}${l.text}`).join('\n') : '(nothing recorded)'}`,
        'Tasks and notes: use tasks_list, task_get and notes_list.',
      ].join('\n\n')
    },
    roleNote(roleId: number, body: string) {
      const { p } = findRole(roleId)
      repo.addNote(roleId, body.trim().slice(0, 2000), {})
      changed(p.id)
    },
    roleDecision(roleId: number, body: string) {
      const { p } = findRole(roleId)
      repo.addDecision(p.id, body.trim().slice(0, 2000), { roleId })
      changed(p.id)
    },
    propose,
    /** A role records progress it measured on a goal (it can mark it done, not drop it). */
    roleGoalUpdate(roleId: number, g: { id: number; progress?: number; note?: string; done?: boolean }) {
      const { p } = findRole(roleId)
      const goal = repo.goal(g.id)
      if (!goal || goal.project_id !== p.id) throw new AppError(404, 'not_found', `There is no goal #${g.id} in this project.`)
      repo.updateGoal(g.id, {
        progress: g.progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(g.progress))),
        note: g.note?.slice(0, 300), status: g.done ? 'done' : undefined,
      })
      changed(p.id)
    },
    roleMessage(roleId: number, sessionId: string, input: MessageInput) {
      const { p } = findRole(roleId)
      return message(p.id, { kind: 'role', roleId, sessionId }, input)
    },
    roleThread: (roleId: number, threadId: number) => threadText(roleId, threadId),
    roleResolve(roleId: number, threadId: number, resolution: string, as: CloseAs = 'done', duplicateOf?: number) {
      const { p } = findRole(roleId)
      const t = repo.thread(threadId)
      if (!t || t.project_id !== p.id) throw new AppError(404, 'not_found', `There is no thread #${threadId} in this project.`)
      closeThread(threadId, { kind: 'role', roleId }, { as, reason: resolution, duplicateOf })
    },
    /** A role links a task to a thread it's on (or unlinks it): one job per object. */
    roleLinkTask(roleId: number, threadId: number, taskNumber: number, unlink = false) {
      const { p } = findRole(roleId)
      const t = repo.thread(threadId)
      if (!t || t.project_id !== p.id) throw new AppError(404, 'not_found', `There is no thread #${threadId} in this project.`)
      if (t.owner_role_id !== roleId && !repo.threadRoles(t.id).some((r) => r.id === roleId)) {
        throw new AppError(403, 'not_in_thread', `You're not on thread #${t.id}: only its owner and the roles in it link tasks to it.`)
      }
      return linkTaskToThread(t, taskNumber, { kind: 'role', roleId }, unlink)
    },
    /**
     * A role closes a task or thread with a confidence score (1-10) and evidence. Confidence 8+ from an allowed role (an
     * operator, or one set to "allow") closes it directly and logs it, reopenable. Otherwise — low confidence, an advisor
     * or "always ask" role, a thread still waiting for people, or a guarded topic (money, production, a person's decision) —
     * it becomes a one-tap "Close? Yes/No" for people. No more comment-style "I suggest closing this".
     */
    roleClose(roleId: number, target: { task?: number; thread?: number }, confidence: number, evidence: string) {
      const { r, p } = findRole(roleId)
      const { runsAs } = on(p.slug)
      const conf = Math.max(1, Math.min(10, Math.round(confidence)))
      const ev = evidence.trim()
      if (!ev) throw new AppError(400, 'evidence', 'Give the evidence for closing it: a commit in the default branch, a resolved thread, or data from a source.')
      let payload: ClosePayload
      let text = ''
      let byPerson = false
      let waiting = false
      if (target.task != null) {
        const t = tasks.get(p.slug, target.task) // throws 404 if there's no such task
        if (t.status === 'done') throw new AppError(409, 'closed', `${t.key} is already done.`)
        text = `${t.title}\n${t.body}`
        byPerson = !t.creatorRole || !!t.assignee // a person created it, or it's assigned to a person
        payload = { target: { kind: 'task', slug: p.slug, number: t.number, label: t.key }, confidence: conf, evidence: ev }
      } else if (target.thread != null) {
        const th = repo.thread(target.thread)
        if (!th || th.project_id !== p.id) throw new AppError(404, 'not_found', `There is no thread #${target.thread} in this project.`)
        if (th.status === 'resolved') throw new AppError(409, 'closed', `Thread #${th.id} is already closed.`)
        if (th.owner_role_id !== roleId) throw new AppError(403, 'not_owner', `Only the owner closes thread #${th.id} as done. If it isn't yours, decline it with team_resolve.`)
        text = th.title
        waiting = !!th.needs_people
        payload = { target: { kind: 'thread', slug: p.slug, thread: th.id, label: `thread #${th.id}` }, confidence: conf, evidence: ev }
      } else {
        throw new AppError(400, 'bad_args', 'Give a task number or a thread id to close.')
      }
      const concern = closeConcern(closeGuardOf(p.id), { text, byPerson })
      payload.concern = concern
      const mustAsk = !!concern || conf < SELF_CLOSE_MIN || !canSelfClose(settingsOf(r)) || waiting
      if (mustAsk) {
        proposeClose(r, p, payload)
        const why = concern ? ` — ${concern}` : conf < SELF_CLOSE_MIN ? ' (confidence under 8)' : waiting ? ' (it waits for people)' : ' (you ask before closing)'
        return `Asked the team to close ${payload.target.label}${why}. They'll see a one-tap Close? Yes/No with your evidence.`
      }
      applyClose(p.id, payload, { user: runsAs, role: r.name }, { kind: 'role', roleId })
      return `Closed ${payload.target.label} as done (${conf}/10). It's logged and can be reopened in one tap.`
    },
    /** A task was closed (board, commit or a close proposal): offer to close the open thread it came from. */
    taskClosed(taskId: number) {
      const link = repo.taskThread(taskId)
      if (!link) return
      const t = repo.thread(link.thread_id)
      if (!t || t.status !== 'open') return
      const owner = t.owner_role_id ? repo.role(t.owner_role_id) : null
      if (!owner || owner.archived) return
      const p = db.prepare('select slug, name from projects where id = ?').get(t.project_id) as { slug: string; name: string }
      proposeClose(owner, { id: t.project_id, slug: p.slug, name: p.name },
        { target: { kind: 'thread', slug: p.slug, thread: t.id, label: `thread #${t.id}` }, confidence: 0, evidence: `Its linked task was closed.` })
    },
    /** The founder's per-project guard: which kinds of close always need a person, whatever the confidence. */
    setCloseGuard(slug: string, guard: Partial<CloseGuard>) {
      const { p } = on(slug)
      repo.setCloseGuard(p.id, JSON.stringify({ ...DEFAULT_CLOSE_GUARD, ...closeGuardOf(p.id), ...guard }))
      changed(p.id)
    },
    /** The lead clears a routine proposal for the team: approve (runs it), reject (with a reason), or escalate to people. */
    async leadDecide(roleId: number, id: number, action: 'approve' | 'reject' | 'escalate', reason: string) {
      const { r, p } = findRole(roleId)
      if (!r.lead) throw new AppError(403, 'not_lead', 'Only the team lead clears proposals. Put your view in the thread or your report instead.')
      const { runsAs } = on(p.slug)
      const x = repo.proposal(id)
      if (!x || x.project_id !== p.id) throw new AppError(404, 'not_found', `There is no proposal #${id} in this project.`)
      if (x.status !== 'pending' || x.awaiting !== 'lead') throw new AppError(409, 'not_awaiting', `Proposal #${id} isn't waiting for you to clear.`)
      const note = reason.trim().replace(/\s+/g, ' ').slice(0, 1000)
      if (action === 'approve') {
        const outcome = await execute(x, runsAs)
        repo.decide(id, 'done', { reply: note || null, outcome, by: null, byRole: r.id })
        repo.addNote(x.role_id, `Approved by ${r.name} (lead): ${x.title}${note ? `. They said: "${note}"` : ''}`, {})
        changed(p.id)
        hub.publish('team', { type: 'approvals' })
        return `Approved for the team. ${outcome}`
      }
      if (action === 'reject') {
        repo.decide(id, 'rejected', { reply: note || null, by: null, byRole: r.id })
        repo.addNote(x.role_id, `Rejected by ${r.name} (lead): ${x.title}. ${note ? `Reason: "${note}"` : 'No reason given.'}`, {})
        changed(p.id)
        hub.publish('team', { type: 'approvals' })
        return `Rejected. ${x.role_name} will see your reason in its notebook.`
      }
      // Escalate: it becomes a person's call and their phones go off, as a normal proposal would.
      repo.setProposalAwaiting(id, 'people')
      for (const uid of members()) {
        void notify(uid, 'needs_you', { title: `${x.role_name} (${p.name}): ${x.title}`, body: note ? `${r.name} escalated: ${note}` : `${r.name} escalated this to you`, url: '/approvals', tag: `team-proposal:${id}` }).catch(() => {})
      }
      changed(p.id)
      hub.publish('team', { type: 'approvals' })
      return 'Escalated to people. It now waits for them.'
    },
    roleSources(roleId: number) {
      const { p } = findRole(roleId)
      const list = repo.sources(p.id)
      if (!list.length) return 'No data sources yet. People add them on the Team tab (a read-only database, an API, a page to watch).'
      return list.map((x) => `- ${x.name} (${x.kind === 'postgres' || x.kind === 'sqlite' ? `${x.kind} database: team_query` : x.kind === 'http' ? `API under ${json<SourceConfig>(x.config, {}).baseUrl}: team_fetch with a path` : 'public page: team_fetch'})${x.description ? `: ${x.description}` : ''}`).join('\n')
    },
    async roleRead(roleId: number, name: string, what: { sql?: string; path?: string }) {
      const { p } = findRole(roleId)
      const x = repo.sourceByName(p.id, name)
      if (!x) throw new AppError(404, 'not_found', `There is no source called ${name}. See team_sources.`)
      if ((x.kind === 'postgres' || x.kind === 'sqlite') && !what.sql) throw new AppError(400, 'bad_args', `${x.name} is a database: use team_query with SQL.`)
      return readSource(x, what)
    },

    /** Team-on projects' Claude sessions (not roles) can message roles; this says whether a session may, and as whom. */
    sessionAuthor(username: string, sessionId: string | null) {
      if (!sessionId) return null
      const s = repo.session(sessionId)
      const owner = s && userById(s.owner_id)
      if (!s?.project_id || !owner || owner.username !== username || !repo.project(s.project_id) || repo.roleBySession(sessionId)) return null
      return { projectId: s.project_id, author: { kind: 'session' as const, sessionId, title: s.title, owner } }
    },
    // ---- Managing roles from a person's own Claude session ("make us a Finance role"). Never from a role's session. ----

    /** The project's roles for a session, as Markdown, with what each one does and when it works. */
    sessionRoles(username: string, sessionId: string) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const t = repo.project(who.projectId)!
      const roles = repo.roles(who.projectId)
      if (!roles.length) return 'No roles yet. Create one with team_role_create.'
      return roles.map((r) => {
        const s = settingsOf(r)
        const when = s.paused ? 'paused' : s.schedule.length ? s.schedule.map((x) => `${x.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(',')} ${x.at}`).join('; ') + ` (${t.tz})` : 'no schedule'
        return `- #${r.id} ${r.name}${s.lead ? ' (lead)' : ''}: ${r.summary || '(no summary)'}\n  works: ${when}; ${s.autonomy}; model ${r.model ?? 'default'}${s.triggers.length ? `; also wakes on ${s.triggers.join(', ')}` : ''}`
      }).join('\n')
    },

    /** Creates a role as the session's owner (the same as on the Team tab). Without instructions, Generate writes them. */
    async sessionCreateRole(username: string, sessionId: string, input: { name: string; summary?: string; instructions?: string; model?: string | null; schedule?: unknown[] }) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const p = db.prepare('select slug, name from projects where id = ?').get(who.projectId) as { slug: string; name: string }
      if (repo.roles(who.projectId).some((r) => r.name.toLowerCase() === input.name.trim().toLowerCase())) {
        throw new AppError(409, 'taken', `There is already a role called ${input.name}. Change it with team_role_update.`)
      }
      const owner = who.author.owner
      const summary = (input.summary ?? '').trim().slice(0, 300)
      const instructions = input.instructions?.trim() || (await this.generate(owner, p.slug, input.name, summary)).instructions
      const model = input.model && (MODELS as readonly string[]).includes(input.model) ? input.model : null
      const role = this.createRole(owner, p.slug, {
        name: input.name.trim().slice(0, 60), summary, instructions, model,
        schedule: input.schedule?.length ? input.schedule : [{ days: [1, 2, 3, 4, 5], at: '09:00' }],
      })
      tell(`${p.name}: ${owner.name}'s Claude added a role`, `${role.name}${summary ? `: ${summary}` : ''}`, `/projects/${p.slug}/team/${role.id}`, `team-role:${role.id}`, 'shared')
      return `Created #${role.id} ${role.name}. It works ${role.schedule.length ? 'on its schedule' : 'when started'}; see and change it at /projects/${p.slug}/team/${role.id}.\n\nInstructions:\n${instructions}`
    },

    /** Changes a role from a member's session: its words, model, schedule, triggers, autonomy, lead, pause, limits, budget
     *  and auto-approve. `project` picks the project (else the session's own). Full member authority, as on the Team tab. */
    sessionUpdateRole(username: string, sessionId: string, input: {
      role: string | number; name?: string; summary?: string; instructions?: string; model?: string | null
      schedule?: unknown[]; triggers?: string[]; autonomy?: string; paused?: boolean; lead?: boolean
      project?: string; dailyLimit?: number; monthlyBudget?: number | null; autoApprove?: string[]; selfClose?: SelfClose
    }) {
      const who = this.sessionActor(username, sessionId, input.project)
      const r = typeof input.role === 'number' ? repo.role(input.role) : roleNamed(who.projectId, String(input.role))
      if (!r || r.archived || r.project_id !== who.projectId) throw new AppError(404, 'not_found', `There is no role ${input.role} in this project. See team_roles.`)
      if (input.name !== undefined || input.summary !== undefined || input.instructions !== undefined || input.model !== undefined) {
        this.updateRole(r.id, {
          name: input.name?.trim().slice(0, 60) || r.name, summary: input.summary?.trim().slice(0, 300) ?? r.summary,
          instructions: input.instructions?.trim() || r.instructions,
          model: input.model === undefined ? r.model : input.model && (MODELS as readonly string[]).includes(input.model) ? input.model : null,
        })
      }
      const s = settingsOf(repo.role(r.id)!)
      this.roleSettings(r.id, {
        ...s,
        autoApprove: input.autoApprove ? input.autoApprove.filter((k) => k === 'code' || k === 'goal') : s.autoApprove,
        autonomy: input.autonomy === 'advisor' || input.autonomy === 'operator' ? input.autonomy : s.autonomy,
        schedule: input.schedule ?? s.schedule, triggers: input.triggers ?? s.triggers,
        paused: input.paused ?? s.paused, lead: input.lead,
        dailyLimit: input.dailyLimit ?? s.dailyLimit,
        monthlyBudget: input.monthlyBudget !== undefined ? input.monthlyBudget : s.monthlyBudget,
        selfClose: input.selfClose ?? s.selfClose,
      })
      return `Updated ${repo.role(r.id)!.name}.`
    },

    // ---- Data sources from a person's own Claude session ("connect our database for the team"). Never from a role's. ----

    /** The project's sources for a session: where each reads from and whether its key is set (never the key). */
    sessionSources(username: string, sessionId: string) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const list = repo.sources(who.projectId)
      if (!list.length) return 'No data sources yet. Add one with team_source_add.'
      return list.map((x) => `- #${x.id} ${x.name} (${x.kind}): ${where(x)}${needsKey(x) ? '; NO KEY YET' : x.secret ? '; key set' : ''}${x.description ? `\n  ${x.description}` : ''}`).join('\n')
    },

    /** Adds a source as the session's owner (the same as on the Team tab), with or without its key. */
    sessionAddSource(username: string, sessionId: string, input: SourceInput) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const p = db.prepare('select slug, name from projects where id = ?').get(who.projectId) as { slug: string; name: string }
      const owner = who.author.owner
      const id = this.addSource(owner, p.slug, input, { keyLater: true })
      const x = repo.source(id)!
      tell(`${p.name}: ${owner.name}'s Claude added a data source`, `${x.name} (${x.kind}): ${where(x)}`, `/projects/${p.slug}`, `team-source:${id}`, 'shared')
      return [`Added #${id} ${x.name}. Roles see it in team_sources now.`, needsKey(x) ? keyLater(x, owner.name) : ''].filter(Boolean).join(' ')
    },

    /** Changes a source from a person's session: its name, description, where it reads from, or its key. */
    sessionUpdateSource(username: string, sessionId: string, ref: string | number, input: { name?: string; description?: string; config?: SourceConfig; secret?: string | null }) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const x = sourceRef(who.projectId, ref)
      const name = input.name?.trim() || x.name
      if (name.toLowerCase() !== x.name.toLowerCase() && repo.sourceByName(who.projectId, name)) throw new AppError(409, 'taken', `There is already a source called ${name}.`)
      this.updateSource(x.id, {
        name, description: input.description ?? x.description,
        config: { ...json<SourceConfig>(x.config, {}), ...Object.fromEntries(Object.entries(input.config ?? {}).filter(([, v]) => v !== undefined)) },
        secret: input.secret,
      })
      const y = repo.source(x.id)!
      return [`Updated ${y.name}.`, needsKey(y) ? keyLater(y, who.author.owner.name) : ''].filter(Boolean).join(' ')
    },

    sessionRemoveSource(username: string, sessionId: string, ref: string | number) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const x = sourceRef(who.projectId, ref)
      this.removeSource(x.id)
      return `Removed ${x.name}. Roles no longer see it.`
    },

    /** A first look at a source, as a role would get it, to check it works. */
    async sessionTestSource(username: string, sessionId: string, ref: string | number) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      const x = sourceRef(who.projectId, ref)
      if (needsKey(x)) return keyLater(x, who.author.owner.name)
      return (await this.testSource(x.id)).preview
    },

    sessionMessage(username: string, sessionId: string, input: MessageInput) {
      const who = this.sessionAuthor(username, sessionId)
      if (!who) throw new AppError(403, 'not_team', 'This session is not in a project with Team on.')
      return message(who.projectId, who.author, input)
    },

    // ---- Full team management from a member's own Claude session (same authority as the Team tab in the web app) ----

    /** The member whose own session this is (by the session's owner), never a role's session. */
    sessionMember(username: string, sessionId: string | null) {
      if (!sessionId) throw new AppError(403, 'not_team', 'These tools work in your own Claude session.')
      if (repo.roleBySession(sessionId)) throw new AppError(403, 'role', 'A role manages nothing: raise team changes with the lead or in your report.')
      const s = repo.session(sessionId)
      const owner = s && userById(s.owner_id)
      if (!s || !owner || owner.username !== username) throw new AppError(403, 'not_team', 'This is not your own Claude session.')
      return { user: owner, session: s }
    },
    /** That member and the project to act on with full authority: the `project` slug, or the session's own. Team must be on. */
    sessionActor(username: string, sessionId: string | null, slug?: string) {
      const { user, session } = this.sessionMember(username, sessionId)
      const target = slug?.trim() || (session.project_id ? (db.prepare('select slug from projects where id = ?').get(session.project_id) as { slug: string } | undefined)?.slug : undefined)
      if (!target) throw new AppError(400, 'bad_args', 'Say which project with `project` (this session has none).')
      const { p } = on(target)
      return { user, slug: p.slug, projectId: p.id }
    },

    /** The team at a glance for a member's session: brief, priorities, each role with its settings, goals, pending count. */
    sessionOverview(username: string, sessionId: string, slug?: string) {
      const o = this.overview(this.sessionActor(username, sessionId, slug).slug)
      return {
        project: o.project, enabled: o.enabled, paused: o.paused, tz: o.tz, pending: o.pending,
        brief: o.brief.body, priorities: o.priorities,
        goals: o.goals.map((g) => ({ id: g.id, title: g.title, measure: g.measure, due: g.due, status: g.status, progress: g.progress, owner: g.owner })),
        roles: o.roles.map((r) => ({
          id: r.id, name: r.name, summary: r.summary, model: r.model, lead: r.lead, paused: r.paused, autonomy: r.autonomy,
          autoApprove: r.autoApprove, schedule: r.schedule, triggers: r.triggers, dailyLimit: r.dailyLimit, monthlyBudget: r.monthlyBudget,
        })),
      }
    },
    /** Proposals for a member's session: pending (default, the ones a person must answer) or decided, shaped short. */
    sessionApprovals(username: string, sessionId: string, slug: string | undefined, status: 'pending' | 'decided' = 'pending') {
      const s = this.sessionActor(username, sessionId, slug).slug
      return this.approvals(status === 'decided' ? 'decided' : 'pending', s)
        .map((x) => ({ id: x.id, role: x.role.name, kind: x.kind, title: x.title, why: x.why, status: x.status, awaiting: x.awaiting, createdAt: x.createdAt }))
    },
    /** A member answers a proposal (full authority). Approving a code proposal starts a session as them, as on the web. */
    sessionDecide(username: string, sessionId: string, id: number, approve: boolean, reply: string) {
      return this.decide(this.sessionMember(username, sessionId).user, id, approve, reply)
    },
    /** A member lists the project's threads (open, waiting, closed or all), shaped short. */
    sessionThreads(username: string, sessionId: string, slug: string | undefined, status: 'open' | 'waiting' | 'closed' | 'all' = 'all') {
      const r = this.threads(this.sessionActor(username, sessionId, slug).slug, { status })
      return {
        counts: r.counts,
        threads: r.threads.map((t) => ({ id: t.id, title: t.title, status: t.status, needsPeople: t.needsPeople, priority: t.priority, ask: t.ask, owner: t.owner?.name ?? null, messages: t.messages, lastAt: t.lastAt })),
      }
    },
    /** A member reads one thread, as the web does. */
    sessionThread(username: string, sessionId: string, id: number) {
      this.sessionMember(username, sessionId)
      return this.thread(id)
    },
    /** A member closes a thread as a person (full authority). */
    sessionResolveThread(username: string, sessionId: string, id: number, resolution: string, as: CloseAs = 'done', duplicateOf?: number) {
      this.resolveAsPerson(this.sessionMember(username, sessionId).user, id, resolution, as, duplicateOf)
      return as === 'done' ? `Thread #${id} resolved.` : `Thread #${id} closed (${as.replace('_', ' ')}).`
    },
    /** A member reopens a closed thread. */
    sessionReopenThread(username: string, sessionId: string, id: number) {
      this.reopen(this.sessionMember(username, sessionId).user, id)
      return `Thread #${id} reopened.`
    },
    /** A member links a task to a thread, or unlinks it (one job per object). */
    sessionLinkTask(username: string, sessionId: string, threadId: number, taskNumber: number, unlink = false) {
      const key = this.linkTaskAsPerson(this.sessionMember(username, sessionId).user, threadId, taskNumber, unlink)
      return unlink ? `Unlinked ${key} from thread #${threadId}.` : `Linked ${key} to thread #${threadId}.`
    },
    /** A member marks a thread a blocker or clears it. */
    sessionThreadPriority(username: string, sessionId: string, id: number, priority: 'normal' | 'blocker') {
      this.setThreadPriority(this.sessionMember(username, sessionId).user, id, priority)
      return priority === 'blocker' ? `Thread #${id} marked a blocker.` : `Thread #${id} blocker cleared.`
    },
    /** A member sets the team's "what matters now". */
    sessionSetPriorities(username: string, sessionId: string, slug: string | undefined, body: string) {
      const s = this.sessionActor(username, sessionId, slug).slug
      this.savePriorities(s, body)
      return `Saved what matters now for ${s}.`
    },
    /** A member sets the project brief. */
    sessionSetBrief(username: string, sessionId: string, slug: string | undefined, body: string) {
      const who = this.sessionActor(username, sessionId, slug)
      this.saveBrief(who.user, who.slug, body)
      return `Brief saved for ${who.slug}.`
    },
    /** A member adds a goal for the team (full authority), on the `project` slug or the session's own. */
    sessionGoalAdd(username: string, sessionId: string, slug: string | undefined, g: { title: string; measure: string; due: string | null }) {
      const who = this.sessionActor(username, sessionId, slug)
      this.addGoal(who.slug, g)
      return `Goal added to ${who.slug}: ${g.title.trim().slice(0, 200)}.`
    },
    /** A member edits a goal by id (its measure, title, due, status, progress or note): the goal's own project must have Team on. */
    sessionGoalEdit(username: string, sessionId: string, input: { id: number; title?: string; measure?: string; due?: string | null; status?: GoalRow['status']; progress?: number; note?: string }) {
      const goal = repo.goal(input.id)
      if (!goal) throw new AppError(404, 'not_found', `There is no goal #${input.id}.`)
      const slug = (db.prepare('select slug from projects where id = ?').get(goal.project_id) as { slug: string }).slug
      this.sessionActor(username, sessionId, slug) // rejects a role's session and a project without Team on
      this.editGoal(input.id, input)
      return `Updated goal #${input.id}.`
    },
    /** A member archives a role (resolved by name or #id, like team_role_update). */
    sessionArchiveRole(username: string, sessionId: string, slug: string | undefined, ref: string | number) {
      const who = this.sessionActor(username, sessionId, slug)
      const r = typeof ref === 'number' ? repo.role(ref) : roleNamed(who.projectId, String(ref))
      if (!r || r.archived || r.project_id !== who.projectId) throw new AppError(404, 'not_found', `There is no role ${ref} in this project. See team_roles.`)
      const name = r.name
      this.archiveRole(r.id)
      return `Archived ${name}. It no longer works or appears to the team.`
    },
    /** A member starts a role's shift now, without editing its schedule (resolved by name or #id). */
    async sessionRunShift(username: string, sessionId: string, slug: string | undefined, ref: string | number) {
      const who = this.sessionActor(username, sessionId, slug)
      const r = typeof ref === 'number' ? repo.role(ref) : roleNamed(who.projectId, String(ref))
      if (!r || r.archived || r.project_id !== who.projectId) throw new AppError(404, 'not_found', `There is no role ${ref} in this project. See team_roles.`)
      await runShift(r.id)
      return `Started a shift for ${r.name}. It works on its own and reports; follow it at /projects/${who.slug}/team/${r.id}.`
    },

    /** The report of the shift this session is; returns false outside a shift. */
    shiftReport(sessionId: string, report: string) {
      const shift = repo.shiftBySession(sessionId)
      if (!shift) return false
      repo.setReport(shift.id, report.trim().slice(0, 8000))
      return true
    },

    /** For tests and shutdown. */
    stop() {
      stopListening()
      clearInterval(ticker)
      for (const t of timers.values()) clearTimeout(t)
    },
    digest,
    tick,
  }
}

export type TeamService = ReturnType<typeof teamService>
