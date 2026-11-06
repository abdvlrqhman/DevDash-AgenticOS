// The supervisor's decisions that need no model: which sessions it may touch now, its caps, and reading the model's
// answer. Pure functions, tested (autopilot.test.ts).
import { localParts } from '../../core/schedule.ts'

export type Settings = { quietMin: number; nightCap: number; maxNudges: number; tz: string; pingAt: string; approvals: boolean; promptWaitMin: number }
export const DEFAULTS: Settings = { quietMin: 20, nightCap: 20, maxNudges: 3, tz: 'Europe/Berlin', pingAt: '09:00', approvals: false, promptWaitMin: 2 }

/** One of the member's sessions as the sweep sees it. */
export type Candidate = {
  status: string
  mode: string
  started: boolean
  archived: boolean
  /** Hamasa's conversations, a team role's sessions and approved proposals run on their own rules. */
  excluded: boolean
  /** People with the session open right now (the member included). */
  viewers: number
  /** Unix seconds: the last message or status change, by anyone. */
  lastActivity: number
  /** Who sent the last message: the owner (themself or via autopilot), a teammate, or nobody yet. */
  lastSender: 'owner' | 'teammate' | null
  /** The member's own last message (autopilot's don't count): what the session is working towards. */
  goal: string | null
  statusDetail: string | null
  /** What the supervisor remembers of it. */
  memory: { goal: string | null; nudges: number; lastError: string | null; checkedActivity: number | null }
  /** It's already in Needs you, waiting for the member. */
  inInbox: boolean
}

export type Verdict =
  | { act: false; reason: string }
  | { act: 'needs_you'; kind: 'stuck'; reason: string }
  | { act: true }

/**
 * Whether the supervisor may look at a session now. Every safeguard that doesn't need a model is here: never while
 * someone is active (viewing, quiet gap, a teammate's turn or message), at most `maxNudges` per goal, and not again on
 * the same error.
 */
export function judge(c: Candidate, s: Settings, nowS: number): Verdict {
  if (c.excluded) return { act: false, reason: 'not a session of theirs autopilot runs' }
  if (!c.started || c.archived) return { act: false, reason: 'not started or archived' }
  if (c.mode !== 'chat') return { act: false, reason: 'open in the CLI' }
  if (c.status === 'working') return { act: false, reason: 'working' }
  if (!['idle', 'error', 'waiting'].includes(c.status)) return { act: false, reason: `status ${c.status}` }
  if (c.viewers > 0) return { act: false, reason: 'someone has it open' }
  // A session blocked on a prompt gets its answer sooner: nothing moves until it does.
  const quiet = c.status === 'waiting' ? Math.min(s.quietMin, s.promptWaitMin) : s.quietMin
  if (nowS - c.lastActivity < quiet * 60) return { act: false, reason: 'quiet gap' }
  if (c.lastSender !== 'owner') return { act: false, reason: c.lastSender === 'teammate' ? "a teammate's message is the last" : 'no message yet' }
  if (c.inInbox) return { act: false, reason: 'waiting in Needs you' }
  const sameGoal = c.memory.goal === c.goal
  const nudges = sameGoal ? c.memory.nudges : 0
  if (nudges >= s.maxNudges) return { act: 'needs_you', kind: 'stuck', reason: `still stuck after ${nudges} nudges` }
  if (c.status === 'error' && sameGoal && nudges > 0 && c.statusDetail && c.statusDetail === c.memory.lastError) {
    return { act: 'needs_you', kind: 'stuck', reason: 'the same error again after a nudge' }
  }
  if (sameGoal && c.memory.checkedActivity === c.lastActivity) return { act: false, reason: 'already judged, nothing new since' }
  return { act: true }
}

const minuteOf = (at: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60
}

/** When the current "night" started: the last morning ping time at or before now, in unix seconds. Caps count from it. */
export function nightStart(nowMs: number, tz: string, pingAt: string) {
  const t = localParts(tz, nowMs)
  const ping = minuteOf(pingAt)
  const back = t.minute >= ping ? t.minute - ping : t.minute - ping + 24 * 60
  return Math.floor(nowMs / 60_000) * 60 - back * 60
}

/** Whether the morning ping is due: past the ping time today (within two hours) and not checked today yet. */
export function pingDue(nowMs: number, tz: string, pingAt: string, pingedOn: string | null) {
  const t = localParts(tz, nowMs)
  const ping = minuteOf(pingAt)
  return t.date !== pingedOn && t.minute >= ping && t.minute - ping <= 120 ? t.date : null
}

export type Decision = {
  action: 'continue' | 'answer' | 'approve' | 'decline' | 'needs_you' | 'done'
  tier: 'green' | 'yellow' | 'red'
  message: string
  answers: Record<string, string>
  why: string
}

/** The supervisor model's answer, or null when it isn't one. A red tier always becomes needs_you. */
export function parseDecision(text: string): Decision | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(m[0])
  } catch {
    return null
  }
  const action = o.action as Decision['action']
  if (!['continue', 'answer', 'approve', 'decline', 'needs_you', 'done'].includes(action)) return null
  const tier = (['green', 'yellow', 'red'].includes(o.tier as string) ? o.tier : 'yellow') as Decision['tier']
  const message = typeof o.message === 'string' ? o.message.trim().slice(0, 2000) : ''
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, 300) : ''
  const answers = o.answers && typeof o.answers === 'object'
    ? Object.fromEntries(Object.entries(o.answers as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, (v as string).slice(0, 500)]))
    : {}
  // Red is never decided: an approval is declined (the session moves on), anything else waits for the member.
  if (tier === 'red' && (action === 'approve' || action === 'decline')) return { action: 'decline', tier, message: message || why, answers: {}, why }
  if (tier === 'red' && action !== 'done') return { action: 'needs_you', tier, message: message || why, answers: {}, why }
  if (action === 'decline') return null // declining is only for red
  if (action === 'continue' && !message) return null
  if (action === 'answer' && !Object.keys(answers).length) return null
  return { action, tier, message, answers, why }
}

type Limit = { utilization?: number | null; resets_at?: string | null }
/**
 * Where autopilot stops using the member's Claude plan, in percent: it leaves room for the member's own work. The
 * five-hour window resets soon, so it stops at 80%; the weekly ones (and any other) at 90%.
 */
export const USAGE_STOP: Record<string, number> = { five_hour: 80 }
const USAGE_STOP_OTHER = 90
/** The Claude plan's limits: the earliest reset of one autopilot should leave alone now, in unix seconds; null when there's room. */
export function limitedUntil(limits: Record<string, unknown> | null | undefined, nowS: number): number | null {
  let until: number | null = null
  for (const [window, v] of Object.entries(limits ?? {})) {
    const stop = USAGE_STOP[window] ?? USAGE_STOP_OTHER
    for (const l of (Array.isArray(v) ? v : [v]) as Limit[]) {
      if (!l || typeof l !== 'object' || typeof l.utilization !== 'number' || l.utilization < stop) continue
      const at = l.resets_at ? Math.floor(Date.parse(l.resets_at) / 1000) : nowS + 3600
      const t = Number.isFinite(at) && at > nowS ? at : nowS + 3600
      until = until == null ? t : Math.min(until, t)
    }
  }
  return until
}

/** An error that says the plan's usage limit is hit: the supervisor stops until it resets. */
export const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|out of (extra )?usage|credit balance/i

/** A permission prompt as autopilot sees it. `ownerOnly`/`askedBy`: the guest gate, a teammate's request using the owner's access. */
export type Prompt = { toolName: string; input?: Record<string, unknown>; ownerOnly?: boolean; askedBy?: unknown }

/**
 * Prompts autopilot never approves, whatever the rules: the guest gate (a teammate's request that would use the owner's
 * home folder, credentials or accounts) and DevDash deploy requests. Null: the tiers decide.
 */
export function neverApprove(p: Prompt): string | null {
  if (p.ownerOnly || p.askedBy) return "a teammate's request that uses your access"
  if (/devdash_deploy_request/.test(p.toolName)) return 'a DevDash deploy request'
  return null
}

/** What a prompt asks, in one line for the log and the supervisor: the command, file, URL or plan. */
export function describePrompt(p: Prompt) {
  const i = p.input ?? {}
  const what = [i.command, i.file_path, i.url, i.plan, i.description].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  const name = p.toolName === 'ExitPlanMode' ? 'Plan' : p.toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  return what ? `${name}: ${what.replace(/\s+/g, ' ').trim()}` : name
}

/**
 * Requests that are red on their face, whatever the conversation says: autopilot declines them without reading it.
 * Deleting (outside /tmp), history-rewriting git, dropping data, publishing, sudo. The reason, or null.
 */
export function obviousRed(p: Prompt): string | null {
  const cmd = typeof p.input?.command === 'string' ? p.input.command : ''
  if (cmd) {
    // Each command of a chain on its own, so "cd x && rm y" is seen.
    for (const part of cmd.split(/&&|\|\||;|\||\n/).map((x) => x.trim())) {
      const rm = /^(?:sudo\s+)?(rm|rmdir|unlink|shred)\s+(.*)$/.exec(part)
      if (rm) {
        const targets = rm[2]!.split(/\s+/).filter((a) => a && !a.startsWith('-'))
        if (!targets.length || targets.some((t) => !/^\/tmp\//.test(t))) return 'it deletes files outside /tmp'
      }
      if (/\bfind\b.*\s-delete\b/.test(part)) return 'it deletes files'
      if (/^git\s+clean\b.*-[a-z]*f/.test(part)) return 'it deletes untracked files'
      if (/^git\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s\+\S|\s:\S)/.test(part)) return 'it force-pushes or deletes a remote branch'
      if (/^git\s+branch\b.*\s-D\b/.test(part)) return 'it deletes a branch'
      if (/^git\s+reset\b.*--hard\b/.test(part)) return 'it throws away work (git reset --hard)'
      if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(part)) return 'it drops data'
      if (/^(npm|pnpm|yarn)\s+publish\b|^gh\s+release\s+create\b|^gh\s+repo\s+(delete|edit\b.*--visibility)|^docker\s+push\b|^rclone\s+(link|delete|purge)\b/.test(part)) return 'it publishes or deletes outside this server'
      if (/^sudo\b/.test(part)) return 'it uses sudo'
    }
  }
  return null
}

/**
 * A question about something red: publishing, sending to people, deleting, money, credentials or sharing, deploying.
 * Never answered on autopilot, not even with the safe option ("No"): the member decides. The reason, or null.
 */
export function redQuestion(text: string): string | null {
  const t = text.toLowerCase()
  if (/\b(publish\w*|public(ly)?|upload\w*|post(ed|ing)?|tweet\w*|go(es)? live|release\w*)\b/.test(t)) return 'it asks about publishing'
  if (/\b(send|sending|email\w*|e-mail|dm|notify (the )?(team|client|customer)s?)\b/.test(t)) return 'it asks about sending to people'
  if (/\b(delete\w*|remove\w*|wipe\w*|overwrite\w*|drop|purge|force[- ]push\w*)\b/.test(t)) return 'it asks about deleting or overwriting'
  if (/\b(pay|paid|payment|purchase\w*|buy|subscri\w*|billing|upgrade (the )?plan|credits?)\b/.test(t)) return 'it asks about money'
  if (/\b(credential\w*|password\w*|token\w*|api keys?|secret\w*|permissions?|access|share|sharing|invite\w*)\b/.test(t)) return 'it asks about accounts, credentials or sharing'
  if (/\bdeploy\w*\b/.test(t)) return 'it asks about deploying'
  return null
}

/** A role's ask waits this long for a teammate to answer before autopilot does (the team sees it too). */
export const TEAM_WAIT_MIN = 30

export type TeamDecision = { action: 'approve' | 'answer' | 'needs_you'; tier: 'green' | 'yellow' | 'red'; message: string; why: string }
/** The supervisor's answer about a role's ask; red, or an action that doesn't fit the ask, waits for the member. Pure, tested. */
export function parseTeamDecision(text: string, of: 'proposal' | 'ask'): TeamDecision | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(m[0])
  } catch {
    return null
  }
  const tier = (['green', 'yellow', 'red'].includes(o.tier as string) ? o.tier : 'yellow') as TeamDecision['tier']
  const message = typeof o.message === 'string' ? o.message.trim().slice(0, 2000) : ''
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, 300) : ''
  const fits = (of === 'proposal' && o.action === 'approve') || (of === 'ask' && o.action === 'answer' && !!message)
  if (tier === 'red' || !fits) return { action: 'needs_you', tier: tier === 'red' ? 'red' : tier, message: message || why, why }
  return { action: o.action as TeamDecision['action'], tier, message, why }
}
