// Autopilot: per member, off until they turn it on. While on:
// - every message the member sends in a session of theirs carries their rules (claude.addPreamble), so Claude Code and
//   OpenCode sessions decide routine things for them, and log each decision here (the autopilot_log tool);
// - a supervisor sweeps their own stalled sessions and continues them, answers their questions, or puts them in
//   "Needs you", within safeguards checked in code (sweep.ts);
// - a morning ping, only when something needs them or they haven't seen a yellow decision.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { validTz } from '../../core/schedule.ts'
import type { User } from '../auth/repo.ts'
import { condense } from '../assistant/mcp.ts'
import type { ClaudeService } from '../claude/service.ts'
import type { SessionRow } from '../claude/repo.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { convertPrototypeRules, isDuplicate, parsePrototypeLog } from './migrate.ts'
import { DEFAULT_RULES, teamSystem, offBlock, reminderBlock, renderRules, rulesBlock, supervisorSystem } from './prompt.ts'
import { DEFAULTS, describePrompt, judge, limitedUntil, neverApprove, obviousRed, redQuestion, nightStart, parseDecision, parseTeamDecision, TEAM_WAIT_MIN, pingDue, USAGE_LIMIT_RE, type Candidate, type Decision, type Settings, type Verdict } from './sweep.ts'

type Row = {
  user_id: number; enabled: number; rules: string | null; tz: string; ping_at: string; quiet_min: number; night_cap: number; max_nudges: number
  seen_at: number; pinged_on: string | null; paused_until: number | null; updated_at: number; approvals: number; prompt_wait_min: number
}
type Memory = { session_id: string; goal: string | null; nudges: number; last_error: string | null; checked_activity: number | null; rules_sent: string | null; relayed_message: number | null }
type LogRow = {
  id: number; at: number; tier: Tier; source: string; project: string | null; session_id: string | null; session_title: string | null
  what: string; why: string | null; message: string | null
}
type InboxRow = {
  id: number; kind: string; title: string; detail: string | null; created_at: number; session_id: string | null; session_title: string | null; thread_id: number | null; url: string | null
}
/** Who an entry is from: autopilot itself (the supervisor), the member's sessions deciding by their rules, or settings. */
export const WHO = { autopilot: 'supervisor', sessions: 'session', settings: 'system' } as const
export type LogFilter = { who?: keyof typeof WHO; tier?: Tier; project?: string; q?: string; order?: 'new' | 'old'; limit?: number; offset?: number }
export type Tier = 'green' | 'yellow' | 'red' | 'action' | 'system'
type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>
type Pending = {
  requestId: string; toolName: string; ownerOnly?: boolean; askedBy?: unknown
  input?: { questions?: { question?: string; options?: { label?: string; description?: string }[]; multiSelect?: boolean }[] } & Record<string, unknown>
}

const SWEEP_MS = 10 * 60_000
const MAX_RULES = 20_000
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
const hash = (t: string) => {
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
/** The project a session works in, as the log names it: its project, else its folder's name. */
const projectOf = (s: Pick<SessionRow, 'project_slug' | 'cwd'>) => s.project_slug ?? (s.cwd.split('/').filter(Boolean).pop() || 'home')

/** What autopilot sees of Team, when Team is installed (its autopilotPort; autopilot never imports Team). */
export type TeamPort = {
  projects(): { id: number; slug: string; name: string }[]
  waiting(projectId: number): {
    proposals: { id: number; kind: string; title: string; why: string; role: string; project: string; createdAt: number; url: string }[]
    asks: { id: number; title: string; ask: string | null; role: string; project: string; updatedAt: number; lastMessage: number; url: string; recent: string[] }[]
  }
  approve(user: User, id: number, reply: string): Promise<unknown>
  answer(user: User, slug: string, threadId: number, body: string): unknown
}

export function autopilotService({ db, hub, claude, notify, team = () => undefined, now = () => Date.now() }: {
  db: Db; hub: Hub; claude: ClaudeService; notify: Notify; now?: () => number
  /** Team, read late (it's built after autopilot in app.ts, and may be removed). */
  team?: () => TeamPort | undefined
}) {
  const q = {
    get: db.prepare('select * from autopilot where user_id = ?'),
    ensure: db.prepare('insert into autopilot (user_id) values (?) on conflict do nothing'),
    enabled: db.prepare('select a.*, u.username, u.name, u.email, u.role from autopilot a join users u on u.id = a.user_id where a.enabled = 1 and u.disabled_at is null'),
    user: db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null'),
    log: db.prepare('insert into autopilot_log (user_id, at, tier, source, project, session_id, what, why, message) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id'),
    unseenYellow: db.prepare("select count(*) as n from autopilot_log where user_id = ? and tier = 'yellow' and at > ?"),
    sentSince: db.prepare("select count(*) as n from autopilot_log where user_id = ? and source = 'supervisor' and tier in ('action') and message is not null and at >= ?"),
    inbox: db.prepare(`select i.*, s.title as session_title from autopilot_inbox i left join claude_sessions s on s.id = i.session_id
      where i.user_id = ? and i.resolved_at is null order by i.id desc`),
    inboxOpen: db.prepare('select id from autopilot_inbox where session_id = ? and resolved_at is null'),
    inboxThread: db.prepare('select id from autopilot_inbox where user_id = ? and thread_id = ? and resolved_at is null'),
    inboxAdd: db.prepare('insert into autopilot_inbox (user_id, session_id, thread_id, kind, title, detail, created_at, url) values (?, ?, ?, ?, ?, ?, ?, ?) returning id'),
    inboxUrl: db.prepare('select id from autopilot_inbox where user_id = ? and url = ? and title = ? and resolved_at is null'),
    teamOn: db.prepare('select project_id from autopilot_team where user_id = ?'),
    teamDone: db.prepare('select 1 from autopilot_team_done where user_id = ? and item = ?'),
    markTeamDone: db.prepare('insert or ignore into autopilot_team_done (user_id, item, at) values (?, ?, ?)'),
    resolveSession: db.prepare('update autopilot_inbox set resolved_at = ? where session_id = ? and resolved_at is null'),
    resolve: db.prepare('update autopilot_inbox set resolved_at = ? where id = ? and user_id = ? and resolved_at is null'),
    memory: db.prepare('select * from autopilot_sessions where session_id = ?'),
    remember: db.prepare(`insert into autopilot_sessions (session_id, goal, nudges, last_error, checked_activity) values (?1, ?2, ?3, ?4, ?5)
      on conflict (session_id) do update set goal = ?2, nudges = ?3, last_error = ?4, checked_activity = ?5`),
    rulesSent: db.prepare(`insert into autopilot_sessions (session_id, rules_sent) values (?1, ?2)
      on conflict (session_id) do update set rules_sent = ?2`),
    relayed: db.prepare(`insert into autopilot_sessions (session_id, relayed_message) values (?1, ?2)
      on conflict (session_id) do update set relayed_message = ?2`),
    sent: db.prepare('insert or ignore into autopilot_sent (uuid, session_id, at) values (?, ?, ?)'),
    lastSender: db.prepare('select user_id from claude_message_senders where session_id = ? order by rowid desc limit 1'),
    goal: db.prepare(`select m.message_uuid from claude_message_senders m where m.session_id = ? and m.user_id = ?
      and not exists (select 1 from autopilot_sent a where a.uuid = m.message_uuid) order by m.rowid desc limit 1`),
    session: db.prepare(`select s.id, s.owner_id, s.cwd, s.title, s.archived, s.origin_kind, p.slug as project_slug, u.username as owner_username
      from claude_sessions s join users u on u.id = s.owner_id left join projects p on p.id = s.project_id where s.id = ?`),
    // Team threads one of the member's sessions wrote in, where a role answered after the session's last word.
    threadReplies: db.prepare(`select t.id as thread_id, t.title, m.id as message_id, m.body, m.kind, m.author_label, mine.session_id
      from (select thread_id, author_session_id as session_id, max(id) as last from team_messages where author_session_id = ? group by thread_id) mine
      join team_threads t on t.id = mine.thread_id and t.status = 'open' and t.needs_people = 0
      join team_messages m on m.thread_id = t.id and m.id = (select max(id) from team_messages where thread_id = t.id)
      where m.id > mine.last and m.author_role_id is not null and m.kind in ('question', 'request', 'reply', 'alert')`),
  }

  const row = (userId: number) => {
    q.ensure.run(userId)
    return q.get.get(userId) as Row
  }
  const settingsOf = (r: Row): Settings => ({ quietMin: r.quiet_min, nightCap: r.night_cap, maxNudges: r.max_nudges, tz: r.tz, pingAt: r.ping_at, approvals: !!r.approvals, promptWaitMin: r.prompt_wait_min })
  const changed = (userId: number) => hub.publish('autopilot', { type: 'changed' }, (u) => u.id === userId)
  hub.authorize('autopilot', () => true) // events go only to the member they're for

  function log(userId: number, e: { tier: Tier; source?: 'session' | 'supervisor' | 'system'; project?: string | null; sessionId?: string | null; what: string; why?: string | null; message?: string | null; at?: number }) {
    const at = e.at ?? Math.floor(now() / 1000)
    const id = (q.log.get(userId, at, e.tier, e.source ?? 'session', e.project ?? null, e.sessionId ?? null, clip(oneLine(e.what), 500),
      e.why ? clip(oneLine(e.why), 300) : null, e.message ?? null) as { id: number }).id
    changed(userId)
    return id
  }
  function toInbox(userId: number, i: { sessionId?: string | null; threadId?: number | null; kind: 'red' | 'stuck' | 'permission' | 'thread'; title: string; detail?: string | null; url?: string }) {
    if (i.sessionId && q.inboxOpen.get(i.sessionId)) return
    if (i.threadId && q.inboxThread.get(userId, i.threadId)) return
    if (i.url && q.inboxUrl.get(userId, i.url, clip(oneLine(i.title), 200))) return
    q.inboxAdd.run(userId, i.sessionId ?? null, i.threadId ?? null, i.kind, clip(oneLine(i.title), 200), i.detail ? clip(i.detail, 1000) : null, Math.floor(now() / 1000), i.url ?? null)
    changed(userId)
  }

  /** A session archived or deleted since: what it waited for in "Needs you" is gone with it. */
  const tidyInbox = (userId: number) => db.prepare(`update autopilot_inbox set resolved_at = ? where user_id = ? and resolved_at is null
    and session_id is not null and not exists (select 1 from claude_sessions s where s.id = autopilot_inbox.session_id and s.archived = 0)`)
    .run(Math.floor(now() / 1000), userId)

  function teamProjects(userId: number) {
    const t = team()
    if (!t) return null
    const on = new Set((q.teamOn.all(userId) as { project_id: number }[]).map((x) => x.project_id))
    return t.projects().map((p) => ({ ...p, on: on.has(p.id) }))
  }

  function state(user: User) {
    const r = row(user.id)
    tidyInbox(user.id)
    return {
      enabled: !!r.enabled,
      rules: r.rules ?? renderRules(null, user.name),
      customRules: r.rules != null,
      settings: settingsOf(r),
      pausedUntil: r.paused_until && r.paused_until * 1000 > now() ? r.paused_until : null,
      inbox: (q.inbox.all(user.id) as InboxRow[]).map((i) => ({
        id: i.id, kind: i.kind, title: i.title, detail: i.detail, createdAt: i.created_at,
        session: i.session_id ? { id: i.session_id, title: i.session_title ?? 'A session' } : null, threadId: i.thread_id, url: i.url,
      })),
      unseenYellow: (q.unseenYellow.get(user.id, r.seen_at) as { n: number }).n,
      sentTonight: (q.sentSince.get(user.id, nightStart(now(), r.tz, r.ping_at)) as { n: number }).n,
      // Projects with an AI team, and whether autopilot answers their role agents' asks for this member. null: no Team.
      team: teamProjects(user.id),
    }
  }

  /**
   * The log, newest first by when it happened (not by when it was written: moved-in entries are older than their ids).
   * `who`: autopilot's own actions, the sessions' decisions, or settings. Paged by offset, with the total for the pager.
   */
  function entries(user: User, f: LogFilter = {}) {
    const where = ['l.user_id = ?']
    const args: (string | number)[] = [user.id]
    if (f.who) {
      where.push('l.source = ?')
      args.push(WHO[f.who])
    }
    if (f.tier) {
      where.push('l.tier = ?')
      args.push(f.tier)
    }
    if (f.project) {
      where.push('l.project = ?')
      args.push(f.project)
    }
    if (f.q?.trim()) {
      // A plain substring search: % and _ typed by the member mean themselves.
      const like = `%${f.q.trim().replace(/[!%_]/g, (c) => `!${c}`)}%`
      where.push("(l.what like ? escape '!' or l.why like ? escape '!' or l.message like ? escape '!')")
      args.push(like, like, like)
    }
    const sql = where.join(' and ')
    const order = f.order === 'old' ? 'asc' : 'desc'
    const limit = Math.max(1, Math.min(100, f.limit ?? 20))
    const offset = Math.max(0, f.offset ?? 0)
    const rows = db.prepare(`select l.*, s.title as session_title from autopilot_log l left join claude_sessions s on s.id = l.session_id
      where ${sql} order by l.at ${order}, l.id ${order} limit ? offset ?`).all(...args, limit, offset) as LogRow[]
    const total = (db.prepare(`select count(*) as n from autopilot_log l where ${sql}`).get(...args) as { n: number }).n
    const projects = (db.prepare("select distinct project from autopilot_log where user_id = ? and project is not null order by project").all(user.id) as { project: string }[]).map((p) => p.project)
    return {
      total, projects,
      entries: rows.map((l) => ({
        id: l.id, at: l.at, tier: l.tier, source: l.source, project: l.project, what: l.what, why: l.why, message: l.message,
        session: l.session_id ? { id: l.session_id, title: l.session_title ?? null } : null,
      })),
    }
  }

  // ---- Rules in sessions: before each of the owner's own messages ----

  /** Who is sending right now on the supervisor's behalf: its own messages don't resolve "Needs you". */
  const supervising = new Set<string>()
  claude.addPreamble((s, o) => {
    if (o.role || s.origin_kind === 'proposal') return []
    if (!supervising.has(s.id)) {
      // The member wrote in it themself: whatever it waited for them on is theirs now.
      if (q.resolveSession.run(Math.floor(now() / 1000), s.id).changes) changed(s.owner_id)
    }
    const a = q.get.get(s.owner_id) as Row | undefined
    const mem = q.memory.get(s.id) as Memory | undefined
    if (!a?.enabled) {
      if (mem?.rules_sent && mem.rules_sent !== 'off') {
        q.rulesSent.run(s.id, 'off')
        return [offBlock(s.owner_name)]
      }
      return []
    }
    const rules = renderRules(a.rules, s.owner_name)
    const version = hash(rules)
    if (mem?.rules_sent === version) return [reminderBlock(s.owner_name)]
    q.rulesSent.run(s.id, version)
    return [rulesBlock(rules, s.owner_name)]
  })

  /** What the autopilot tools act on: the member's own session, outside team roles' and proposals', in their own turn. */
  function toolContext(username: string, sessionId: string | null) {
    const s = sessionId ? (q.session.get(sessionId) as { id: string; owner_id: number; cwd: string; title: string; origin_kind: string | null; project_slug: string | null; owner_username: string } | undefined) : undefined
    if (!s || s.owner_username !== username) throw new AppError(403, 'not_yours', 'Autopilot works only in your own DevDash sessions.')
    if (s.origin_kind === 'proposal' || claude.ownedActive(username).some((x) => x.id === s.id && x.role)) {
      throw new AppError(403, 'not_autopilot', "Autopilot doesn't apply in a team role's session: ask as usual.")
    }
    const last = q.lastSender.get(s.id) as { user_id: number } | undefined
    if (last && last.user_id !== s.owner_id) {
      throw new AppError(403, 'teammate_turn', "This turn is a teammate's request: autopilot doesn't apply. Don't decide for the owner; ask as usual.")
    }
    const a = row(s.owner_id)
    if (!a.enabled) throw new AppError(409, 'autopilot_off', 'Autopilot is OFF: don\'t decide for them, ask them as usual.')
    return { s, a }
  }

  // ---- The supervisor ----

  /** The member's sessions as the sweep judges them. */
  function candidates(user: User, r: Row) {
    return claude.ownedActive(user.username).map((s) => {
      const mem = q.memory.get(s.id) as Memory | undefined
      const last = q.lastSender.get(s.id) as { user_id: number } | undefined
      const goal = (q.goal.get(s.id, user.id) as { message_uuid: string } | undefined)?.message_uuid ?? null
      const c: Candidate = {
        status: s.status, mode: s.mode, started: !!s.started, archived: !!s.archived,
        excluded: s.role || s.origin_kind === 'assistant' || s.origin_kind === 'proposal',
        viewers: hub.viewers(`session:${s.id}`).length, lastActivity: s.last_activity_at,
        lastSender: last ? (last.user_id === user.id ? 'owner' : 'teammate') : null,
        goal, statusDetail: s.status_detail,
        memory: { goal: mem?.goal ?? null, nudges: mem?.nudges ?? 0, lastError: mem?.last_error ?? null, checkedActivity: mem?.checked_activity ?? null },
        inInbox: !!q.inboxOpen.get(s.id),
      }
      return { s, c, mem, verdict: judge(c, settingsOf(r), Math.floor(now() / 1000)) }
    })
  }

  /** The supervisor model's read of one session: its conversation's end, what it waits for, and the member's rules. */
  async function decide(user: User, r: Row, s: SessionRow, pending: Pending[], extra = '') {
    const page = await claude.history(user, s.id)
    const convo = condense(page.messages as Parameters<typeof condense>[0], 24)
      .map((m) => `${m.from === 'person' ? `${user.name.split(' ')[0]}` : 'Agent'}: ${m.text ?? ''}${m.tools ? `\n  [tools: ${m.tools.join('; ')}]` : ''}`).join('\n\n')
    const waiting = pending.map((p) => p.toolName === 'AskUserQuestion'
      ? (p.input?.questions ?? []).map((x) => `- Question: ${x.question}\n  Options: ${(x.options ?? []).map((o) => o.label).join(' | ') || '(free text)'}${x.multiSelect ? ' (several allowed)' : ''}`).join('\n')
      : `- ${p.toolName === 'ExitPlanMode' ? 'Approval of this plan' : `Permission for ${p.toolName}`}: ${clip(describePrompt(p), 300)}\n  Full request: ${clip(JSON.stringify(p.input ?? {}), 3000)}`).join('\n')
    const prompt = [
      `Session "${s.title}" in ${projectOf(s)}. Status: ${s.status}${s.status_detail ? ` (${clip(s.status_detail, 300)})` : ''}.`,
      waiting ? `Waiting for:\n${waiting}` : 'Waiting for: nothing, it stopped.',
      extra,
      `Conversation, oldest first:\n\n${clip(convo, 30_000)}`,
    ].filter(Boolean).join('\n\n')
    const text = await claude.complete(user.username, prompt, { system: supervisorSystem(user.name) + renderRules(r.rules, user.name), model: 'sonnet' })
    return parseDecision(text)
  }

  /** Sends as the member, marked as autopilot's: never their own goal, never resolves "Needs you". */
  async function sendAs(user: User, sessionId: string, text: string) {
    supervising.add(sessionId)
    try {
      const uuid = await claude.send(user, sessionId, `(Autopilot) ${text}`, [])
      q.sent.run(uuid, sessionId, Math.floor(now() / 1000))
      return uuid
    } finally {
      supervising.delete(sessionId)
    }
  }

  async function act(user: User, s: SessionRow, c: Candidate, d: Decision, pending: Pending[]) {
    const base = { source: 'supervisor' as const, project: projectOf(s), sessionId: s.id }
    const remember = (nudged: boolean) => q.remember.run(s.id, c.goal, (c.memory.goal === c.goal ? c.memory.nudges : 0) + (nudged ? 1 : 0),
      s.status === 'error' ? s.status_detail : null, nudged ? null : c.lastActivity)
    if (d.action === 'done') {
      remember(false)
      return false
    }
    if (d.action === 'needs_you') {
      remember(false)
      toInbox(user.id, { sessionId: s.id, kind: 'red', title: d.message || 'It needs your decision', detail: d.why })
      log(user.id, { ...base, tier: 'red', what: `Left for you: ${d.message || s.title}`, why: d.why })
      return false
    }
    const prompt = pending.find((p) => p.toolName !== 'AskUserQuestion')
    if (d.action === 'approve' || d.action === 'decline') {
      // Only a permission or plan the tiers may decide; anything else waits for the member.
      if (!prompt || neverApprove(prompt)) return act(user, s, c, { ...d, action: 'needs_you', message: d.message || 'An approval waits for you' }, pending)
      const what = describePrompt(prompt)
      if (d.action === 'approve') {
        await claude.answer(user, s.id, prompt.requestId, { behavior: 'allow', updatedInput: prompt.input ?? {} })
        remember(true)
        log(user.id, { ...base, tier: d.tier === 'yellow' ? 'yellow' : 'action', what: `Approved (${d.tier}): ${clip(what, 300)}`, why: d.why, message: what })
        return true
      }
      const note = `Autopilot declined this for ${user.name.split(' ')[0]}: it's red by their rules (${d.message || d.why}). It's parked in their "Needs you" list for them to decide. Don't retry it or work around it: carry on with other work that doesn't need it, and say in your report that this step waits for them.`
      await claude.answer(user, s.id, prompt.requestId, { behavior: 'deny', message: note })
      remember(true)
      toInbox(user.id, { sessionId: s.id, kind: 'red', title: `Declined, needs your decision: ${clip(what, 150)}`, detail: d.why || d.message })
      log(user.id, { ...base, tier: 'red', what: `Declined (red), parked for you: ${clip(what, 300)}`, why: d.why || d.message, message: note })
      return true
    }
    if (prompt) return act(user, s, c, { ...d, action: 'needs_you', message: d.message || 'An approval waits for you' }, pending)
    if (d.action === 'answer') {
      const q0 = pending.find((p) => p.toolName === 'AskUserQuestion')
      if (!q0) return act(user, s, c, { ...d, action: 'needs_you', message: 'It waits for you' }, pending)
      const answers = Object.fromEntries((q0.input?.questions ?? []).map((x) => [x.question ?? '', d.answers[x.question ?? ''] ?? '']).filter(([, v]) => v))
      if (!Object.keys(answers).length) return act(user, s, c, { ...d, action: 'needs_you', message: 'It asks something autopilot could not answer' }, pending)
      // Marked, so the session (and anyone reading it) knows the member didn't answer this themself.
      const marked = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, `${v} (answered by Autopilot for ${user.name.split(' ')[0]}, by their rules: ${clip(d.why, 120)})`]))
      await claude.answer(user, s.id, q0.requestId, { behavior: 'allow', updatedInput: { ...q0.input, answers: marked } })
      remember(true)
      const said = Object.entries(answers).map(([k, v]) => `${k} → ${v}`).join('; ')
      log(user.id, { ...base, tier: 'action', what: `Answered for you (${d.tier}): ${said}`, why: d.why, message: said })
      return true
    }
    await sendAs(user, s.id, d.message)
    remember(true)
    log(user.id, { ...base, tier: 'action', what: `Continued (${d.tier}): ${clip(d.message, 160)}`, why: d.why, message: d.message })
    return true
  }

  /** Before any model call: has the member's Claude plan room left? A hit limit pauses the supervisor until it resets. */
  async function hasRoom(user: User, r: Row, profile: string) {
    const nowS = Math.floor(now() / 1000)
    try {
      const u = await claude.usage(user, profile)
      const until = limitedUntil(u.limits as Record<string, unknown> | null, nowS)
      if (until == null) return true
      pause(user, until, 'Your Claude usage is above 80% (5-hour) or 90% (weekly): autopilot leaves the rest for you')
      return false
    } catch {
      return true // usage can't be read (an older Claude Code, OpenCode): the error check below still stops it
    }
  }
  function pause(user: User, until: number, why: string) {
    db.prepare('update autopilot set paused_until = ? where user_id = ?').run(until, user.id)
    log(user.id, { tier: 'system', source: 'system', what: `Supervisor paused until ${new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`, why })
  }

  /** Sessions autopilot is acting on right now: the sweep and a prompt's timer never act on one twice at once. */
  const busy = new Set<string>()
  type Done = { user: number; session: string; what: string }

  /**
   * One session, judged and acted on: the safeguards first (sweep.ts judge), then the caps, then a decision. Returns
   * 'stop' when nothing more should happen for this member now (the cap, the usage limit).
   */
  async function attend(user: User, r: Row, s: SessionRow & { role: boolean }, c: Candidate, verdict: Verdict, done: Done[], room: { checked: boolean }) {
    if (verdict.act === false || busy.has(s.id)) return
    const nowS = Math.floor(now() / 1000)
    if (verdict.act === 'needs_you') {
      toInbox(user.id, { sessionId: s.id, kind: 'stuck', title: `Stuck: ${s.title}`, detail: verdict.reason })
      log(user.id, { tier: 'red', source: 'supervisor', project: projectOf(s), sessionId: s.id, what: `Stopped nudging: ${s.title}`, why: verdict.reason })
      done.push({ user: user.id, session: s.id, what: 'stuck' })
      return
    }
    if ((q.sentSince.get(user.id, nightStart(now(), r.tz, r.ping_at)) as { n: number }).n >= r.night_cap) {
      log(user.id, { tier: 'system', source: 'system', what: `Nightly cap reached (${r.night_cap} messages): the rest waits for the morning`, why: 'nightly cap' })
      db.prepare('update autopilot set paused_until = ? where user_id = ?').run(nightStart(now(), r.tz, r.ping_at) + 86_400, user.id)
      return 'stop'
    }
    if (s.status === 'error' && s.status_detail && USAGE_LIMIT_RE.test(s.status_detail)) {
      pause(user, nowS + 3600, 'A session hit the Claude usage limit')
      return 'stop'
    }
    busy.add(s.id)
    try {
      const pending = s.status === 'waiting' ? ((await claude.get(user, s.id)).pending as Pending[]) : []
      const prompt = pending.find((p) => p.toolName !== 'AskUserQuestion')
      const never = prompt && (r.approvals ? neverApprove(prompt) : 'approvals are yours (Autopilot handles approvals is off)')
      if (prompt && never) {
        q.remember.run(s.id, c.goal, c.memory.goal === c.goal ? c.memory.nudges : 0, null, c.lastActivity)
        toInbox(user.id, { sessionId: s.id, kind: 'permission', title: `Waits for your approval: ${clip(describePrompt(prompt), 150)}`, detail: never })
        log(user.id, { tier: 'red', source: 'supervisor', project: projectOf(s), sessionId: s.id, what: `Left for you: ${clip(describePrompt(prompt), 300)}`, why: never })
        done.push({ user: user.id, session: s.id, what: 'permission' })
        return
      }
      // Red on its face (a delete, a force-push, publishing): declined without reading the conversation or a model call.
      const red = prompt && obviousRed(prompt)
      if (red) {
        await act(user, s, c, { action: 'decline', tier: 'red', message: red, answers: {}, why: red }, pending)
        done.push({ user: user.id, session: s.id, what: 'decline' })
        return
      }
      if (!room.checked) {
        room.checked = true
        if (!(await hasRoom(user, r, s.profile))) return 'stop'
      }
      // A question about something red: never answered, not even "No". Straight to Needs you, no model call.
      const asked = prompt ? null : pending.find((p) => p.toolName === 'AskUserQuestion')
      const redAsk = asked && redQuestion((asked.input?.questions ?? []).map((x) => x.question ?? '').join(' '))
      if (redAsk) {
        await act(user, s, c, { action: 'needs_you', tier: 'red', message: clip((asked!.input?.questions?.[0]?.question ?? 'A question waits for you'), 150), answers: {}, why: redAsk }, pending)
        done.push({ user: user.id, session: s.id, what: 'needs_you' })
        return
      }
      // One prompt at a time: the question or permission it's blocked on now.
      const d = await decide(user, r, s, prompt ? [prompt] : pending)
      if (!d) {
        q.remember.run(s.id, c.goal, c.memory.goal === c.goal ? c.memory.nudges : 0, c.memory.lastError, c.lastActivity)
        return
      }
      await act(user, s, c, d, pending)
      done.push({ user: user.id, session: s.id, what: d.action })
    } catch (err) {
      console.error(`autopilot: ${s.id.slice(0, 8)}:`, (err as Error).message)
      // Not again until something happens in it: a failing model call mustn't repeat every sweep.
      q.remember.run(s.id, c.goal, c.memory.goal === c.goal ? c.memory.nudges : 0, c.memory.lastError, c.lastActivity)
      if (USAGE_LIMIT_RE.test((err as Error).message)) {
        pause(user, nowS + 3600, 'The Claude usage limit is hit')
        return 'stop'
      }
    } finally {
      busy.delete(s.id)
    }
  }

  /** The member, if autopilot is on for them and not paused. */
  function active(userId: number) {
    const r = q.get.get(userId) as Row | undefined
    if (!r?.enabled || (r.paused_until && r.paused_until > Math.floor(now() / 1000))) return null
    const user = q.user.get(userId) as User | undefined
    return user ? { r, user } : null
  }

  let sweeping = false
  /** One pass over every member with autopilot on. Returns what it did, for tests and the logs. */
  async function sweep() {
    if (sweeping) return []
    sweeping = true
    const done: Done[] = []
    try {
      for (const { user_id } of q.enabled.all() as Row[]) {
        const a = active(user_id)
        if (!a) continue
        const room = { checked: false }
        for (const { s, c, verdict } of candidates(a.user, a.r)) {
          if ((await attend(a.user, a.r, s, c, verdict, done, room)) === 'stop') break
        }
        if (active(user_id)) await relayThreads(a.user, a.r, done)
        if (active(user_id)) await teamAsks(a.user, a.r, done)
      }
    } finally {
      sweeping = false
    }
    return done
  }

  /**
   * A session just asked something: look again once the member had `prompt_wait_min` to answer it themself, and act
   * then, under the same safeguards (only their own sessions, nobody viewing, their own turn, still waiting).
   */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  async function promptNow(sessionId: string, userId: number) {
    const a = active(userId)
    if (!a) return []
    const done: Done[] = []
    const one = candidates(a.user, a.r).find((x) => x.s.id === sessionId)
    if (one) await attend(a.user, a.r, one.s, one.c, one.verdict, done, { checked: false })
    return done
  }
  claude.onPrompt((s) => {
    const a = active(s.owner_id)
    if (!a) return
    clearTimeout(timers.get(s.id))
    const t = setTimeout(() => {
      timers.delete(s.id)
      void promptNow(s.id, s.owner_id).catch((err) => console.error('autopilot prompt:', err))
    }, a.r.prompt_wait_min * 60_000 + 5_000)
    t.unref?.()
    timers.set(s.id, t)
  })

  /**
   * The AI team's asks in the projects the member turned on: proposals waiting on /approvals, and threads where a role
   * asked people. Each waits TEAM_WAIT_MIN for a teammate first; then green and yellow are approved or answered as the
   * member, everything else lands in Needs you. Autopilot never declines a role's ask. Each is handled once.
   */
  async function teamAsks(user: User, r: Row, done: Done[]) {
    const t = team()
    if (!t) return
    const projects = new Set((q.teamOn.all(user.id) as { project_id: number }[]).map((x) => x.project_id))
    if (!projects.size) return
    const nowS = Math.floor(now() / 1000)
    const room = { checked: false }
    const fresh = (at: number) => nowS - at < TEAM_WAIT_MIN * 60
    for (const projectId of projects) {
      const w = t.waiting(projectId)
      const items = [
        ...w.proposals.map((x) => ({ of: 'proposal' as const, key: `proposal:${x.id}`, at: x.createdAt, x })),
        ...w.asks.filter((x) => x.ask).map((x) => ({ of: 'ask' as const, key: `ask:${x.id}:${x.lastMessage}`, at: x.updatedAt, x })),
      ]
      for (const it of items) {
        if (fresh(it.at) || q.teamDone.get(user.id, it.key)) continue
        if ((q.sentSince.get(user.id, nightStart(now(), r.tz, r.ping_at)) as { n: number }).n >= r.night_cap) return
        const x = it.x
        const what = it.of === 'proposal'
          ? `${x.role} (${x.project}) proposes: ${x.title}`
          : `${x.role} (${x.project}) asks: ${(x as { ask: string }).ask}`
        const leave = (why: string, message?: string) => {
          toInbox(user.id, { kind: 'thread', title: clip(what, 200), detail: [message, why].filter(Boolean).join(' · '), url: x.url })
          log(user.id, { tier: 'red', source: 'supervisor', project: x.project, what: `Left for you: ${clip(what, 300)}`, why })
          done.push({ user: user.id, session: it.key, what: 'needs_you' })
        }
        q.markTeamDone.run(user.id, it.key, nowS) // once, whatever happens next
        const text = it.of === 'proposal' ? `${x.title}\n${(x as { why: string }).why}` : `${x.title}\n${(x as { ask: string }).ask}`
        // "Other" proposals are a person's call by Team's own design; red words never reach a model.
        const red = it.of === 'proposal' && (x as { kind: string }).kind === 'other' ? "it's a decision Team leaves to a person" : redQuestion(text)
        if (red) {
          leave(red)
          continue
        }
        if (!room.checked) {
          room.checked = true
          if (!(await hasRoom(user, r, 'default'))) return
        }
        try {
          const prompt = it.of === 'proposal'
            ? `Proposal from the ${x.role} role in ${x.project} (${(x as { kind: string }).kind}): ${x.title}\n\nWhy: ${clip((x as { why: string }).why, 4000)}`
            : `Question from the ${x.role} role in ${x.project}, thread "${x.title}":\n${(x as { ask: string }).ask}\n\nThe thread so far:\n${(x as { recent: string[] }).recent.join('\n\n')}`
          const d = parseTeamDecision(await claude.complete(user.username, prompt, { system: teamSystem(user.name) + renderRules(r.rules, user.name), model: 'sonnet' }), it.of)
          if (!d || d.action === 'needs_you') {
            leave(d?.why || "autopilot couldn't tell what you'd want", d?.message)
            continue
          }
          const first = user.name.split(' ')[0]
          if (d.action === 'approve') {
            await t.approve(user, x.id, `(Autopilot for ${first}, by their rules: ${d.why})`)
            log(user.id, { tier: d.tier === 'yellow' ? 'yellow' : 'action', source: 'supervisor', project: x.project, what: `Approved for the team (${d.tier}): ${clip(what, 300)}`, why: d.why, message: x.title })
          } else {
            const body = `${d.message}\n\n(Autopilot for ${first}, by their rules: ${d.why})`
            await t.answer(user, x.project, x.id, body)
            log(user.id, { tier: d.tier === 'yellow' ? 'yellow' : 'action', source: 'supervisor', project: x.project, what: `Answered ${x.role} in "${clip(x.title, 80)}" (${d.tier}): ${clip(d.message, 200)}`, why: d.why, message: body })
          }
          done.push({ user: user.id, session: it.key, what: d.action })
        } catch (err) {
          console.error(`autopilot team ${it.key}:`, (err as Error).message)
          leave(`autopilot couldn't act on it: ${clip((err as Error).message, 150)}`)
        }
      }
    }
  }

  /**
   * Team roles answer in threads, but the session that asked doesn't hear it: pass a role's latest reply to the
   * member's session that wrote there, under the same safeguards. Threads waiting for people stay with Team.
   */
  async function relayThreads(user: User, r: Row, done: { user: number; session: string; what: string }[]) {
    for (const { s, c, mem } of candidates(user, r)) {
      if (c.excluded || c.archived || c.mode !== 'chat' || c.status === 'working') continue
      let replies: { thread_id: number; title: string; message_id: number; body: string; kind: string; author_label: string }[]
      try {
        replies = q.threadReplies.all(s.id) as typeof replies
      } catch {
        return // Team isn't installed
      }
      const fresh = replies.filter((x) => x.message_id > (mem?.relayed_message ?? 0))
      if (!fresh.length) continue
      // Someone active or a teammate's turn: not now (the next sweep tries again).
      const v = judge({ ...c, status: 'idle', inInbox: false, memory: { ...c.memory, checkedActivity: null } }, settingsOf(r), Math.floor(now() / 1000))
      if (v.act !== true) continue
      if ((q.sentSince.get(user.id, nightStart(now(), r.tz, r.ping_at)) as { n: number }).n >= r.night_cap) return
      const text = fresh.map((x) => `${x.author_label} wrote in team thread #${x.thread_id} "${x.title}" (${x.kind}):\n${clip(x.body, 2000)}`).join('\n\n')
      const message = `${text}\n\nHandle it by the autopilot rules: answering an AI role follows the normal tiers; anything red waits for me.`
      try {
        await sendAs(user, s.id, message)
        q.relayed.run(s.id, Math.max(...fresh.map((x) => x.message_id)))
        log(user.id, { tier: 'action', source: 'supervisor', project: projectOf(s), sessionId: s.id, what: `Passed ${fresh[0]!.author_label}'s reply in thread #${fresh[0]!.thread_id} to the session`, why: 'a role answered the session in its thread', message })
        done.push({ user: user.id, session: s.id, what: 'relay' })
      } catch (err) {
        console.error(`autopilot relay: ${s.id.slice(0, 8)}:`, (err as Error).message)
      }
    }
  }

  /** The morning ping: once a day at their time, and only when something needs them or a yellow decision is unseen. */
  async function morning() {
    for (const r of q.enabled.all() as Row[]) {
      const date = pingDue(now(), r.tz, r.ping_at, r.pinged_on)
      if (!date) continue
      db.prepare('update autopilot set pinged_on = ? where user_id = ?').run(date, r.user_id)
      tidyInbox(r.user_id)
      const needs = (q.inbox.all(r.user_id) as unknown[]).length
      const yellow = (q.unseenYellow.get(r.user_id, r.seen_at) as { n: number }).n
      if (!needs && !yellow) continue
      const parts = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', yellow ? `${yellow} decision${yellow === 1 ? '' : 's'} to look at` : ''].filter(Boolean)
      await notify(r.user_id, 'needs_you', { title: `Autopilot: ${parts.join(', ')}`, body: 'From your sessions overnight.', url: '/autopilot', tag: `autopilot:${r.user_id}:morning` })
        .catch((err) => console.error('autopilot ping:', err))
    }
  }

  return {
    state,
    entries,
    log,
    sweep,
    promptNow,
    teamAsks: async (user: User) => {
      const r = row(user.id)
      const done: Done[] = []
      await teamAsks(user, r, done)
      return done
    },
    morning,
    /** Starts the timers (not in tests). */
    start() {
      setInterval(() => void sweep().catch((err) => console.error('autopilot sweep:', err)), SWEEP_MS).unref()
      setInterval(() => void morning().catch((err) => console.error('autopilot morning:', err)), 60_000).unref()
    },

    setEnabled(user: User, on: boolean) {
      const r = row(user.id)
      if (!!r.enabled === on) return state(user)
      db.prepare('update autopilot set enabled = ?, paused_until = null, updated_at = unixepoch() where user_id = ?').run(on ? 1 : 0, user.id)
      log(user.id, { tier: 'system', source: 'system', what: `Autopilot turned ${on ? 'on' : 'off'}` })
      return state(user)
    },

    setRules(user: User, rules: string | null) {
      const text = rules?.trim() ? rules.trim().slice(0, MAX_RULES) : null
      row(user.id)
      // The default, written out: stored as "default" so it follows later improvements to it.
      const stored = text && text !== renderRules(null, user.name) ? text : null
      db.prepare('update autopilot set rules = ?, updated_at = unixepoch() where user_id = ?').run(stored, user.id)
      log(user.id, { tier: 'system', source: 'system', what: stored ? 'Rules edited' : 'Rules reset to the default' })
      return state(user)
    },

    setSettings(user: User, p: Partial<Settings>) {
      const r = row(user.id)
      const int = (v: number | undefined, old: number, min: number, max: number) => (v === undefined ? old : Math.max(min, Math.min(max, Math.round(v))))
      if (p.tz !== undefined && !validTz(p.tz)) throw new AppError(400, 'bad_tz', 'Unknown time zone.')
      if (p.pingAt !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.pingAt)) throw new AppError(400, 'bad_time', 'The ping time is HH:MM, 24-hour.')
      db.prepare('update autopilot set tz = ?, ping_at = ?, quiet_min = ?, night_cap = ?, max_nudges = ?, approvals = ?, prompt_wait_min = ?, updated_at = unixepoch() where user_id = ?').run(
        p.tz ?? r.tz, p.pingAt ?? r.ping_at, int(p.quietMin, r.quiet_min, 5, 24 * 60), int(p.nightCap, r.night_cap, 0, 200), int(p.maxNudges, r.max_nudges, 1, 10),
        p.approvals === undefined ? r.approvals : p.approvals ? 1 : 0, int(p.promptWaitMin, r.prompt_wait_min, 1, 5), user.id)
      if (p.approvals !== undefined && p.approvals !== !!r.approvals) {
        log(user.id, { tier: 'system', source: 'system', what: `Autopilot handles approvals: ${p.approvals ? 'on' : 'off'}` })
      }
      changed(user.id)
      return state(user)
    },

    /** Whether autopilot answers this project's AI team asks for the member. */
    setTeam(user: User, projectId: number, on: boolean) {
      const t = team()
      const p = t?.projects().find((x) => x.id === projectId)
      if (!p) throw new AppError(404, 'not_found', 'No AI team in that project.')
      row(user.id)
      if (on) db.prepare('insert or ignore into autopilot_team (user_id, project_id) values (?, ?)').run(user.id, projectId)
      else db.prepare('delete from autopilot_team where user_id = ? and project_id = ?').run(user.id, projectId)
      log(user.id, { tier: 'system', source: 'system', project: p.slug, what: `Team asks in ${p.name}: autopilot ${on ? 'answers them' : 'leaves them to you'}` })
      return state(user)
    },

    /** The member opened the page: yellow decisions until now count as seen. */
    seen(user: User) {
      row(user.id)
      db.prepare('update autopilot set seen_at = ? where user_id = ?').run(Math.floor(now() / 1000), user.id)
      return state(user)
    },

    dismiss(user: User, id: number) {
      if (!q.resolve.run(Math.floor(now() / 1000), id, user.id).changes) throw new AppError(404, 'not_found', 'Nothing to dismiss.')
      changed(user.id)
      return state(user)
    },

    // ---- What sessions call (the autopilot_* tools) ----
    toolLog(username: string, sessionId: string | null, args: Record<string, unknown>) {
      const { s } = toolContext(username, sessionId)
      const tier = args.tier
      if (tier !== 'green' && tier !== 'yellow') throw new AppError(400, 'bad_args', 'tier is green or yellow: red decisions are never made on autopilot, ask them.')
      const what = typeof args.what === 'string' ? args.what.trim() : ''
      if (!what) throw new AppError(400, 'bad_args', 'Say what you decided.')
      log(s.owner_id, { tier, source: 'session', project: projectOf(s), sessionId: s.id, what, why: typeof args.why === 'string' ? args.why : null })
      return 'Logged.'
    },
    toolRules(username: string, sessionId: string | null) {
      const { s, a } = toolContext(username, sessionId)
      const name = (q.user.get(s.owner_id) as User).name
      return `# Autopilot is ON for ${name.split(' ')[0]}\n\n${renderRules(a.rules, name)}`
    },
    /** For the tool list: autopilot's tools are listed in a member's own sessions, not in team roles'. */
    toolsHere(username: string, sessionId: string | null) {
      const s = sessionId ? (q.session.get(sessionId) as { owner_username: string; origin_kind: string | null } | undefined) : undefined
      return !!s && s.owner_username === username && s.origin_kind !== 'proposal' && !claude.ownedActive(username).some((x) => x.id === sessionId && x.role)
    },

    /**
     * Moves the member's prototype (~/.claude/autopilot, sent by scripts/autopilot-import.mjs through their agent) in,
     * once. DevDash stays the source of truth: decisions already logged here (a session that logged to both) aren't
     * doubled, rules edited here stay, and a toggle already used here isn't changed. `approvals`: turn on "Autopilot
     * handles approvals" in the same step (the member asked for it when moving in).
     */
    importPrototype(username: string, p: { rules?: unknown; log?: unknown; state?: unknown; approvals?: unknown }) {
      const user = db.prepare('select id, email, username, name, role from users where username = ? and disabled_at is null').get(username) as User | undefined
      if (!user) throw new AppError(404, 'not_found', 'No such member.')
      if (db.prepare("select 1 from autopilot_log where user_id = ? and what like 'Moved in from the prototype%'").get(user.id)) {
        throw new AppError(409, 'done', 'Your prototype was already moved in.')
      }
      const r = row(user.id)
      const parsed = typeof p.log === 'string' ? parsePrototypeLog(p.log, r.tz) : []
      const here = db.prepare("select at, tier, session_id as sessionId, what from autopilot_log where user_id = ? and source = 'session'").all(user.id) as { at: number; tier: string; sessionId: string | null; what: string }[]
      const entries = parsed.filter((e) => e.tier === 'system' || !here.some((h) => isDuplicate(e, h)))
      const known = db.prepare('select 1 from claude_sessions where id = ?')
      for (const e of entries) {
        log(user.id, { ...e, sessionId: e.sessionId && known.get(e.sessionId) ? e.sessionId : null, source: e.tier === 'system' ? 'system' : 'session' })
      }
      const converted = typeof p.rules === 'string' && p.rules.trim() ? convertPrototypeRules(p.rules, user.name) : null
      const rules = r.rules ?? converted // rules edited in DevDash win
      const toggled = !!db.prepare("select 1 from autopilot_log where user_id = ? and source = 'system' and what like 'Autopilot turned%' and what not like '%(prototype)'").get(user.id)
      const on = toggled ? !!r.enabled : typeof p.state === 'string' && p.state.trim() === 'on'
      const approvals = p.approvals === true || !!r.approvals
      db.prepare('update autopilot set rules = ?, enabled = ?, approvals = ?, updated_at = unixepoch() where user_id = ?')
        .run(rules ? rules.slice(0, MAX_RULES) : null, on ? 1 : 0, approvals ? 1 : 0, user.id)
      const skipped = parsed.length - entries.length
      log(user.id, {
        tier: 'system', source: 'system',
        what: `Moved in from the prototype: ${entries.length} log entries${skipped ? ` (${skipped} already here)` : ''}, ${r.rules ? 'your DevDash rules kept' : converted ? 'your rules' : 'the default rules'}, autopilot ${on ? 'on' : 'off'}${approvals ? ', handles approvals' : ''}`,
      })
      return { entries: entries.length, skipped, customRules: !!rules, enabled: on, approvals }
    },
    defaults: { ...DEFAULTS, rules: DEFAULT_RULES },
  }
}
export type AutopilotService = ReturnType<typeof autopilotService>
