// Moving a member's autopilot prototype (~/.claude/autopilot: rules.md, log.md, state) into DevDash, once.
// Pure functions, tested (autopilot.test.ts); scripts/autopilot-import.mjs sends the files.
import { localParts } from '../../core/schedule.ts'
import { DEFAULT_RULES } from './prompt.ts'
import type { Tier } from './service.ts'

export type Imported = { at: number; tier: Tier; project: string | null; sessionId: string | null; what: string; why: string | null }

/** Unix seconds of a local "YYYY-MM-DD HH:MM" in `tz`. */
export function localToUnix(date: string, time: string, tz: string) {
  const guess = Date.parse(`${date}T${time}:00Z`)
  // The zone's offset at that moment, read back from Intl (twice, for the hour around a DST change).
  let at = guess
  for (let i = 0; i < 2; i++) {
    const p = localParts(tz, at)
    const shown = Date.parse(`${p.date}T${String(Math.floor(p.minute / 60)).padStart(2, '0')}:${String(p.minute % 60).padStart(2, '0')}:00Z`)
    at = guess - (shown - at)
  }
  return Math.floor(at / 1000)
}

const TIERS: Record<string, Tier> = { '🟢': 'green', '🟡': 'yellow', '🔴': 'red' }

/** The prototype's log.md lines ("- 2026-11-05 23:36 · 🟢 · **home** · what · _why_ · [session](/sessions/<id>)"). */
export function parsePrototypeLog(md: string, tz = 'Europe/Berlin'): Imported[] {
  const out: Imported[] = []
  for (const line of md.split('\n')) {
    const m = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · (.*)$/.exec(line.trim())
    if (!m) continue
    const at = localToUnix(m[1]!, m[2]!, tz)
    const parts = m[3]!.split(' · ')
    const toggle = /\*\*Autopilot turned (on|off)\*\*/.exec(m[3]!)
    if (toggle) {
      out.push({ at, tier: 'system', project: null, sessionId: null, what: `Autopilot turned ${toggle[1]} (prototype)`, why: null })
      continue
    }
    const tier = TIERS[parts[0]!.trim()]
    if (!tier || parts.length < 3) continue
    const project = /^\*\*(.+)\*\*$/.exec(parts[1]!.trim())?.[1] ?? null
    let sessionId: string | null = null
    let why: string | null = null
    const rest = parts.slice(2).filter((p) => {
      const s = /^\[session\]\(\/sessions\/([\w-]+)\)$/.exec(p.trim())
      if (s) return (sessionId = s[1]!), false
      const w = /^_(.*)_$/.exec(p.trim())
      if (w) return (why = w[1]!), false
      return true
    })
    const what = rest.join(' · ').trim()
    if (what) out.push({ at, tier, project, sessionId, what, why })
  }
  return out
}

/**
 * The prototype's rules.md as DevDash rules: its own logging (the `ap` command) and phone notices become autopilot's,
 * the tier emoji and the trial heading go. Rules that say what the default says become the default (null), so they
 * follow later improvements to it.
 */
export function convertPrototypeRules(md: string, name: string): string | null {
  const first = name.split(' ')[0] || name
  let t = md.replace(/^# Autopilot is ON[^\n]*\n+/, '')
  t = t.replace(/- Log the decision at the moment you make it:\n\s*`[^`]*ap log[^`]*`\n\s*If it answers that autopilot is OFF, he turned it off: ask him as usual\./,
    '- Log the decision at the moment you make it, with the DevDash tool autopilot_log (tier green or yellow, what you decided, why: the rule or preference).\n  If it answers that autopilot is off, they turned it off: ask them as usual.')
  t = t.replace(/^## 🟡 Yellow: decide, log, and notify his phone$/m, '## Yellow: decide, log as yellow, keep going')
  t = t.replace(/^Notify with the DevDash `notify_me` tool[^\n]*$/m, `Yellow decisions reach ${first} on their Autopilot page and in the morning ping: you don't notify them yourself.`)
  t = t.replace(/^## [🟢🟡🔴] /gmu, '## ').trim()
  return t === DEFAULT_RULES.replaceAll('{name}', first).trim() ? null : t
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2))
/**
 * A prototype entry that a session also logged with autopilot_log: same session and tier, within 15 minutes, and
 * mostly the same words (a session words the same decision a little differently for each log).
 */
export function isDuplicate(e: Pick<Imported, 'at' | 'tier' | 'sessionId' | 'what'>, h: { at: number; tier: string; sessionId: string | null; what: string }) {
  if (e.tier !== h.tier || (e.sessionId ?? null) !== (h.sessionId ?? null) || Math.abs(e.at - h.at) > 15 * 60) return false
  const a = words(e.what), b = words(h.what)
  if (!a.size || !b.size) return e.what.trim() === h.what.trim()
  let same = 0
  for (const w of a) if (b.has(w)) same++
  return same / Math.min(a.size, b.size) >= 0.6
}
