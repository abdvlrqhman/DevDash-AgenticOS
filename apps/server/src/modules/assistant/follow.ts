// Hamasa follows a session through to the end. The server, not the session's
// agent, notices when a followed session finishes a turn, asks something or fails, and wakes Hamasa in the member's
// chat with a hidden reminder (like hand_off). Level-triggered: what's due is the session's row against a saved cursor,
// so a restart, a lost event or a duplicate changes nothing. Events and a minute's tick only make it look sooner.
// Hamasa may answer a session for the member only within autopilot, checked here in code; permission prompts never.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import { localParts } from '../../core/schedule.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { AutopilotService } from '../autopilot/service.ts'
import { redQuestion } from '../autopilot/sweep.ts'
import type { ClaudeService } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { condense } from './mcp.ts'
import { AGENT_NAME } from './prompt.ts'
import type { AssistantService } from './service.ts'

export const MAX_REPLIES = 5 // automatic replies per follow until the member writes; Claude Code's Stop hooks stop at 8
export const MAX_FOLLOWS = 10
export const DAILY_WAKES = 40 // wake turns per member per day; past it the sessions ping them themselves again
export const QUIET_S = 30 // after the member's chat last moved: their own messages come first
export const STALE_S = 48 * 3600 // a follow with nothing happening for this long ends quietly
const DEBOUNCE_MS = 5_000 // sessions finishing together arrive as one reminder
const TICK_MS = 60_000
const RETRY_MS = 10 * 60_000 // after a failed wake: the sessions ping them themselves meanwhile

export type FollowRow = {
  id: number; user_id: number; session_id: string; goal: string; started_at: number; seen_activity: number
  replies: number; max_replies: number; last_sent_uuid: string | null; replied_hash: string | null; state: 'on' | 'waiting_you'
}
export type SessionSeen = {
  id: string; owner_id: number; title: string; status: string; status_detail: string | null; archived: number
  last_activity_at: number; harness: string; mode: string; project_slug: string | null
}
export type Kind = 'finished' | 'failed' | 'asks' | 'approval' | 'waits' | 'gone'
type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

/**
 * What the member's Hamasa should be told about a followed session now: an event, 'hold' (a permission prompt still in
 * autopilot's approvals window), 'stale' (nothing for two days: the follow ends quietly), or null. Pure, tested.
 */
export function due(f: Pick<FollowRow, 'seen_activity' | 'started_at'>, s: SessionSeen | undefined, nowS: number,
  o: { waitingOn?: 'question' | 'permission' | null; approvalsWait?: number | null } = {}): Kind | 'hold' | 'stale' | null {
  if (!s || s.archived) return 'gone'
  if (s.status === 'working') return null
  if (s.last_activity_at <= f.seen_activity) return nowS - Math.max(f.seen_activity, f.started_at) > STALE_S ? 'stale' : null
  if (s.status === 'error') return 'failed'
  if (s.status === 'waiting') {
    if (o.waitingOn === 'question') return 'asks'
    if (o.waitingOn === 'permission') return o.approvalsWait != null && nowS - s.last_activity_at < o.approvalsWait ? 'hold' : 'approval'
    return 'waits'
  }
  return 'finished'
}

/** Why Hamasa may not answer a followed session on its own now, or null when it may. Pure, tested. */
export function mayReply(o: {
  own: boolean; cli: boolean; state: string; replies: number; max: number; tookOver: boolean; loop: boolean; tier: unknown; why: unknown
  blocked: string | null
}): string | null {
  if (!o.own) return "It's a teammate's session: you only report on it. Tell them; they decide."
  if (o.cli) return "It's open in the CLI: nothing can be sent from here. Tell them."
  if (o.tier === 'red') return 'Red is never decided for them: tell them and let them decide.'
  if (o.tier !== 'green' && o.tier !== 'yellow') return 'Give tier: "green" or "yellow" by their autopilot rules (red: tell them instead).'
  if (typeof o.why !== 'string' || !o.why.trim()) return 'Give why: the rule, or what they already agreed in this chat.'
  if (o.blocked) return `${o.blocked}: don't answer for them; tell them instead.`
  if (o.state === 'waiting_you') return "You already told them about it: automatic replies wait until they write. Tell them if there's news."
  if (o.replies >= o.max) return `You already answered it ${o.replies} times on your own: stop and tell them where it stands.`
  if (o.tookOver) return 'Someone wrote in the session after you: a person took over. Report, don\'t reply.'
  if (o.loop) return 'It gave the same answer as before your last reply: it is going in circles. Stop and tell them.'
  return null
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
export const hash = (t: string) => {
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export type Item = {
  follow: FollowRow; session: SessionSeen | undefined; kind: Kind; answer: string | null; ask: string | null
  tookOver: boolean; loop: boolean
}
const SAID: Record<Kind, string> = {
  finished: 'finished a turn', failed: 'stopped with an error', asks: 'asks a question', approval: 'waits for their approval',
  waits: 'waits for them', gone: 'was archived or deleted: no longer followed',
}

/** The hidden message that wakes Hamasa in the member's chat: every changed session, oldest first. Pure, tested. */
export function reminder(first: string, items: Item[], autopilotOn: boolean) {
  const lines = items.map((it, i) => {
    const s = it.session
    const where = s ? ` (/sessions/${s.id})${s.project_slug ? ` in ${s.project_slug}` : ''}` : ''
    const head = `${i + 1}. "${s?.title ?? 'A session'}"${where} — ${SAID[it.kind]}. Goal: "${it.follow.goal}".`
    if (it.kind === 'gone') return head
    const parts = [head]
    if (it.answer) parts.push(`   Its last answer: "${clip(it.answer.replace(/\s+/g, ' ').trim(), 1500)}"`)
    if (it.kind === 'failed' && s?.status_detail) parts.push(`   Error: ${clip(s.status_detail, 300)}`)
    if (it.ask) parts.push(`   ${it.kind === 'approval' ? `Asks permission for: ${it.ask} (only ${first} decides this; you never can).` : `Asks: ${it.ask}`}`)
    if (it.tookOver) parts.push(`   Someone else wrote in it after you: report only.`)
    if (it.loop) parts.push('   Same answer as before your last reply: it is going in circles. Report only.')
    parts.push(`   Automatic replies left: ${Math.max(0, it.follow.max_replies - it.follow.replies)} of ${it.follow.max_replies}${it.follow.state === 'waiting_you' ? ' (paused: you told them; they write next)' : ''}.`)
    return parts.join('\n')
  })
  return `<system-reminder>Sessions you follow for ${first} changed (DevDash wrote this, not ${first}). Autopilot: ${autopilotOn ? 'on' : 'off, so you only report'}.
${lines.join('\n')}
For each one: if the next step is clearly what ${first} already agreed in this chat and autopilot allows it, continue it with follow_reply (or answer its question with follow_answer), with tier and why. Otherwise tell ${first} in a few lines, with the link. When its goal is reached, session_unfollow it and tell them what was done. If you're not sure, ask them; don't guess.
</system-reminder>`
}

export function followService({ db, hub, agents, claude, assistant, autopilot, notify, now = () => Date.now() }: {
  db: Db; hub: Hub; agents: AgentsService; claude: ClaudeService; assistant: AssistantService; autopilot: AutopilotService; notify: Notify; now?: () => number
}) {
  const q = {
    flag: db.prepare('select follow, follow_wakes, follow_wakes_on, tz from assistants where user_id = ?'),
    setFlag: db.prepare('update assistants set follow = ? where user_id = ?'),
    wakes: db.prepare('update assistants set follow_wakes = ?, follow_wakes_on = ? where user_id = ?'),
    users: db.prepare('select distinct f.user_id from assistant_follows f join assistants a on a.user_id = f.user_id where a.follow = 1'),
    user: db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null'),
    mine: db.prepare('select * from assistant_follows where user_id = ? order by id'),
    get: db.prepare('select * from assistant_follows where user_id = ? and session_id = ?'),
    of: db.prepare('select f.user_id from assistant_follows f join assistants a on a.user_id = f.user_id where f.session_id = ? and a.follow = 1'),
    count: db.prepare('select count(*) as n from assistant_follows where user_id = ?'),
    add: db.prepare(`insert into assistant_follows (user_id, session_id, goal, started_at, seen_activity, last_sent_uuid, max_replies)
      values (?1, ?2, ?3, ?4, ?5, ?6, ?7) on conflict (user_id, session_id) do update set goal = ?3, seen_activity = ?5, last_sent_uuid = ?6,
      replies = 0, replied_hash = null, state = 'on'`),
    remove: db.prepare('delete from assistant_follows where user_id = ? and session_id = ?'),
    seen: db.prepare('update assistant_follows set seen_activity = ? where id = ?'),
    sent: db.prepare('update assistant_follows set last_sent_uuid = ?, seen_activity = max(seen_activity, ?) where id = ?'),
    replied: db.prepare('update assistant_follows set replies = replies + 1, last_sent_uuid = ?, seen_activity = max(seen_activity, ?), replied_hash = ? where id = ?'),
    state: db.prepare('update assistant_follows set state = ? where id = ?'),
    resetOne: db.prepare("update assistant_follows set replies = 0, state = 'on' where user_id = ? and session_id = ?"),
    resetAll: db.prepare("update assistant_follows set replies = 0, state = 'on' where user_id = ?"),
    session: db.prepare(`select s.id, s.owner_id, s.title, s.status, s.status_detail, s.archived, s.last_activity_at, s.harness, s.mode, p.slug as project_slug
      from claude_sessions s left join projects p on p.id = s.project_id where s.id = ?`),
    lastMsg: db.prepare('select message_uuid from claude_message_senders where session_id = ? order by rowid desc limit 1'),
  }
  const nowS = () => Math.floor(now() / 1000)
  const on = (userId: number) => !!(q.flag.get(userId) as { follow: number } | undefined)?.follow
  const userOf = (id: number) => q.user.get(id) as User | undefined
  const sessionOf = (id: string) => q.session.get(id) as SessionSeen | undefined
  const lastMsg = (id: string) => (q.lastMsg.get(id) as { message_uuid: string } | undefined)?.message_uuid ?? null
  const first = (u: User) => u.name.split(' ')[0] || u.name
  const changed = (userId: number) => hub.publish('assistant', { type: 'changed' }, (u) => u.id === userId)
  const today = (userId: number) => {
    const a = q.flag.get(userId) as { follow_wakes: number; follow_wakes_on: string | null; tz: string }
    const date = localParts(a.tz || 'UTC', now()).date
    return { date, n: a.follow_wakes_on === date ? a.follow_wakes : 0 }
  }
  const capped = (userId: number) => today(userId).n >= DAILY_WAKES
  // After a failed wake the sessions ping the member themselves again until the retry.
  const failedUntil = new Map<number, number>()
  const failing = (userId: number) => (failedUntil.get(userId) ?? 0) > now()

  // A followed session reports through Hamasa while Hamasa can: its own pings to its owner don't go out then.
  claude.addReporter((s) => !!q.get.get(s.owner_id, s.id) && on(s.owner_id) && !capped(s.owner_id) && !failing(s.owner_id))

  // The member writing themself, in their chat or in a followed session: automatic replies may start again.
  claude.addPreamble((s) => {
    if (!claude.typedByOwner(s.id)) return []
    if (assistant.ofSession(s.owner_username, s.id)) q.resetAll.run(s.owner_id)
    else q.resetOne.run(s.owner_id, s.id)
    return []
  })

  // Per member, the wake turn being answered in their chat: which follows it covers, and which got a reply.
  const waking = new Map<string, { userId: number; items: Item[]; replied: Set<string>; hashes: Map<string, string> }>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  function poke(userId: number, ms = DEBOUNCE_MS) {
    if (timers.has(userId)) return
    const t = setTimeout(() => {
      timers.delete(userId)
      void deliver(userId).catch((err) => console.error('follow:', err))
    }, ms)
    t.unref?.()
    timers.set(userId, t)
  }
  const followers = (sessionId: string) => (q.of.all(sessionId) as { user_id: number }[]).map((r) => r.user_id)

  claude.onTurnEnd((t) => {
    const w = waking.get(t.session.id)
    if (w) void finishWake(t.session.id, w, t).catch((err) => console.error('follow wake end:', err))
    // Their chat went quiet: what waited for it can go once they had a moment to write.
    else if (assistant.ofSession(t.session.owner_username, t.session.id) && on(t.session.owner_id)) poke(t.session.owner_id, QUIET_S * 1000 + 1000)
    for (const u of followers(t.session.id)) poke(u)
  })
  claude.onPrompt((s) => {
    for (const u of followers(s.id)) poke(u)
  })

  async function waitingOn(user: User, s: SessionSeen) {
    if (s.status !== 'waiting' || s.mode !== 'chat') return { kind: null, ask: null }
    const pending = ((await claude.get(user, s.id).catch(() => ({ pending: [] }))).pending ?? []) as { toolName?: string; input?: Record<string, unknown> & { questions?: { question?: string; options?: { label?: string }[] }[] } }[]
    const perm = pending.find((p) => p.toolName !== 'AskUserQuestion')
    if (perm) {
      const i = perm.input ?? {}
      const what = [i.command, i.file_path, i.url, i.plan, i.description].find((v) => typeof v === 'string') as string | undefined
      return { kind: 'permission' as const, ask: `${perm.toolName}${what ? `: ${clip(what.replace(/\s+/g, ' '), 200)}` : ''}` }
    }
    const qn = pending.find((p) => p.toolName === 'AskUserQuestion')
    if (qn) {
      return {
        kind: 'question' as const,
        ask: (qn.input?.questions ?? []).map((x) => `${x.question ?? ''}${x.options?.length ? ` [${x.options.map((o) => o.label).join(' | ')}]` : ''}`).join(' / '),
      }
    }
    return { kind: null, ask: null }
  }
  async function lastAnswer(user: User, id: string) {
    try {
      const page = await claude.history(user, id)
      return condense((page.messages ?? []) as Parameters<typeof condense>[0], 6).filter((m) => m.from === 'agent' && m.text).at(-1)?.text ?? null
    } catch {
      return null
    }
  }

  const delivering = new Set<number>()
  /** Wakes the member's Hamasa about every followed session that changed, in one reminder, when their chat is free. */
  async function deliver(userId: number) {
    if (delivering.has(userId) || !on(userId) || capped(userId) || failing(userId)) return false
    const user = userOf(userId)
    if (!user) return false
    delivering.add(userId)
    try {
      const chatId = assistant.state(user).sessionId
      const chat = chatId ? sessionOf(chatId) : undefined
      if (chatId && waking.has(chatId)) return false // still answering the last one
      // Their messages first: never into a chat that's busy, waits for them, or that they wrote in moments ago.
      if (chat && (chat.status === 'working' || chat.status === 'waiting' || nowS() - chat.last_activity_at < QUIET_S)) return false
      const t = nowS()
      const items: Item[] = []
      const wait = autopilot.approvalsWait(userId)
      for (const f of q.mine.all(userId) as FollowRow[]) {
        const s = sessionOf(f.session_id)
        const w = s ? await waitingOn(user, s) : { kind: null, ask: null }
        const d = due(f, s, t, { waitingOn: w.kind, approvalsWait: wait })
        if (d === 'stale') {
          q.remove.run(userId, f.session_id)
          changed(userId)
          continue
        }
        if (!d || d === 'hold') continue
        const answer = d === 'finished' || d === 'failed' || d === 'asks' ? await lastAnswer(user, f.session_id) : null
        const loop = !!answer && !!f.replied_hash && hash(answer) === f.replied_hash
        const last = s ? lastMsg(s.id) : null
        items.push({ follow: f, session: s, kind: d, answer, ask: w.ask, tookOver: !!last && last !== f.last_sent_uuid, loop })
      }
      if (!items.length) return false
      items.sort((a, b) => (a.session?.last_activity_at ?? 0) - (b.session?.last_activity_at ?? 0))
      // Marked first: a slow or failed send never tells it twice. Put back below if it fails.
      for (const it of items) {
        if (it.kind === 'gone') q.remove.run(userId, it.follow.session_id)
        else q.seen.run(it.session!.last_activity_at, it.follow.id)
        if (it.loop) q.state.run('waiting_you', it.follow.id)
      }
      const day = today(userId)
      q.wakes.run(day.n + 1, day.date, userId)
      const real = items.filter((i) => i.kind !== 'gone')
      if (!real.length) { // only endings: nothing to say
        changed(userId)
        return false
      }
      try {
        const to = await assistant.current(user)
        const blocked = await autopilot.blocked(user).catch(() => 'Autopilot could not be checked')
        const hashes = new Map(real.filter((i) => i.answer).map((i) => [i.follow.session_id, hash(i.answer!)]))
        waking.set(to, { userId, items, replied: new Set(), hashes })
        try {
          await claude.send(user, to, reminder(first(user), items, !blocked), [])
        } catch (err) {
          waking.delete(to)
          throw err
        }
      } catch (err) {
        console.error(`follow: waking ${user.username}'s ${AGENT_NAME}:`, (err as Error).message)
        for (const it of real) q.seen.run(it.follow.seen_activity, it.follow.id)
        fallback(user, real)
        return false
      }
      changed(userId)
      return true
    } finally {
      delivering.delete(userId)
    }
  }

  /** Hamasa couldn't be woken, or its wake turn failed: the member hears it from DevDash, once, and sessions ping again. */
  function fallback(user: User, items: Item[]) {
    failedUntil.set(user.id, now() + RETRY_MS)
    const needs = items.some((i) => i.kind !== 'finished')
    const s = items[0]?.session
    void notify(user.id, needs ? 'needs_you' : 'finished', {
      title: `${AGENT_NAME} couldn't follow up`,
      body: clip(items.map((i) => `${i.session?.title ?? 'A session'}: ${SAID[i.kind]}`).join('; '), 200),
      url: s ? `/sessions/${s.id}` : '/', tag: `assistant:${user.id}:follow`,
    }).catch(() => {})
  }

  /** Hamasa's answer to a reminder is done: silent if it only continued sessions, otherwise that answer is the one ping. */
  async function finishWake(chatId: string, w: { userId: number; items: Item[]; replied: Set<string> }, t: { ok: boolean; aborted: boolean; result: string | null }) {
    waking.delete(chatId)
    const user = userOf(w.userId)
    if (!user || t.aborted) return // stopped from the chat: they're there
    const real = w.items.filter((i) => i.kind !== 'gone')
    if (!t.ok) return fallback(user, real)
    const told = real.filter((i) => !w.replied.has(i.follow.session_id))
    // Reported to them: automatic replies on those wait until they write.
    for (const i of told) q.state.run('waiting_you', i.follow.id)
    changed(user.id)
    if (!told.length || !t.result?.trim()) return
    if (hub.viewers(`session:${chatId}`).some((v) => v.id === user.id)) return // reading it as it's written
    const body = t.result.trim().replace(/\s+/g, ' ')
    await notify(user.id, told.some((i) => i.kind !== 'finished') ? 'needs_you' : 'finished', {
      title: AGENT_NAME, body: clip(body, 200), url: `/sessions/${chatId}`, tag: `assistant:${user.id}:follow`,
    })
  }

  /** Starts following: the member's own session, or one shared with them (then only reported on). */
  function follow(user: User, sessionId: string, goal: string) {
    if (!on(user.id)) throw new AppError(409, 'follow_off', `Following sessions isn't turned on for ${first(user)} yet (${AGENT_NAME}'s settings).`)
    const s = sessionOf(sessionId)
    if (!s || s.archived) throw new AppError(404, 'not_found', 'No such session, or it is archived.')
    if (assistant.ofSession(user.username, sessionId)) throw new AppError(400, 'bad_args', `That is one of ${AGENT_NAME}'s own conversations.`)
    if (!q.get.get(user.id, sessionId) && (q.count.get(user.id) as { n: number }).n >= MAX_FOLLOWS) {
      throw new AppError(409, 'too_many', `Up to ${MAX_FOLLOWS} followed sessions: unfollow one first.`)
    }
    const text = goal.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!text) throw new AppError(400, 'bad_args', 'Give the goal: what should be done when it is finished, in one line.')
    // From now on: what it already did before isn't news.
    q.add.run(user.id, sessionId, text, nowS(), s.status === 'working' ? s.last_activity_at - 1 : s.last_activity_at, lastMsg(sessionId), MAX_REPLIES)
    changed(user.id)
    return `Following "${s.title}". You'll be woken here when it finishes a turn, asks something or fails.`
  }
  function unfollow(user: User, sessionId: string) {
    const n = q.remove.run(user.id, sessionId).changes
    changed(user.id)
    return n ? 'No longer following it.' : "It wasn't followed."
  }

  /** A wake turn's automatic reply: only in their chat, only to a followed session, only within autopilot. */
  async function gate(user: User, chatId: string, sessionId: string, args: Record<string, unknown>) {
    if (assistant.state(user).sessionId !== chatId) throw new AppError(400, 'bad_args', 'Only in your chat with them.')
    if (claude.typedByOwner(chatId)) throw new AppError(400, 'bad_args', `${first(user)} is writing to you now: do what they ask with session_send.`)
    const f = q.get.get(user.id, sessionId) as FollowRow | undefined
    if (!f || !on(user.id)) throw new AppError(400, 'bad_args', "You don't follow that session: tell them instead.")
    const s = sessionOf(sessionId)
    if (!s || s.archived) throw new AppError(404, 'not_found', 'The session is gone.')
    if (s.harness === 't3code' && s.status === 'waiting') throw new AppError(409, 'native_request', 'Open the native T3 conversation to answer its request.')
    const w = waking.get(chatId)
    const last = lastMsg(sessionId)
    const no = mayReply({
      own: s.owner_id === user.id, cli: s.mode === 'cli', state: f.state, replies: f.replies, max: f.max_replies,
      tookOver: !!last && last !== f.last_sent_uuid, loop: !!w?.items.find((i) => i.follow.id === f.id)?.loop,
      tier: args.tier, why: args.why, blocked: s.owner_id === user.id ? await autopilot.blocked(user, s.harness) : null,
    })
    if (no) throw new AppError(403, 'not_now', no)
    return { f, s, w, tier: args.tier as 'green' | 'yellow', why: String(args.why).trim().slice(0, 300) }
  }
  function record(user: User, g: Awaited<ReturnType<typeof gate>>, uuid: string | null, what: string, message: string) {
    q.replied.run(uuid ?? g.f.last_sent_uuid, nowS(), g.w?.hashes.get(g.s.id) ?? g.f.replied_hash, g.f.id)
    g.w?.replied.add(g.s.id)
    autopilot.log(user.id, {
      tier: 'action', source: 'supervisor', project: g.s.project_slug, sessionId: g.s.id,
      what: `${AGENT_NAME} ${what} (${g.tier}): ${clip(message, 160)}`, why: g.why, message,
    })
    changed(user.id)
  }

  const ctx = (username: string, params: unknown) => {
    const c = (params ?? {}) as { sessionId?: string | null; args?: Record<string, unknown> }
    const user = assistant.ofSession(username, c.sessionId ?? null)
    if (!user) throw new AppError(403, 'not_assistant', 'These tools work only in your personal agent.')
    return { user, chatId: c.sessionId!, args: c.args ?? {} }
  }
  const str = (v: unknown, what: string) => {
    if (typeof v === 'string' && v.trim()) return v.trim()
    throw new AppError(400, 'bad_args', `Give ${what}.`)
  }
  agents.onRpc('mcp.session_follow', (username, params) => {
    const c = ctx(username, params)
    if (!claude.typedByOwner(c.chatId)) throw new AppError(403, 'not_asked', `Only when ${first(c.user)} asks you to, in a message they write to you here.`)
    return follow(c.user, str(c.args.id, 'the session id'), str(c.args.goal, 'the goal, in one line'))
  })
  agents.onRpc('mcp.session_unfollow', (username, params) => {
    const c = ctx(username, params)
    return unfollow(c.user, str(c.args.id, 'the session id'))
  })
  agents.onRpc('mcp.follow_reply', async (username, params) => {
    const c = ctx(username, params)
    const id = str(c.args.id, 'the session id')
    const text = str(c.args.text, 'the message to the session').slice(0, 4000)
    const g = await gate(c.user, c.chatId, id, c.args)
    const uuid = await claude.send(c.user, id, `(From ${AGENT_NAME}, ${first(c.user)}'s personal agent, on autopilot) ${text}`, [])
    record(c.user, g, uuid, 'continued', text)
    return `Sent. ${Math.max(0, g.f.max_replies - g.f.replies - 1)} automatic replies left; you'll be woken when it's done.`
  })
  agents.onRpc('mcp.follow_answer', async (username, params) => {
    const c = ctx(username, params)
    const id = str(c.args.id, 'the session id')
    const g = await gate(c.user, c.chatId, id, c.args)
    type P = { requestId: string; toolName: string; ownerOnly?: boolean; askedBy?: unknown; input?: Record<string, unknown> & { questions?: { question?: string }[] } }
    const pending = (await claude.get(c.user, id)).pending as P[]
    if (pending.some((p) => p.toolName !== 'AskUserQuestion')) throw new AppError(403, 'permission', `It waits for a permission: only ${first(c.user)} decides those. Tell them.`)
    const qn = pending.find((p) => p.toolName === 'AskUserQuestion')
    if (!qn) throw new AppError(409, 'no_question', 'It has no question waiting: use follow_reply, or tell them.')
    if (qn.ownerOnly || qn.askedBy) throw new AppError(403, 'owner_only', `Only ${first(c.user)} answers this one.`)
    const questions = (qn.input?.questions ?? []).map((x) => x.question ?? '')
    const red = redQuestion(questions.join(' '))
    if (red) throw new AppError(403, 'red', `Not for you: ${red}. Tell ${first(c.user)}.`)
    const given = (c.args.answers ?? {}) as Record<string, unknown>
    const answers = Object.fromEntries(questions.map((k) => [k, typeof given[k] === 'string' ? (given[k] as string).slice(0, 500) : '']).filter(([, v]) => v))
    if (!Object.keys(answers).length) throw new AppError(400, 'bad_args', `Give answers: {"<the question, exactly>": "<the option's label>"}. Questions: ${questions.join(' / ')}`)
    const marked = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, `${v} (answered by ${AGENT_NAME} for ${first(c.user)}, by their rules: ${clip(g.why, 120)})`]))
    await claude.answer(c.user, id, qn.requestId, { behavior: 'allow', updatedInput: { ...qn.input, answers: marked } })
    const said = Object.entries(answers).map(([k, v]) => `${k} → ${v}`).join('; ')
    record(c.user, g, null, 'answered', said)
    return 'Answered. You\'ll be woken when it moves on.'
  })

  async function tick() {
    for (const { user_id } of q.users.all() as { user_id: number }[]) await deliver(user_id).catch((err) => console.error('follow:', err))
  }

  return {
    deliver,
    tick,
    follow,
    unfollow,
    /** Hamasa sent something to a session on the member's word (session_send): that's theirs, not a person taking over. */
    sent(user: User, sessionId: string, uuid: string) {
      const f = q.get.get(user.id, sessionId) as FollowRow | undefined
      if (f) q.sent.run(uuid, nowS(), f.id)
    },
    /** Whether this turn of their chat is a wake turn and the session is followed: then replies go through follow_reply. */
    wakeTurnFor: (user: User, chatId: string, sessionId: string) => !claude.typedByOwner(chatId) && waking.has(chatId) && !!q.get.get(user.id, sessionId),
    state(user: User) {
      return {
        on: on(user.id),
        sessions: (q.mine.all(user.id) as FollowRow[]).map((f) => {
          const s = sessionOf(f.session_id)
          return { sessionId: f.session_id, title: s?.title ?? 'Session', status: s?.status ?? 'idle', goal: f.goal, replies: f.replies, maxReplies: f.max_replies, state: f.state }
        }),
      }
    },
    setOn(user: User, value: boolean) {
      if (user.role !== 'admin') throw new AppError(403, 'admin_only', 'Following sessions is in testing: an admin turns it on.')
      if (!q.flag.get(user.id)) throw new AppError(409, 'no_agent', 'Pick your personal agent first.')
      q.setFlag.run(value ? 1 : 0, user.id)
      changed(user.id)
    },
    /** The minute's pass over every member with follows: the safety net for anything an event missed, a restart included. */
    start() {
      setInterval(() => void tick(), TICK_MS).unref()
    },
  }
}
export type FollowService = ReturnType<typeof followService>
