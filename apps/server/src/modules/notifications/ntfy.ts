import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { Db } from '../../core/db.ts'
import { seal, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'

// Notifications through ntfy (docs.ntfy.sh) for phones whose DevDash app can't get Apple push: an iPhone app installed
// with a sideloading service is signed with that service's Apple account, and Apple only takes pushes for an app from
// the account that signed it. The free ntfy app has its own Apple push, so the member subscribes it to a topic and
// DevDash publishes there, next to Web Push and APNs, under the same rules (nothing while they're using DevDash).

export const DEFAULT_SERVER = 'https://ntfy.sh'
export type NtfyEvent = { id: number; kind: string; title: string; body: string; url: string; tag: string }

const PRIORITY: Record<string, number> = { needs_you: 4, errors: 4, finished: 3, shared: 3 } // 4 = high, 3 = default
const TAG: Record<string, string> = { needs_you: 'bell', errors: 'warning', finished: 'white_check_mark', shared: 'busts_in_silhouette' }
type Row = { user_id: number; server: string; topic: string; token_sealed: string | null; last_ok_at: number | null; last_error: string | null }

/** A long random topic: on a public server, knowing it is what lets someone read it. */
export const newTopic = () => `devdash-${randomBytes(12).toString('hex')}` // 96 random bits

/** An ntfy server: https, its root (ntfy doesn't run under a path), and a public name — never this machine or a LAN. */
export function checkServer(input: string) {
  let u: URL
  try { u = new URL(input.trim()) } catch { throw new AppError(400, 'bad_server', 'That is not a web address.') }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (u.protocol !== 'https:') throw new AppError(400, 'bad_server', 'Use an https:// address.')
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    throw new AppError(400, 'bad_server', 'Use the public name of the ntfy server, like ntfy.sh.')
  }
  if (u.pathname !== '/' || u.search || u.username) throw new AppError(400, 'bad_server', 'Give just the server, like https://ntfy.example.com.')
  return u.origin
}

/** What the ntfy app shows, and the page a tap opens. JSON, so titles in any language survive (headers may not). */
export function ntfyMessage(e: NtfyEvent, topic: string, origin: string) {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  return {
    topic,
    title: clip(e.title, 250),
    message: clip(e.body || e.title, 3000), // ntfy keeps messages to 4 KB
    priority: PRIORITY[e.kind] ?? 3,
    tags: TAG[e.kind] ? [TAG[e.kind]!] : [],
    ...(e.url.startsWith('/') && !e.url.startsWith('//') ? { click: origin + e.url } : {}),
    icon: `${origin}/icon-192.png`,
    // Like Web Push's tag: a newer notification about the same thing replaces the older one.
    sequence_id: e.tag.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64),
  }
}

export function ntfyService({ db, masterKey, origin, fetch: f = fetch }: { db: Db; masterKey: Buffer; origin: string; fetch?: typeof fetch }) {
  const q = {
    get: db.prepare('select * from ntfy_targets where user_id = ?'),
    upsert: db.prepare(`insert into ntfy_targets (user_id, server, topic, token_sealed) values (?, ?, ?, ?)
      on conflict(user_id) do update set server = excluded.server, topic = excluded.topic, token_sealed = excluded.token_sealed, last_error = null`),
    ok: db.prepare('update ntfy_targets set last_ok_at = unixepoch(), last_error = null where user_id = ?'),
    error: db.prepare('update ntfy_targets set last_error = ? where user_id = ?'),
    remove: db.prepare('delete from ntfy_targets where user_id = ?'),
  }
  const aad = (userId: number) => `ntfy:${userId}`
  const row = (userId: number) => q.get.get(userId) as Row | undefined

  function status(userId: number) {
    const r = row(userId)
    if (!r) return { enabled: false as const, server: DEFAULT_SERVER, topic: null, hasToken: false, lastOkAt: null, lastError: null, subscribeUrl: null }
    return {
      enabled: true as const, server: r.server, topic: r.topic, hasToken: !!r.token_sealed, lastOkAt: r.last_ok_at, lastError: r.last_error,
      subscribeUrl: `${r.server}/${r.topic}`,
    }
  }

  async function send(r: Row, e: NtfyEvent) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (r.token_sealed) headers.authorization = `Bearer ${unseal(masterKey, r.token_sealed, aad(r.user_id)).toString()}`
    const res = await f(`${r.server}/`, { method: 'POST', headers, body: JSON.stringify(ntfyMessage(e, r.topic, origin)), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const why = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
      throw new Error(`${new URL(r.server).host} answered ${res.status}${why ? `: ${why}` : ''}`)
    }
  }

  return {
    status,

    /** Turns it on (a new random topic) or changes the server or token; the topic stays unless `newTopic`. */
    configure(userId: number, input: { server?: string; token?: string | null; newTopic?: boolean }) {
      const r = row(userId)
      const server = input.server !== undefined ? checkServer(input.server || DEFAULT_SERVER) : (r?.server ?? DEFAULT_SERVER)
      const token = input.token === undefined ? (r?.token_sealed ?? null)
        : input.token?.trim() ? seal(masterKey, Buffer.from(input.token.trim()), aad(userId)) : null
      q.upsert.run(userId, server, !r || input.newTopic ? newTopic() : r.topic, token)
      return status(userId)
    },

    disable(userId: number) {
      q.remove.run(userId)
      return status(userId)
    },

    /** Sends to the member's topic if they turned it on. Never throws: like the other paths, a notification is best effort. */
    async deliver(userId: number, e: NtfyEvent) {
      const r = row(userId)
      if (!r) return
      try {
        await send(r, e)
        q.ok.run(userId)
      } catch (err) {
        q.error.run((err as Error).message.slice(0, 300), userId)
      }
    },

    /** A test straight to ntfy, saying how it went, so the member can check their phone is subscribed. */
    async test(userId: number) {
      const r = row(userId)
      if (!r) throw new AppError(409, 'off', 'Turn on ntfy notifications first.')
      try {
        await send(r, { id: 0, kind: 'needs_you', title: 'DevDash test', body: 'If you see this, ntfy notifications work on this phone.', url: '/account', tag: 'ntfy-test' })
        q.ok.run(userId)
        return { ok: true as const, error: null }
      } catch (err) {
        q.error.run((err as Error).message.slice(0, 300), userId)
        return { ok: false as const, error: (err as Error).message }
      }
    },
  }
}

export type NtfyService = ReturnType<typeof ntfyService>
