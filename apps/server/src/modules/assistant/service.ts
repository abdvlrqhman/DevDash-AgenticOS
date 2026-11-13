// Each member's personal agent: one conversation at a time with Claude Code or OpenCode, running as the member in their
// home folder, with DevDash tools across everything they can see (mcp.ts). Underneath it is an ordinary session
// (unlisted, origin 'assistant'), so questions, permissions, models, history and notifications work as in any other.
// Schedules send it a prompt at set times.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { dueSlots, nextRun, slotKey, validSlots, validTz, type Slot } from '../../core/schedule.ts'
import type { User } from '../auth/repo.ts'
import { HARNESSES, type ClaudeService, type Harness } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { instructions, READ_ONLY } from './prompt.ts'

type Row = {
  user_id: number; harness: Harness; profile: string; model: string | null; effort: string | null; permission_mode: string
  fast: number; reach_tailnet: number; drive: number; tz: string; session_id: string | null
}
/** How the agent works and what it reaches; each change applies to the current conversation too. */
export type Settings = { model?: string | null; effort?: string | null; permissionMode?: string; fastMode?: boolean; reachTailnet?: boolean; drive?: boolean }
type ScheduleRow = {
  id: number; user_id: number; title: string; prompt: string; slots: string; run_at: number | null; tz: string; ran: string
  enabled: number; last_run_at: number | null; created_at: number
  /** The schedule's own conversation, where every run of it goes. */
  session_id: string | null
}
type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/
const MAX_SCHEDULES = 50
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_WORDS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6], 'every day': [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6],
}

/** "Weekdays at 09:00", "Mon, Thu at 18:30", or the date and time of a one-off, in its time zone. Pure, tested. */
export function describeWhen(s: { slots: Slot[]; runAt: number | null; tz: string }) {
  if (s.runAt != null) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: s.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(s.runAt * 1000))
  }
  return s.slots.map((x) => {
    const d = x.days.join('')
    const days = d === '0123456' ? 'Every day' : d === '12345' ? 'Weekdays' : d === '06' ? 'Weekends' : x.days.map((n) => DAY[n]).join(', ')
    return `${days} at ${x.at}`
  }).join('; ')
}

/**
 * A schedule as the agent (or a person) describes it: `days` + `at` repeat weekly, `run_at` (an ISO time or a unix time)
 * runs once. Days are numbers (0 = Sunday), names ("mon"), or "daily", "weekdays", "weekends". Pure, tested.
 */
export function parseWhen(a: Record<string, unknown>, now: number): { slots: Slot[]; runAt: number | null } {
  if (a.run_at !== undefined && a.run_at !== null) {
    const ms = typeof a.run_at === 'number' ? a.run_at * 1000 : typeof a.run_at === 'string' ? Date.parse(a.run_at) : NaN
    if (!Number.isFinite(ms)) throw new AppError(400, 'bad_args', 'run_at is a time like 2026-11-06T09:00:00+02:00.')
    if (ms < now - 60_000) throw new AppError(400, 'bad_args', 'run_at is in the past.')
    if (ms > now + 366 * 86_400_000) throw new AppError(400, 'bad_args', 'run_at is more than a year away.')
    return { slots: [], runAt: Math.floor(ms / 1000) }
  }
  const raw: unknown[] = Array.isArray(a.days) ? a.days : typeof a.days === 'string' ? [a.days] : DAY_WORDS.daily!
  const days = raw.flatMap((d): number[] => {
    if (typeof d === 'number') return [d]
    const w = String(d).trim().toLowerCase()
    return DAY_WORDS[w] ?? [w.length >= 2 ? DAY.findIndex((n) => n.toLowerCase().startsWith(w.slice(0, 3))) : -1]
  })
  const slots = validSlots([{ days, at: typeof a.at === 'string' ? a.at : '' }])
  if (!slots.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new AppError(400, 'bad_args', 'Give "at" (HH:MM, 24-hour) and "days" (e.g. ["mon","wed"], "weekdays", "daily"), or "run_at" for a one-off.')
  }
  return { slots, runAt: null }
}

export function assistantService({ db, hub, claude, notify, tailnetConnected, driveConnected }: {
  db: Db; hub: Hub; claude: ClaudeService; notify: Notify
  /** Whether the member connected their tailnet (Network page) and their Google Drive (Storage page). */
  tailnetConnected?: (userId: number) => boolean
  driveConnected?: (userId: number) => boolean
}) {
  const q = {
    get: db.prepare('select * from assistants where user_id = ?'),
    put: db.prepare(`insert into assistants (user_id, harness, profile, tz) values (?1, ?2, ?3, ?4)
      on conflict (user_id) do update set harness = ?2, profile = ?3, tz = ?4`),
    setSession: db.prepare('update assistants set session_id = ? where user_id = ?'),
    settings: db.prepare('update assistants set model = ?, effort = ?, permission_mode = ?, fast = ?, reach_tailnet = ?, drive = ? where user_id = ?'),
    session: db.prepare('select id, archived, started, harness, profile from claude_sessions where id = ?'),
    conversations: db.prepare(`select id, title, last_activity_at as lastActivityAt, harness from claude_sessions
      where owner_id = ? and origin_kind = 'assistant' and started = 1 order by last_activity_at desc limit 30`),
    mine: db.prepare("select id from claude_sessions where id = ? and owner_id = ? and origin_kind = 'assistant'"),
    ofSession: db.prepare(`select u.id, u.email, u.username, u.name, u.role from claude_sessions s join users u on u.id = s.owner_id
      where s.id = ? and u.username = ? and s.origin_kind = 'assistant' and u.disabled_at is null`),
    user: db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null'),
    schedules: db.prepare('select * from assistant_schedules where user_id = ? order by created_at'),
    schedule: db.prepare('select * from assistant_schedules where id = ? and user_id = ?'),
    count: db.prepare('select count(*) as n from assistant_schedules where user_id = ?'),
    insert: db.prepare('insert into assistant_schedules (user_id, title, prompt, slots, run_at, tz) values (?, ?, ?, ?, ?, ?) returning id'),
    update: db.prepare('update assistant_schedules set title = ?, prompt = ?, slots = ?, run_at = ?, tz = ?, enabled = ? where id = ?'),
    remove: db.prepare('delete from assistant_schedules where id = ? and user_id = ?'),
    enabled: db.prepare('select * from assistant_schedules where enabled = 1'),
    ran: db.prepare('update assistant_schedules set ran = ?, last_run_at = unixepoch(), enabled = ? where id = ?'),
    setScheduleSession: db.prepare('update assistant_schedules set session_id = ? where id = ?'),
    // The schedules' own conversations that are still open (not archived): settings changes reach them too.
    scheduleSessions: db.prepare(`select s.id from assistant_schedules a join claude_sessions s on s.id = a.session_id
      where a.user_id = ? and s.archived = 0`),
  }
  hub.authorize('assistant', () => true) // events are published only to the member they're for

  const row = (userId: number) => q.get.get(userId) as Row | undefined
  const changed = (userId: number) => hub.publish('assistant', { type: 'changed' }, (u) => u.id === userId)
  const scheduleDto = (s: ScheduleRow, now = Date.now()) => {
    const slots = JSON.parse(s.slots) as Slot[]
    const when = { slots, runAt: s.run_at, tz: s.tz }
    return {
      id: s.id, title: s.title, prompt: s.prompt, enabled: !!s.enabled, tz: s.tz, days: slots[0]?.days ?? [], at: slots[0]?.at ?? null,
      runAt: s.run_at, when: describeWhen(when), lastRunAt: s.last_run_at,
      next: !s.enabled ? null : s.run_at ?? nextRun(slots, s.tz, now),
      // Its own conversation, once it has run there (and it wasn't archived since).
      conversation: s.session_id && (q.session.get(s.session_id) as { archived: number; started: number } | undefined)?.started ? s.session_id : null,
    }
  }
  const schedules = (userId: number) => (q.schedules.all(userId) as ScheduleRow[]).map((s) => scheduleDto(s))
  const tzOf = (userId: number) => row(userId)?.tz ?? 'UTC'
  function state(user: User) {
    const a = row(user.id)
    const s = a?.session_id ? (q.session.get(a.session_id) as { archived: number } | undefined) : undefined
    return {
      agent: a ? {
        harness: a.harness, profile: a.profile, tz: a.tz, model: a.model, effort: a.effort, permissionMode: a.permission_mode,
        fastMode: !!a.fast, reachTailnet: !!a.reach_tailnet, drive: !!a.drive,
      } : null,
      // What there is to reach: switching one on needs it connected first.
      connected: { tailnet: !!tailnetConnected?.(user.id), drive: !!driveConnected?.(user.id) },
      sessionId: s && !s.archived ? a!.session_id : null, // archived from its own page: the panel offers a new one
      schedules: schedules(user.id),
    }
  }

  /** A new conversation on the member's chosen agent, set up as they set it; the session starts on the first message. */
  async function open(user: User, a: Row, title?: string) {
    const s = await claude.create(user, {
      prompt: '', images: [], cwd: '~', profile: a.profile, model: a.model, effort: a.effort, permissionMode: a.permission_mode, mode: 'chat', harness: a.harness,
    }, {
      instructions: instructions({ name: user.name, username: user.username, tz: a.tz }), toolPolicy: { allow: READ_ONLY }, listed: false, origin: { kind: 'assistant' },
      ...(title ? { title } : {}),
    })
    // A tailnet disconnected since doesn't stop the conversation from starting; it just doesn't reach it.
    if (a.fast || !a.drive) await claude.update(user, s.id, { fastMode: !!a.fast, drive: !!a.drive })
    if (a.reach_tailnet) await claude.update(user, s.id, { reachTailnet: true }).catch(() => {})
    return s.id
  }
  /** A fresh conversation to talk in: the panel switches to it. */
  async function start(user: User, a: Row) {
    const id = await open(user, a)
    q.setSession.run(id, user.id)
    changed(user.id)
    return id
  }
  const scheduleTitle = (title: string) => `Scheduled: ${title}`
  /**
   * Where a schedule runs: its own conversation, never the one the member is talking in, so a run doesn't land in the
   * middle of their chat. Each run follows the earlier ones there. A new one when it was archived or deleted, or the
   * member picked another agent or account since.
   */
  async function conversationFor(user: User, s: ScheduleRow) {
    const a = row(user.id)
    if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
    const c = s.session_id ? (q.session.get(s.session_id) as { id: string; archived: number; harness: string; profile: string } | undefined) : undefined
    if (c && !c.archived && c.harness === a.harness && c.profile === a.profile) return c.id
    const id = await open(user, a, scheduleTitle(s.title))
    q.setScheduleSession.run(id, s.id)
    return id
  }
  const scheduleSessions = (userId: number) => (q.scheduleSessions.all(userId) as { id: string }[]).map((r) => r.id)
  /** The conversation to talk in: the current one unless it was archived or deleted meanwhile. */
  async function current(user: User) {
    const a = row(user.id)
    if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
    const s = a.session_id ? (q.session.get(a.session_id) as { id: string; archived: number } | undefined) : undefined
    return s && !s.archived ? s.id : start(user, a)
  }
  const ownSession = (user: User, id: string) => {
    if (!q.mine.get(id, user.id)) throw new AppError(404, 'not_found', 'Not one of your agent conversations.')
  }

  async function run(s: ScheduleRow, date: string | null) {
    const once = s.run_at != null
    const ran = date ? { ...(JSON.parse(s.ran) as Record<string, string>), ...Object.fromEntries((JSON.parse(s.slots) as Slot[]).map((x) => [slotKey(x), date])) } : JSON.parse(s.ran)
    q.ran.run(JSON.stringify(ran), once ? 0 : 1, s.id) // marked first: a slow or failed send never runs it twice
    const user = q.user.get(s.user_id) as User | undefined
    if (!user) return
    try {
      await claude.send(user, await conversationFor(user, s), `⏰ Scheduled: ${s.title}\n\n${s.prompt}`, [])
    } catch (err) {
      void notify(user.id, 'errors', { title: `Your schedule "${s.title}" couldn't run`, body: (err as Error).message, url: '/', tag: `schedule:${s.id}` })
        .catch(() => {})
    }
    changed(user.id)
  }
  let ticking = false
  async function tick(now = Date.now()) {
    if (ticking) return
    ticking = true
    try {
      for (const s of q.enabled.all() as ScheduleRow[]) {
        if (s.run_at != null) {
          if (s.run_at * 1000 <= now) await run(s, null)
          continue
        }
        const due = dueSlots(JSON.parse(s.slots) as Slot[], JSON.parse(s.ran) as Record<string, string>, s.tz, now)
        if (due.length) await run(s, due[0]!.date)
      }
    } finally {
      ticking = false
    }
  }
  setInterval(() => void tick().catch((err) => console.error('assistant schedules:', err)), 30_000).unref()

  return {
    tick,
    state,

    /** Picks (or changes) the member's agent. Another agent or account starts a new conversation; the old one stays. */
    async setup(user: User, input: { harness: string; profile: string; tz?: string }) {
      if (!(HARNESSES as readonly string[]).includes(input.harness)) throw new AppError(400, 'bad_harness', 'Unknown agent.')
      if (!PROFILE_RE.test(input.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      const old = row(user.id)
      const tz = input.tz && validTz(input.tz) ? input.tz : old?.tz ?? 'UTC'
      q.put.run(user.id, input.harness, input.profile, tz)
      const a = row(user.id)!
      if (!old?.session_id || old.harness !== a.harness || old.profile !== a.profile) {
        if (old?.session_id && q.session.get(old.session_id)) await claude.update(user, old.session_id, { archived: true }).catch(() => {})
        await start(user, a)
      } else {
        for (const id of [old.session_id, ...scheduleSessions(user.id)]) claude.configure(id, { instructions: instructions({ name: user.name, username: user.username, tz }) })
      }
      return state(user)
    },

    /** Model, effort, permission level and what it reaches: kept for new conversations, and applied to the current one. */
    async settings(user: User, p: Settings) {
      const a = row(user.id)
      if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      if (p.reachTailnet && !tailnetConnected?.(user.id)) throw new AppError(409, 'no_tailnet', 'Connect your tailnet on the Network page first.')
      if (p.drive && !driveConnected?.(user.id)) throw new AppError(409, 'no_drive', 'Connect your Google Drive on the Storage page first.')
      const id = state(user).sessionId
      // The session checks each value (a known effort, a permission mode); the settings keep what it accepted.
      if (id) await claude.update(user, id, p)
      // The schedules' conversations work the same way; one that refuses a value doesn't stop the change.
      for (const sid of scheduleSessions(user.id)) if (sid !== id) await claude.update(user, sid, p).catch(() => {})
      const pick = <T,>(v: T | undefined, old: T) => (v === undefined ? old : v)
      const bit = (v: boolean | undefined, old: number) => (v === undefined ? old : v ? 1 : 0)
      q.settings.run(pick(p.model, a.model), pick(p.effort, a.effort), pick(p.permissionMode, a.permission_mode),
        bit(p.fastMode, a.fast), bit(p.reachTailnet, a.reach_tailnet), bit(p.drive, a.drive), user.id)
      changed(user.id)
      return state(user)
    },

    /** Archives the current conversation (it stays under past conversations) and starts an empty one. */
    async fresh(user: User) {
      const a = row(user.id)
      if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      const s = a.session_id ? (q.session.get(a.session_id) as { id: string; archived: number; started: number } | undefined) : undefined
      if (s && !s.archived && !s.started) return state(user) // already a fresh one
      if (s && !s.archived) await claude.update(user, s.id, { archived: true }).catch(() => {})
      await start(user, a)
      return state(user)
    },

    conversations: (user: User) => q.conversations.all(user.id) as { id: string; title: string; lastActivityAt: number; harness: Harness }[],

    /** Goes back to an earlier conversation. */
    async resume(user: User, id: string) {
      ownSession(user, id)
      if (!row(user.id)) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      await claude.update(user, id, { archived: false })
      q.setSession.run(id, user.id)
      changed(user.id)
      return state(user)
    },

    current,
    /** The member whose personal agent this session is, when it is one. */
    ofSession: (username: string, sessionId: string | null) =>
      sessionId ? ((q.ofSession.get(sessionId, username) as User | undefined) ?? null) : null,
    tz: tzOf,
    /** Shows a page in the member's open DevDash (every tab of theirs follows). */
    open: (userId: number, path: string) => hub.publish('assistant', { type: 'open', path }, (u) => u.id === userId),

    schedules: (user: User) => schedules(user.id),
    createSchedule(user: User, a: Record<string, unknown>) {
      if ((q.count.get(user.id) as { n: number }).n >= MAX_SCHEDULES) throw new AppError(409, 'too_many', `Up to ${MAX_SCHEDULES} schedules.`)
      const title = typeof a.title === 'string' ? a.title.trim().slice(0, 80) : ''
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim().slice(0, 8000) : ''
      if (!title || !prompt) throw new AppError(400, 'bad_args', 'A schedule needs a title and a prompt.')
      const tz = typeof a.tz === 'string' && validTz(a.tz) ? a.tz : tzOf(user.id)
      const w = parseWhen(a, Date.now())
      const { id } = q.insert.get(user.id, title, prompt, JSON.stringify(w.slots), w.runAt, tz) as { id: number }
      changed(user.id)
      return scheduleDto(q.schedule.get(id, user.id) as ScheduleRow)
    },
    updateSchedule(user: User, id: number, a: Record<string, unknown>) {
      const s = q.schedule.get(id, user.id) as ScheduleRow | undefined
      if (!s) throw new AppError(404, 'not_found', `No schedule #${id}.`)
      const retimed = a.run_at !== undefined || a.at !== undefined || a.days !== undefined
      const w = retimed ? parseWhen({ days: JSON.parse(s.slots)[0]?.days, at: JSON.parse(s.slots)[0]?.at, ...a }, Date.now()) : null
      const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 80) : s.title
      const prompt = typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt.trim().slice(0, 8000) : s.prompt
      const tz = typeof a.tz === 'string' && validTz(a.tz) ? a.tz : s.tz
      const enabled = typeof a.enabled === 'boolean' ? a.enabled : retimed ? true : !!s.enabled
      q.update.run(title, prompt, w ? JSON.stringify(w.slots) : s.slots, w ? w.runAt : s.run_at, tz, enabled ? 1 : 0, id)
      if (title !== s.title && s.session_id && q.session.get(s.session_id)) void claude.update(user, s.session_id, { title: scheduleTitle(title) }).catch(() => {})
      changed(user.id)
      return scheduleDto(q.schedule.get(id, user.id) as ScheduleRow)
    },
    deleteSchedule(user: User, id: number) {
      if (!q.remove.run(id, user.id).changes) throw new AppError(404, 'not_found', `No schedule #${id}.`)
      changed(user.id)
    },
  }
}
export type AssistantService = ReturnType<typeof assistantService>
