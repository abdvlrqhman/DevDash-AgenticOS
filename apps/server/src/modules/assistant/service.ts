// Each member's personal agent: a chat with it on each agent (Claude Code, OpenCode), side by side with their own
// context, running as the member in their home folder, with DevDash tools across everything they can see (mcp.ts). The
// one they last picked is the one they talk in: schedules hand over, follow-ups wake and voice talks there. Underneath
// each is an ordinary session (unlisted, origin 'assistant'), so questions, permissions, models, history and
// notifications work as in any other. Schedules send it a prompt at set times.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { dueSlots, nextRun, slotKey, validSlots, validTz, type Slot } from '../../core/schedule.ts'
import type { User } from '../auth/repo.ts'
import { HARNESSES, type ClaudeService, type Harness } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { AGENT_NAME, instructions, READ_ONLY } from './prompt.ts'

/** The member's Hamasa: the agent they talk in now, and what both chats share (what they reach, the time zone). */
type Member = { user_id: number; harness: Harness; reach_tailnet: number; drive: number; tz: string }
/** One agent's chat: its account, how it works, its conversation and whether it wrote since they looked; with the shared part. */
type Chat = {
  user_id: number; harness: Harness; profile: string; model: string | null; effort: string | null; permission_mode: string
  fast: number; session_id: string | null; unread: number; reach_tailnet: number; drive: number; tz: string
}
const CHAT = 'select c.*, a.reach_tailnet, a.drive, a.tz from assistant_chats c join assistants a on a.user_id = c.user_id'
/**
 * How the agent works and what it reaches; each change applies to the current conversation too. Model, effort,
 * permission level and fast mode belong to the chat they talk in (each agent has its own); tailnet and Drive to both.
 */
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
    member: db.prepare('select user_id, harness, reach_tailnet, drive, tz from assistants where user_id = ?'),
    putMember: db.prepare(`insert into assistants (user_id, harness, tz) values (?1, ?2, ?3)
      on conflict (user_id) do update set harness = ?2, tz = ?3`),
    setActive: db.prepare('update assistants set harness = ? where user_id = ?'),
    access: db.prepare('update assistants set reach_tailnet = ?, drive = ? where user_id = ?'),
    chat: db.prepare(`${CHAT} where c.user_id = ? and c.harness = ?`),
    chats: db.prepare(`${CHAT} where c.user_id = ? order by c.harness`),
    putChat: db.prepare(`insert into assistant_chats (user_id, harness, profile) values (?1, ?2, ?3)
      on conflict (user_id, harness) do update set profile = ?3`),
    setSession: db.prepare('update assistant_chats set session_id = ? where user_id = ? and harness = ?'),
    setUnread: db.prepare('update assistant_chats set unread = ? where user_id = ? and harness = ?'),
    chatOf: db.prepare('select user_id, harness from assistant_chats where session_id = ?'),
    agentSettings: db.prepare('update assistant_chats set model = ?, effort = ?, permission_mode = ?, fast = ? where user_id = ? and harness = ?'),
    everyone: db.prepare('select a.user_id, a.tz, u.name, u.username from assistants a join users u on u.id = a.user_id where u.disabled_at is null'),
    session: db.prepare('select id, archived, started, harness, profile from claude_sessions where id = ?'),
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
    bySession: db.prepare('select id, title from assistant_schedules where session_id = ? and user_id = ?'),
    // The schedules' own conversations that are still open (not archived): settings changes reach them too.
    scheduleSessions: db.prepare(`select s.id, s.harness from assistant_schedules a join claude_sessions s on s.id = a.session_id
      where a.user_id = ? and s.archived = 0`),
  }
  hub.authorize('assistant', () => true) // events are published only to the member they're for

  const member = (userId: number) => q.member.get(userId) as Member | undefined
  const chatFor = (userId: number, harness: string) => q.chat.get(userId, harness) as Chat | undefined
  const chats = (userId: number) => q.chats.all(userId) as Chat[]
  /** The chat they talk in (picked in the panel), where schedules hand over, follow-ups wake and voice talks. */
  const active = (userId: number) => {
    const m = member(userId)
    return m ? chatFor(userId, m.harness) : undefined
  }
  /** A chat's conversation, unless it was archived (from its own page) or deleted: then the panel offers a new one. */
  const live = (c: Chat | undefined) => {
    const s = c?.session_id ? (q.session.get(c.session_id) as { archived: number } | undefined) : undefined
    return s && !s.archived ? c!.session_id : null
  }
  /** Their open chats, the one they talk in first. */
  const openChats = (userId: number) => {
    const m = member(userId)
    const all = chats(userId)
    return [...all.filter((c) => c.harness === m?.harness), ...all.filter((c) => c.harness !== m?.harness)].map(live).filter((x): x is string => !!x)
  }
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
  const tzOf = (userId: number) => member(userId)?.tz ?? 'UTC'
  function state(user: User) {
    const m = member(user.id)
    const all = m ? chats(user.id) : []
    const a = all.find((c) => c.harness === m!.harness)
    // Each agent's chat, for the panel: its account, its conversation, and whether it wrote since they last looked.
    const list = all.map((c) => {
      const id = live(c)
      return { harness: c.harness, profile: c.profile, sessionId: id, unread: !!c.unread && !!id }
    })
    return {
      agent: m && a ? {
        harness: a.harness, profile: a.profile, tz: m.tz, model: a.model, effort: a.effort, permissionMode: a.permission_mode,
        fastMode: !!a.fast, reachTailnet: !!m.reach_tailnet, drive: !!m.drive,
      } : null,
      // What there is to reach: switching one on needs it connected first.
      connected: { tailnet: !!tailnetConnected?.(user.id), drive: !!driveConnected?.(user.id) },
      sessionId: live(a), // the chat they talk in
      chats: list,
      unread: list.some((t) => t.unread), // in either chat: the launchers' dot
      schedules: schedules(user.id),
    }
  }

  /** A new conversation on one of the member's agents, set up as they set it; the session starts on the first message. */
  async function open(user: User, a: Chat, title?: string) {
    const s = await claude.create(user, {
      prompt: '', images: [], cwd: '~', profile: a.profile, model: a.model, effort: a.effort, permissionMode: a.permission_mode, mode: 'chat', harness: a.harness,
    }, {
      instructions: instructions({ name: user.name, username: user.username, tz: a.tz }), toolPolicy: { allow: READ_ONLY }, listed: false,
      ...(title ? { title, origin: { kind: 'assistant', role: 'schedule' } as const } : { origin: { kind: 'assistant' } as const }),
    })
    // A tailnet disconnected since doesn't stop the conversation from starting; it just doesn't reach it.
    if (a.fast || !a.drive) await claude.update(user, s.id, { fastMode: !!a.fast, drive: !!a.drive })
    if (a.reach_tailnet) await claude.update(user, s.id, { reachTailnet: true }).catch(() => {})
    return s.id
  }
  /** A fresh conversation in that agent's chat: the panel switches to it. */
  async function start(user: User, a: Chat) {
    const id = await open(user, a)
    q.setSession.run(id, user.id, a.harness)
    changed(user.id)
    return id
  }
  const scheduleTitle = (title: string) => `Scheduled: ${title}`
  /**
   * Where a schedule runs: its own conversation, never one the member is chatting in, so a run doesn't land in the
   * middle of their chat. Each run follows the earlier ones there, whichever chat they switch to meanwhile. A new one (on
   * the agent they talk in) when it was archived or deleted, or no chat of theirs runs on its agent and account anymore.
   */
  async function conversationFor(user: User, s: ScheduleRow) {
    const a = active(user.id)
    if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
    const c = s.session_id ? (q.session.get(s.session_id) as { id: string; archived: number; harness: string; profile: string } | undefined) : undefined
    const all = chats(user.id)
    // Never one of their chats (an earlier version could open a schedule's conversation as the chat).
    if (c && !c.archived && !all.some((x) => x.session_id === c.id) && all.some((x) => x.harness === c.harness && x.profile === c.profile)) return c.id
    const id = await open(user, a, scheduleTitle(s.title))
    q.setScheduleSession.run(id, s.id)
    return id
  }
  // Chats a schedule handed something to: when the agent's answer there is done, that answer is the notification.
  const handedOff = new Set<string>()
  claude.onTurnEnd((t) => {
    // Every answer in one of their chats lights its dot and the launchers' until they look (seen).
    const c = t.ok && !t.aborted && t.result?.trim() ? (q.chatOf.get(t.session.id) as { user_id: number; harness: string } | undefined) : undefined
    if (c && c.user_id === t.session.owner_id) {
      q.setUnread.run(1, c.user_id, c.harness)
      changed(c.user_id)
    }
    if (!handedOff.delete(t.session.id) || !t.ok || t.aborted || !t.result?.trim()) return
    const body = t.result.trim().replace(/\s+/g, ' ')
    void notify(t.session.owner_id, 'needs_you', {
      title: AGENT_NAME, body: body.length > 300 ? `${body.slice(0, 299)}…` : body, url: `/sessions/${t.session.id}`, tag: `assistant:${t.session.owner_id}:handoff`,
    }).catch(() => {})
  })
  const scheduleSessions = (userId: number) => q.scheduleSessions.all(userId) as { id: string; harness: string }[]
  /** Every conversation of theirs that gets Hamasa's instructions: both chats and the schedules' own. */
  const conversations = (userId: number) =>
    [...chats(userId).map((c) => c.session_id), ...scheduleSessions(userId).map((s) => s.id)].filter((x): x is string => !!x && !!q.session.get(x))
  const configureAll = (u: { id: number; name: string; username: string }, tz: string) => {
    for (const id of conversations(u.id)) claude.configure(id, { instructions: instructions({ name: u.name, username: u.username, tz }), toolPolicy: { allow: READ_ONLY } })
  }
  /** The conversation to talk in: the current one of the chat they're in, unless it was archived or deleted meanwhile. */
  async function current(user: User) {
    const a = active(user.id)
    if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
    return live(a) ?? start(user, a)
  }

  async function run(s: ScheduleRow, date: string | null) {
    const once = s.run_at != null
    const ran = date ? { ...(JSON.parse(s.ran) as Record<string, string>), ...Object.fromEntries((JSON.parse(s.slots) as Slot[]).map((x) => [slotKey(x), date])) } : JSON.parse(s.ran)
    q.ran.run(JSON.stringify(ran), once ? 0 : 1, s.id) // marked first: a slow or failed send never runs it twice
    const user = q.user.get(s.user_id) as User | undefined
    if (!user) return
    try {
      const open = openChats(user.id)
      const where = open.length > 1 ? `\n\n(Their chats with you are sessions ${open.join(' and ')}: session_read them for what they said there today.)`
        : open.length ? `\n\n(Their chat with you is session ${open[0]}: session_read it for what they said there today.)` : ''
      await claude.send(user, await conversationFor(user, s), `⏰ Scheduled: ${s.title}\n\n${s.prompt}${where}`, [])
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

  // Conversations are reused, never remade: after an update, each one gets the current instructions and allowed tools.
  for (const m of q.everyone.all() as { user_id: number; tz: string; name: string; username: string }[]) configureAll({ ...m, id: m.user_id }, m.tz)

  /**
   * Picks the agent (and its account) to talk in, and makes it the chat they're in. Its first chat, or another account
   * for it, starts a new conversation (the old one is archived, not deleted). The other agent's chat stays as it is.
   */
  async function setup(user: User, input: { harness: string; profile: string; tz?: string }) {
    if (!(HARNESSES as readonly string[]).includes(input.harness)) throw new AppError(400, 'bad_harness', 'Unknown agent.')
    if (!PROFILE_RE.test(input.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
    const old = chatFor(user.id, input.harness)
    const tz = input.tz && validTz(input.tz) ? input.tz : member(user.id)?.tz ?? 'UTC'
    q.putMember.run(user.id, input.harness, tz)
    q.putChat.run(user.id, input.harness, input.profile)
    const a = chatFor(user.id, input.harness)!
    if (!old?.session_id || old.profile !== a.profile) {
      if (old?.session_id && q.session.get(old.session_id)) await claude.update(user, old.session_id, { archived: true }).catch(() => {})
      await start(user, a)
    }
    configureAll(user, tz) // a new time zone reaches every conversation
    changed(user.id)
    return state(user)
  }

  return {
    tick,
    state,
    setup,

    /** Switches to the other agent's chat (the panel's … menu). Its first one starts on its default account. */
    async switchTo(user: User, harness: string) {
      if (!member(user.id)) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      if (!(HARNESSES as readonly string[]).includes(harness)) throw new AppError(400, 'bad_harness', 'Unknown agent.')
      if (!chatFor(user.id, harness)) return setup(user, { harness, profile: 'default' })
      q.setActive.run(harness, user.id)
      changed(user.id)
      return state(user)
    },

    /**
     * Model, effort, permission level and what it reaches: kept for new conversations, and applied to the current one.
     * The first four are the agent's (the other chat keeps its own); what it reaches is the same in both chats.
     */
    async settings(user: User, p: Settings) {
      const m = member(user.id)
      const a = active(user.id)
      if (!m || !a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      if (p.reachTailnet && !tailnetConnected?.(user.id)) throw new AppError(409, 'no_tailnet', 'Connect your tailnet on the Network page first.')
      if (p.drive && !driveConnected?.(user.id)) throw new AppError(409, 'no_drive', 'Connect your Google Drive on the Storage page first.')
      const shared = Object.fromEntries(Object.entries({ reachTailnet: p.reachTailnet, drive: p.drive }).filter(([, v]) => v !== undefined))
      const id = live(a)
      // The session checks each value (a known effort, a permission mode); the settings keep what it accepted.
      if (id) await claude.update(user, id, p)
      // The other chat, and the schedules' conversations, work the same way: the agent's settings on the same agent,
      // what it reaches on both. One that refuses a value doesn't stop the change.
      const others = [
        ...chats(user.id).filter((c) => c.harness !== a.harness).map((c) => ({ id: live(c), harness: c.harness })),
        ...scheduleSessions(user.id),
      ]
      for (const o of others) {
        const v = o.harness === a.harness ? p : shared
        if (o.id && o.id !== id && Object.keys(v).length) await claude.update(user, o.id, v).catch(() => {})
      }
      const pick = <T,>(v: T | undefined, old: T) => (v === undefined ? old : v)
      const bit = (v: boolean | undefined, old: number) => (v === undefined ? old : v ? 1 : 0)
      q.agentSettings.run(pick(p.model, a.model), pick(p.effort, a.effort), pick(p.permissionMode, a.permission_mode), bit(p.fastMode, a.fast), user.id, a.harness)
      q.access.run(bit(p.reachTailnet, m.reach_tailnet), bit(p.drive, m.drive), user.id)
      changed(user.id)
      return state(user)
    },

    /** Clears the chat they're in: its conversation is archived (not deleted) and an empty one takes its place. */
    async fresh(user: User) {
      const a = active(user.id)
      if (!a) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      const s = a.session_id ? (q.session.get(a.session_id) as { id: string; archived: number; started: number } | undefined) : undefined
      q.setUnread.run(0, user.id, a.harness)
      if (s && !s.archived && !s.started) return state(user) // already a fresh one
      if (s && !s.archived) await claude.update(user, s.id, { archived: true }).catch(() => {})
      await start(user, a)
      return state(user)
    },

    current,
    /** They've seen a chat (that conversation, or by default the one they're in): its dot goes. */
    seen(user: User, sessionId?: string) {
      const c = sessionId ? chats(user.id).find((x) => x.session_id === sessionId) : active(user.id)
      if (c) q.setUnread.run(0, user.id, c.harness)
      changed(user.id)
      return state(user)
    },
    /** Whether this session is one of the member's chats with the agent (not a schedule's conversation). */
    isChat: (user: User, sessionId: string) => chats(user.id).some((c) => c.session_id === sessionId),
    /** The schedule whose own conversation this session is, if it is one. */
    scheduleOf: (user: User, sessionId: string) => (q.bySession.get(sessionId, user.id) as { id: number; title: string } | undefined) ?? null,
    /**
     * A schedule's run needs them: the note goes to their chat with the agent as a reminder (hidden in the transcript),
     * the agent writes to them there, and its answer is the one notification they get.
     */
    async handOff(user: User, title: string, note: string) {
      const chat = await current(user)
      await claude.send(user, chat, `<system-reminder>Their schedule "${title}" ran on its own and handed this to you (they didn't write it): ${note}\nWrite to them about it now, in a few lines, in your own words, as the start of a conversation they can answer.</system-reminder>`, [])
      handedOff.add(chat)
      return `Handed to their chat: ${AGENT_NAME} writes to them there, and they're notified.`
    },
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
