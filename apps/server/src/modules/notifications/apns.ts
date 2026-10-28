import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import { seal, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'

// Notifications for the native iPhone app while it's closed. Apple's provider API is HTTP/2
// to api(.sandbox).push.apple.com, signed in with a short JWT (ES256) made from the space's .p8 key, which an admin
// uploads once and which stays sealed here. node:http2 and node:crypto cover all of it, so there is no dependency.

export type ApnsEnv = 'sandbox' | 'production'
const HOSTS: Record<ApnsEnv, string> = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' }

export type ApnsRequest = { env: ApnsEnv; deviceToken: string; headers: Record<string, string>; body: string }
/** Apple's answer: the HTTP status and, on errors, its reason (and for 410, since when the token is dead, in ms). */
export type ApnsResponse = { status: number; reason?: string; timestamp?: number }
/** Sends one notification to Apple. Injectable, so tests never reach the network. */
export type ApnsTransport = { send(r: ApnsRequest): Promise<ApnsResponse>; close(): void }
/** A notification as the notifications service sends it. */
export type ApnsEvent = { id: number; kind: string; title: string; body: string; url: string; tag: string }

/** The DevDash app's bundle ID (apps/shell/src-tauri/tauri.conf.json), the default topic. */
export const DEFAULT_BUNDLE_ID = 'io.github.abdvlrqhman.devdash'
const AAD = 'apns:key'

/** One HTTP/2 connection per environment, kept and reused as Apple asks; reopened after an error, GOAWAY or an idle hour. */
export function http2Transport({ timeoutMs = 15_000, hosts = HOSTS }: { timeoutMs?: number; hosts?: Record<ApnsEnv, string> } = {}): ApnsTransport {
  const sessions = new Map<ApnsEnv, ClientHttp2Session>()
  const busy = new WeakMap<ClientHttp2Session, number>()
  const session = (env: ApnsEnv) => {
    const open = sessions.get(env)
    if (open && !open.closed && !open.destroyed) return open
    const s = connect(hosts[env])
    const forget = () => { if (sessions.get(env) === s) sessions.delete(env) }
    s.on('error', forget) // the request in flight fails by itself
    s.on('goaway', () => { forget(); s.close() })
    s.on('close', forget)
    s.setTimeout(3_600_000, () => s.close())
    sessions.set(env, s)
    return s
  }
  // An idle connection never keeps the process alive; one with a request in flight does.
  const hold = (s: ClientHttp2Session, n: number) => {
    const now = (busy.get(s) ?? 0) + n
    busy.set(s, now)
    if (now > 0) s.ref()
    else if (!s.destroyed) s.unref()
  }
  return {
    send: ({ env, deviceToken, headers, body }) => new Promise<ApnsResponse>((resolve, reject) => {
      const s = session(env)
      hold(s, 1)
      const req = s.request({ ':method': 'POST', ':path': `/3/device/${deviceToken}`, ...headers })
      req.once('close', () => hold(s, -1))
      let status = 0
      let data = ''
      req.setEncoding('utf8')
      req.setTimeout(timeoutMs, () => {
        req.close(constants.NGHTTP2_CANCEL)
        reject(new Error('Apple did not answer in time'))
      })
      req.on('response', (h) => { status = Number(h[':status']) })
      req.on('data', (chunk: string) => { data += chunk })
      req.on('end', () => {
        let r: { reason?: string; timestamp?: number } = {}
        try { if (data) r = JSON.parse(data) } catch { /* not JSON: the status says enough */ }
        resolve({ status, reason: r.reason, timestamp: r.timestamp })
      })
      req.on('error', reject)
      // After 'end' this is a no-op; without it, a stream reset before any answer would wait forever.
      req.on('close', () => reject(new Error(`the connection to Apple closed (code ${req.rstCode})`)))
      req.end(body)
    }),
    close() {
      for (const s of sessions.values()) s.close()
      sessions.clear()
    },
  }
}

/** Apple's provider token: a JWT signed with the .p8 key, ES256 with the raw r‖s signature JWS wants. */
export function providerToken(c: { teamId: string; keyId: string; key: KeyObject }, iat: number) {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const input = `${part({ alg: 'ES256', kid: c.keyId })}.${part({ iss: c.teamId, iat })}`
  return `${input}.${sign('sha256', Buffer.from(input), { key: c.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/** Cuts to at most `max` UTF-8 bytes without splitting a character. */
function clip(s: string, max: number, more = '…') {
  if (Buffer.byteLength(s) <= max) return s
  const room = max - Buffer.byteLength(more)
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch)
    if (bytes + b > room) break
    bytes += b
    out += ch
  }
  return out + more
}

/** What the iPhone shows, and the page a tap opens (the app reads `url`). The body shrinks until it fits Apple's 4 KB. */
export function apnsPayload(e: ApnsEvent, origin: string, bodyBytes = 2000) {
  const path = e.url.startsWith('/') && !e.url.startsWith('//') && Buffer.byteLength(e.url) <= 1000 ? e.url : '/'
  return {
    aps: { alert: { title: clip(e.title, 300), body: clip(e.body, bodyBytes) }, sound: 'default', 'thread-id': e.kind },
    url: origin + path,
    id: e.id,
  }
}
function encode(e: ApnsEvent, origin: string) {
  for (const size of [2000, 800, 200]) {
    const json = JSON.stringify(apnsPayload(e, origin, size))
    if (Buffer.byteLength(json) <= 4096) return json
  }
  return JSON.stringify(apnsPayload({ ...e, body: '' }, origin, 0))
}

const KEY_HELP = "That isn't an APNs key. Choose (or paste) the whole AuthKey_….p8 file Apple gave you, from BEGIN PRIVATE KEY to END PRIVATE KEY."
/** The .p8 file as PEM, rebuilt so that just its base64 lines, or a paste whose line breaks got lost, work too. */
function readKey(text: string) {
  const body = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  const pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END PRIVATE KEY-----\n` // gitleaks:allow (a template that wraps a pasted key; no key here)
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch {
    throw new AppError(400, 'bad_key', KEY_HELP)
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new AppError(400, 'bad_key', KEY_HELP)
  return pem
}

type ConfigRow = {
  team_id: string; key_id: string; key_sealed: string; bundle_id: string; updated_at: number; last_error: string | null; last_error_at: number | null
}
type Device = { id: number; token: string; environment: ApnsEnv; updated_at: number }
type Creds = { teamId: string; keyId: string; bundleId: string; key: KeyObject; jwt?: { token: string; iat: number } }

/** Things only an admin can fix, in Apple's words (handling-notification-responses-from-apns). */
const REFUSED: Record<string, (env: ApnsEnv, bundleId: string) => string> = {
  InvalidProviderToken: () => 'Apple rejected the key. Check the Team ID, the Key ID and the .p8 file, and that the key has Apple Push Notifications service enabled.',
  BadEnvironmentKeyIdInToken: (env) => `This key can't send to Apple's ${env === 'sandbox' ? 'Sandbox' : 'Production'} environment, which this iPhone's app uses. Make a key for ${env === 'sandbox' ? 'Sandbox' : 'Production'} (or for both) and upload it here.`,
  ExpiredProviderToken: () => "Apple says the server's sign-in token is too old. Check the server's clock.",
  DeviceTokenNotForTopic: (_e, bundleId) => `This iPhone's app isn't ${bundleId}. Check the bundle ID.`,
  TopicDisallowed: (_e, bundleId) => `Apple won't send to ${bundleId} with this key.`,
  BadTopic: (_e, bundleId) => `Apple doesn't accept ${bundleId} as the bundle ID.`,
}

export function apnsService({ db, masterKey, origin, transport = http2Transport(), now = Date.now }: {
  db: Db; masterKey: Buffer; origin: string; transport?: ApnsTransport; now?: () => number
}) {
  const q = {
    config: db.prepare('select * from apns_config where id = 1'),
    saveConfig: db.prepare(`insert into apns_config (id, team_id, key_id, key_sealed, bundle_id, updated_by) values (1, ?, ?, ?, ?, ?)
      on conflict(id) do update set team_id = excluded.team_id, key_id = excluded.key_id, key_sealed = excluded.key_sealed,
        bundle_id = excluded.bundle_id, updated_by = excluded.updated_by, updated_at = unixepoch(), last_error = null, last_error_at = null`),
    deleteConfig: db.prepare('delete from apns_config where id = 1'),
    setError: db.prepare('update apns_config set last_error = ?, last_error_at = unixepoch() where id = 1'),
    clearError: db.prepare('update apns_config set last_error = null, last_error_at = null where id = 1 and last_error is not null'),
    devices: db.prepare('select id, token, environment, updated_at from apns_devices where user_id = ?'),
    upsert: db.prepare(`insert into apns_devices (user_id, token, environment, device) values (?1, ?2, ?3, ?4)
      on conflict(token) do update set user_id = ?1, environment = ?3, device = ?4, updated_at = unixepoch()`),
    forget: db.prepare('delete from apns_devices where token = ? and user_id = ?'),
    drop: db.prepare('delete from apns_devices where id = ?'),
    ok: db.prepare('update apns_devices set last_ok_at = unixepoch() where id = ?'),
    setEnv: db.prepare('update apns_devices set environment = ? where id = ?'),
    counts: db.prepare('select environment, count(*) as n from apns_devices group by environment'),
  }

  let creds: Creds | null | undefined // undefined: not read yet
  const load = (): Creds | null => {
    if (creds !== undefined) return creds
    const r = q.config.get() as ConfigRow | undefined
    creds = r ? { teamId: r.team_id, keyId: r.key_id, bundleId: r.bundle_id, key: createPrivateKey(unseal(masterKey, r.key_sealed, AAD)) } : null
    return creds
  }
  /** A new key also needs new connections: Apple ties a connection to the key of its first request. */
  const reset = () => {
    creds = undefined
    transport.close()
  }
  const configured = () => {
    try { return load() !== null } catch { return false }
  }

  let shown: string | null = null
  const problem = (message: string) => {
    if (message !== shown) console.error(`apns: ${message}`)
    shown = message
    q.setError.run(message)
  }

  /** Apple wants a new token at most every 20 minutes and at least every 60: this renews after 50. */
  const jwt = (c: Creds) => {
    const t = Math.floor(now() / 1000)
    if (!c.jwt || t - c.jwt.iat >= 50 * 60) c.jwt = { token: providerToken(c, t), iat: t }
    return c.jwt.token
  }
  const request = (c: Creds, env: ApnsEnv, deviceToken: string, body: string, tag: string) => transport.send({
    env, deviceToken, body,
    headers: {
      authorization: `bearer ${jwt(c)}`,
      'apns-topic': c.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // Like Web Push's TTL: an hour, then it's stale.
      'apns-expiration': String(Math.floor(now() / 1000) + 3600),
      // Like Web Push's tag: a newer notification about the same thing replaces the older one.
      'apns-collapse-id': clip(tag, 64, ''),
    },
  })

  async function deliverTo(c: Creds, d: Device, body: string, tag: string) {
    let env = d.environment
    let r = await request(c, env, d.token, body, tag)
    if (r.status === 400 && r.reason === 'BadDeviceToken') {
      // Usually a token from the other environment (a development build talking to production, or the reverse).
      const other: ApnsEnv = env === 'sandbox' ? 'production' : 'sandbox'
      const again = await request(c, other, d.token, body, tag).catch(() => null)
      if (!again) return
      if (again.status === 400 && again.reason === 'BadDeviceToken') return void q.drop.run(d.id) // neither knows it
      if (again.status === 200) q.setEnv.run(other, d.id)
      env = other
      r = again
    }
    if (r.status === 200) {
      q.ok.run(d.id)
      shown = null
      q.clearError.run()
      return
    }
    if (r.status === 410) {
      // The app was removed or got a new token. Keep it only if the phone registered it again after Apple's date.
      if (!(r.timestamp && d.updated_at * 1000 > r.timestamp)) q.drop.run(d.id)
      return
    }
    const fix = r.reason ? REFUSED[r.reason] : undefined
    if (fix) {
      if (r.reason === 'ExpiredProviderToken') c.jwt = undefined
      return problem(fix(env, c.bundleId))
    }
    if (r.reason === 'UnrelatedKeyIdInToken') transport.close()
    if (r.status === 403) return problem(`Apple refused the key (${r.reason ?? 'no reason given'}).`)
    // 429 TooManyRequests, 5xx: Apple is busy; this one is lost, like a Web Push that times out.
    console.error(`apns: Apple answered ${r.status} ${r.reason ?? ''} for device ${d.id}`)
  }

  /** The admin view. The key itself never comes back out. */
  function info() {
    const r = q.config.get() as ConfigRow | undefined
    const n = Object.fromEntries((q.counts.all() as { environment: ApnsEnv; n: number }[]).map((x) => [x.environment, Number(x.n)]))
    return {
      configured: !!r, teamId: r?.team_id ?? null, keyId: r?.key_id ?? null, bundleId: r?.bundle_id ?? DEFAULT_BUNDLE_ID,
      updatedAt: r?.updated_at ?? null, lastError: r?.last_error ?? null, lastErrorAt: r?.last_error_at ?? null,
      devices: { sandbox: n.sandbox ?? 0, production: n.production ?? 0 },
    }
  }

  return {
    info,
    configured,

    /** An admin sets (or replaces) the space's APNs key. Changing the key or team needs the new .p8 file. */
    setConfig(admin: User, input: { teamId: string; keyId: string; bundleId: string; key?: string }) {
      const teamId = input.teamId.trim().toUpperCase()
      const keyId = input.keyId.trim().toUpperCase()
      const bundleId = input.bundleId.trim()
      if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new AppError(400, 'bad_team_id', 'The Team ID is 10 letters and digits. It is under Membership details in your Apple developer account.')
      if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new AppError(400, 'bad_key_id', 'The Key ID is 10 letters and digits. It is in the file name, AuthKey_<Key ID>.p8.')
      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new AppError(400, 'bad_bundle_id', `The bundle ID looks like ${DEFAULT_BUNDLE_ID}.`)
      const before = q.config.get() as ConfigRow | undefined
      let pem: string
      if (input.key?.trim()) pem = readKey(input.key)
      else if (!before) throw new AppError(400, 'no_key', 'Add the .p8 key file too.')
      else if (before.key_id !== keyId || before.team_id !== teamId) throw new AppError(400, 'no_key', 'A different key or team needs its .p8 file too.')
      else pem = unseal(masterKey, before.key_sealed, AAD).toString()
      q.saveConfig.run(teamId, keyId, seal(masterKey, Buffer.from(pem), AAD), bundleId, admin.id)
      shown = null
      reset()
      return info()
    },

    /** Turns iPhone notifications off for the space. Devices stay, so they work again with a new key. */
    removeConfig() {
      q.deleteConfig.run()
      reset()
      return info()
    },

    /** The iPhone app (signed in as this member) hands over its device token; a token moves to whoever signs in. */
    register(userId: number, d: { token: string; environment: ApnsEnv; device: string }) {
      q.upsert.run(userId, d.token.toLowerCase(), d.environment, d.device.slice(0, 200))
      return { configured: configured() }
    },
    unregister: (userId: number, token: string) => void q.forget.run(token.toLowerCase(), userId),

    /** Sends to each of the member's iPhones. Never throws: a notification is best effort, like Web Push. */
    async deliver(userId: number, e: ApnsEvent) {
      let loaded: Creds | null
      try {
        loaded = load()
      } catch (err) {
        return problem(`The saved key can't be read (${(err as Error).message}). Upload the .p8 file again.`)
      }
      if (!loaded) return
      const c = loaded
      const devices = q.devices.all(userId) as Device[]
      if (!devices.length) return
      const body = encode(e, origin)
      await Promise.all(devices.map((d) => deliverTo(c, d, body, e.tag).catch((err) => problem(`Couldn't reach Apple: ${(err as Error).message}`))))
    },

    close: () => transport.close(),
  }
}

export type ApnsService = ReturnType<typeof apnsService>
