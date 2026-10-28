import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import type { ApnsService } from './apns.ts'
import type { NtfyService } from './ntfy.ts'

export type NotificationKind = 'needs_you' | 'finished' | 'errors' | 'shared'
export type Prefs = Record<NotificationKind, boolean>
const KINDS: NotificationKind[] = ['needs_you', 'finished', 'errors', 'shared']

type Sub = { id: number; endpoint: string; p256dh: string; auth: string }

/**
 * Notifications reach a member four ways: the in-app feed, a live event to their open tabs and native apps
 * (a toast when looking, a system notification from the native app otherwise), Web Push to subscribed browsers,
 * and Apple's push service to the iPhone app (apns.ts). Pushes are skipped while the member has DevDash open and
 * focused somewhere, so nothing arrives twice.
 */
export function notificationsService({ db, hub, dataDir, origin, apns, ntfy }: {
  db: Db; hub: Hub; dataDir: string; origin: string
  apns?: Pick<ApnsService, 'deliver'>
  /** Members who turned on ntfy (phones without Apple push for the app): ntfy.ts. */
  ntfy?: Pick<NtfyService, 'deliver'>
}) {
  // VAPID keys identify this server to browsers' push services. Created once, kept with the data.
  const keyFile = join(dataDir, 'vapid.json')
  let keys: { publicKey: string; privateKey: string }
  if (existsSync(keyFile)) keys = JSON.parse(readFileSync(keyFile, 'utf8'))
  else {
    keys = webpush.generateVAPIDKeys()
    writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 })
  }
  // Push services want an https: or mailto: contact; local development runs on http://localhost.
  webpush.setVapidDetails(origin.startsWith('https:') ? origin : 'mailto:devdash@localhost', keys.publicKey, keys.privateKey)

  const s = {
    prefs: db.prepare('select needs_you, finished, errors, shared from notification_prefs where user_id = ?'),
    savePrefs: db.prepare(`insert into notification_prefs (user_id, needs_you, finished, errors, shared) values (?1, ?2, ?3, ?4, ?5)
      on conflict(user_id) do update set needs_you = ?2, finished = ?3, errors = ?4, shared = ?5`),
    subs: db.prepare('select id, endpoint, p256dh, auth from push_subscriptions where user_id = ?'),
    addSub: db.prepare(`insert into push_subscriptions (user_id, endpoint, p256dh, auth, device) values (?1, ?2, ?3, ?4, ?5)
      on conflict(endpoint) do update set user_id = ?1, p256dh = ?3, auth = ?4, device = ?5`),
    delSub: db.prepare('delete from push_subscriptions where endpoint = ?'),
    delSubFor: db.prepare('delete from push_subscriptions where endpoint = ? and user_id = ?'),
    okSub: db.prepare('update push_subscriptions set last_ok_at = unixepoch() where id = ?'),
    hasSub: db.prepare('select 1 from push_subscriptions where endpoint = ? and user_id = ?'),
    insert: db.prepare('insert into notifications (user_id, kind, title, body, url) values (?, ?, ?, ?, ?)'),
    list: db.prepare('select id, kind, title, body, url, created_at, read_at from notifications where user_id = ? order by id desc limit 50'),
    unread: db.prepare('select count(*) as n from notifications where user_id = ? and read_at is null'),
    readAll: db.prepare('update notifications set read_at = unixepoch() where user_id = ? and read_at is null'),
    prune: db.prepare(`delete from notifications where created_at < unixepoch() - 30 * 86400`),
  }

  /** Native apps holding a stream open (the Android app while it's closed): they get what Web Push would get. */
  type Event = { id: number; kind: string; title: string; body: string; url: string; tag: string }
  const streams = new Map<number, Set<(e: Event) => void>>()
  // What went out (or would have) in the last 15 minutes, for a stream that reconnects. Not what showed inside the app.
  const recent = new Map<number, (Event & { at: number })[]>()

  function prefs(userId: number): Prefs {
    const r = s.prefs.get(userId) as Record<NotificationKind, number> | undefined
    return Object.fromEntries(KINDS.map((k) => [k, r ? r[k] === 1 : k !== 'shared'])) as Prefs
  }

  async function push(userId: number, payload: object) {
    const data = JSON.stringify(payload)
    for (const sub of s.subs.all(userId) as Sub[]) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, data, { TTL: 3600, urgency: 'high' })
        s.okSub.run(sub.id)
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) s.delSub.run(sub.endpoint) // the device unsubscribed or the browser forgot it
        else console.error(`push to user ${userId} failed: ${(err as Error).message}`)
      }
    }
  }

  setInterval(() => s.prune.run(), 6 * 3_600_000).unref()

  return {
    publicKey: keys.publicKey,

    /** Sends if the member wants this kind. `tag` (e.g. "session:<id>") replaces older notifications about the same thing. */
    async notify(userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }, force = false) {
      if (!force && !prefs(userId)[kind]) return
      const id = Number(s.insert.run(userId, kind, n.title, n.body ?? null, n.url ?? null).lastInsertRowid)
      const event = { id, kind, title: n.title, body: n.body ?? '', url: n.url ?? '/', tag: n.tag ?? `${kind}:${id}` }
      hub.publish('notifications', { type: 'notification', notification: event }, (u) => u.id === userId)
      if (!force && hub.isActive(userId)) return
      const kept = (recent.get(userId) ?? []).filter((e) => e.at > Date.now() - 900_000).slice(-19)
      recent.set(userId, [...kept, { ...event, at: Date.now() }])
      for (const send of streams.get(userId) ?? []) send(event)
      await Promise.all([push(userId, event), apns?.deliver(userId, event), ntfy?.deliver(userId, event)])
    },

    /** Subscribes a stream; returns what it missed since `since` (a notification id) and how to unsubscribe. */
    listen(userId: number, since: number, send: (e: Event) => void) {
      const set = streams.get(userId) ?? new Set()
      streams.set(userId, set)
      set.add(send)
      const missed = since > 0
        ? (recent.get(userId) ?? []).filter((e) => e.id > since && e.at > Date.now() - 900_000).map(({ at: _, ...e }) => e)
        : []
      return {
        missed,
        stop: () => { set.delete(send); if (!set.size) streams.delete(userId) },
      }
    },

    prefs,
    savePrefs(userId: number, p: Prefs) {
      s.savePrefs.run(userId, ...KINDS.map((k) => (p[k] ? 1 : 0)))
      return prefs(userId)
    },
    subscribe(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device: string) {
      s.addSub.run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, device.slice(0, 200))
    },
    unsubscribe: (userId: number, endpoint: string) => void s.delSubFor.run(endpoint, userId),
    isSubscribed: (userId: number, endpoint: string) => s.hasSub.get(endpoint, userId) !== undefined,
    list: (userId: number) => ({
      notifications: s.list.all(userId) as { id: number; kind: string; title: string; body: string | null; url: string | null; created_at: number; read_at: number | null }[],
      unread: Number((s.unread.get(userId) as { n: number }).n),
    }),
    readAll: (userId: number) => void s.readAll.run(userId),
  }
}

export type NotificationsService = ReturnType<typeof notificationsService>
