// When roles work on their own: weekly time slots read in the project's time zone. Pure functions, tested.

export type Slot = { days: number[]; at: string } // days 0 = Sunday … 6 = Saturday; at = "HH:MM"
export const TRIGGERS = ['work', 'task_done', 'task_created'] as const
export type Trigger = (typeof TRIGGERS)[number]

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const LATE_OK_MIN = 20 // a slot missed by a restart still runs if the server is back within this many minutes

/** The date, weekday and minute of the day at `ms` in time zone `tz`. */
const formats = new Map<string, Intl.DateTimeFormat>()
export function localParts(tz: string, ms: number) {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    formats.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAY[p.weekday!]!, minute: Number(p.hour) * 60 + Number(p.minute) }
}

export const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const minuteOf = (at: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}
export const slotKey = (s: Slot) => `${[...s.days].sort().join('')}@${s.at}`

export function validSlots(raw: unknown): Slot[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s) => {
    const days = Array.isArray(s?.days) ? [...new Set((s.days as unknown[]).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))] : []
    const at = typeof s?.at === 'string' ? s.at.padStart(5, '0') : ''
    const min = minuteOf(at)
    return days.length && min >= 0 && min < 24 * 60 ? [{ days: days.sort(), at }] : []
  }).slice(0, 10)
}

/** Slots due now that haven't run today (`ran`: slot key → local date it last ran). */
export function dueSlots(slots: Slot[], ran: Record<string, string>, tz: string, now: number) {
  const t = localParts(tz, now)
  return slots.filter((s) => {
    const at = minuteOf(s.at)
    return s.days.includes(t.weekday) && t.minute >= at && t.minute - at <= LATE_OK_MIN && ran[slotKey(s)] !== t.date
  }).map((s) => ({ slot: s, date: t.date }))
}

/** When the next slot starts, as a unix time (to the minute), or null without slots. Looks a week ahead. */
export function nextRun(slots: Slot[], tz: string, now: number) {
  if (!slots.length) return null
  // Hour by hour (a week is 192 steps); within an hour, local minutes and real minutes move together.
  const hour = Math.floor(now / 3_600_000) * 3_600_000
  for (let ms = hour; ms < hour + 8 * 86_400_000; ms += 3_600_000) {
    const t = localParts(tz, ms)
    const hits = slots
      .filter((s) => s.days.includes(t.weekday))
      .map((s) => minuteOf(s.at) - t.minute)
      .filter((d) => d >= 0 && d < 60)
      .map((d) => ms + d * 60_000)
      .filter((at) => at > now)
    if (hits.length) return Math.min(...hits) / 1000
  }
  return null
}
