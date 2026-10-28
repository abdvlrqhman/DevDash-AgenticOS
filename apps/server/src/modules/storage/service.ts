import { randomBytes } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import { newToken, seal, sha256, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import * as google from './google.ts'

// Members' own cloud storage. Each member connects their Google Drive once; their sessions,
// every profile, and their terminals then reach it as the rclone remote `drive:`, rooted at a "DevDash" folder.
// The Google refresh token stays here, sealed. The member's rclone config only holds an opaque handle, which the local
// token endpoint (/internal/storage/token, never proxied to the internet) trades for short-lived access tokens.
type AppRow = { provider: string; client_id: string; client_secret_sealed: string; contact_email: string | null; updated_at: number }
type Row = {
  user_id: number; provider: string; account_sub: string; account_email: string; folder_id: string
  refresh_token_sealed: string; handle_hash: string; handle_sealed: string; broken: string | null; created_at: number; updated_at: number
}
/** What a session's agent needs to set up the remote: the handle, never the Google token. */
export type LaunchStorage = { remote: string; account: string; folderId: string; handle: string; tokenUrl: string }

export const REMOTE = 'drive'
const PENDING_MS = 10 * 60_000
const REVOKED = 'Google access was revoked or has expired. Connect Google Drive again on the Storage page.'
const APP_CHANGED = "The space's Google app changed. Connect Google Drive again on the Storage page."

export function storageService({ db, agents, masterKey, origin, tokenUrl, fetch: f = fetch, now = Date.now }: {
  db: Db; agents: AgentsService; masterKey: Buffer; origin: string
  /** The local token endpoint rclone calls, e.g. http://127.0.0.1:8787/internal/storage/token. */
  tokenUrl: string
  fetch?: google.Fetch
  now?: () => number
}) {
  const q = {
    app: db.prepare("select * from storage_apps where provider = 'gdrive'"),
    saveApp: db.prepare(`insert into storage_apps (provider, client_id, client_secret_sealed, contact_email, updated_by) values ('gdrive', ?, ?, ?, ?)
      on conflict(provider) do update set client_id = excluded.client_id, client_secret_sealed = excluded.client_secret_sealed,
        contact_email = excluded.contact_email, updated_by = excluded.updated_by, updated_at = unixepoch()`),
    get: db.prepare('select * from member_storage where user_id = ?'),
    byHandle: db.prepare('select * from member_storage where handle_hash = ?'),
    upsert: db.prepare(`insert into member_storage (user_id, provider, account_sub, account_email, folder_id, refresh_token_sealed, handle_hash, handle_sealed)
      values (?, 'gdrive', ?, ?, ?, ?, ?, ?)
      on conflict(user_id) do update set account_sub = excluded.account_sub, account_email = excluded.account_email, folder_id = excluded.folder_id,
        refresh_token_sealed = excluded.refresh_token_sealed, handle_hash = excluded.handle_hash, handle_sealed = excluded.handle_sealed,
        broken = null, updated_at = unixepoch()`),
    setBroken: db.prepare('update member_storage set broken = ?, updated_at = unixepoch() where user_id = ?'),
    breakAll: db.prepare('update member_storage set broken = ?, updated_at = unixepoch()'),
    remove: db.prepare('delete from member_storage where user_id = ?'),
    user: db.prepare('select id, username from users where id = ? and disabled_at is null'),
  }
  // A page in the app (outside the sign-in guard), so it also works when Google opened in another browser (the native app).
  const redirectUri = `${origin}/storage/callback`
  const aad = { app: 'storage:gdrive:app', token: (userId: number) => `storage:gdrive:token:${userId}`, handle: (userId: number) => `storage:gdrive:handle:${userId}` }
  /** OAuth round trips in flight: state → who started it and their PKCE verifier. Single use, ten minutes. */
  const pending = new Map<string, { userId: number; verifier: string; at: number }>()
  /** Access tokens handed out, kept until five minutes before they expire, so parallel rclone runs share one. */
  const access = new Map<number, { token: string; expiresAt: number }>()
  const inflight = new Map<number, Promise<{ token: string; expiresAt: number }>>()

  const app = (): google.GoogleApp | null => {
    const r = q.app.get() as AppRow | undefined
    return r ? { clientId: r.client_id, clientSecret: unseal(masterKey, r.client_secret_sealed, aad.app).toString() } : null
  }
  const needApp = () => {
    const a = app()
    if (!a) throw new AppError(409, 'not_configured', 'Google Drive is not set up for this space yet. An admin adds the Google app on the Storage page.')
    return a
  }
  const row = (userId: number) => q.get.get(userId) as Row | undefined

  /** An access token for the member's Drive, from the cache or Google. A refused refresh marks the connection broken. */
  async function accessToken(r: Row) {
    const hit = access.get(r.user_id)
    if (hit && hit.expiresAt - now() > 5 * 60_000) return hit
    const running = inflight.get(r.user_id)
    if (running) return running
    const p = (async () => {
      try {
        const t = await google.refresh(f, needApp(), unseal(masterKey, r.refresh_token_sealed, aad.token(r.user_id)).toString())
        const got = { token: t.accessToken, expiresAt: now() + t.expiresIn * 1000 }
        access.set(r.user_id, got)
        if (r.broken) q.setBroken.run(null, r.user_id)
        return got
      } catch (err) {
        if (err instanceof google.GoogleError && (err.code === 'invalid_grant' || err.code === 'invalid_client' || err.code === 'unauthorized_client')) {
          q.setBroken.run(err.code === 'invalid_grant' ? REVOKED : APP_CHANGED, r.user_id)
        }
        throw err
      } finally {
        inflight.delete(r.user_id)
      }
    })()
    inflight.set(r.user_id, p)
    return p
  }

  /** Writes (or clears) the remote in the member's rclone config, as them. Best effort: each session start re-checks it. */
  const pushRemote = (username: string, s: LaunchStorage | null) =>
    agents.request(username, s ? { op: 'storage.configure', storage: s } : { op: 'storage.remove', remote: REMOTE, tokenUrl }).catch(() => {})

  const forLaunch = (userId: number): LaunchStorage | null => {
    const r = row(userId)
    if (!r || r.broken) return null
    return { remote: REMOTE, account: r.account_email, folderId: r.folder_id, handle: unseal(masterKey, r.handle_sealed, aad.handle(userId)).toString(), tokenUrl }
  }

  /** The admin view of the Google app. The secret never comes back out. */
  const appInfo = () => {
    const r = q.app.get() as AppRow | undefined
    return {
      configured: !!r, clientId: r?.client_id ?? null, redirectUri, scopes: google.SCOPES, updatedAt: r?.updated_at ?? null,
      // Google's Branding page wants a public home page and privacy policy (spacePagesRoutes) and a contact for them.
      contactEmail: r?.contact_email ?? null, homeUrl: `${origin}/about`, privacyUrl: `${origin}/privacy`,
    }
  }

  /** Revokes and forgets a member's connection: on disconnect, and when they leave the space. */
  async function forget(userId: number, username: string | null) {
    const r = row(userId)
    if (!r) return
    q.remove.run(userId)
    access.delete(userId)
    await google.revoke(f, unseal(masterKey, r.refresh_token_sealed, aad.token(userId)).toString())
    if (username) await pushRemote(username, null)
  }

  return {
    forLaunch,
    appInfo,

    /** The public pages' contact (spacePagesRoutes): null until an admin sets it. */
    contactEmail: () => (q.app.get() as AppRow | undefined)?.contact_email ?? null,

    /** An admin registers (or replaces) the space's Google OAuth app. A different app can't use the old grants. */
    setApp(admin: User, input: { clientId: string; clientSecret?: string; contactEmail?: string | null }) {
      const before = q.app.get() as AppRow | undefined
      const secret = input.clientSecret?.trim() || (before ? unseal(masterKey, before.client_secret_sealed, aad.app).toString() : '')
      if (!secret) throw new AppError(400, 'no_secret', 'Paste the client secret too.')
      const clientId = input.clientId.trim()
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new AppError(400, 'bad_client_id', 'That does not look like a Google client ID (…apps.googleusercontent.com).')
      const contact = input.contactEmail === undefined ? (before?.contact_email ?? null) : input.contactEmail?.trim() || null
      q.saveApp.run(clientId, seal(masterKey, Buffer.from(secret), aad.app), contact, admin.id)
      if (before && before.client_id !== clientId) {
        q.breakAll.run(APP_CHANGED)
        access.clear()
      }
      return appInfo()
    },

    /** The member's connection, and how full their Drive is (best effort: Google may be slow or the grant gone). */
    async status(user: User) {
      const r = row(user.id)
      const base = { configured: !!q.app.get(), connected: !!r, remote: REMOTE }
      if (!r) return { ...base, account: null, folderUrl: null, broken: null, quota: null }
      let usage: { used: number; limit: number | null } | null = null
      if (!r.broken) usage = await accessToken(r).then((t) => google.quota(f, t.token)).catch(() => null)
      const fresh = row(user.id)!
      return { ...base, account: fresh.account_email, folderUrl: google.folderUrl(fresh.folder_id), broken: fresh.broken, quota: usage }
    },

    /** Starts connecting: the Google consent page to send the member's browser to. */
    connectUrl(user: User) {
      const a = needApp()
      for (const [k, v] of pending) if (now() - v.at > PENDING_MS) pending.delete(k)
      const state = newToken()
      const verifier = randomBytes(32).toString('base64url')
      pending.set(state, { userId: user.id, verifier, at: now() })
      return { url: google.authUrl(a, redirectUri, state, sha256(verifier)) }
    },

    /**
     * Google sent the browser back with a code. The single-use state (ten minutes) says whose connection this is, so it
     * also completes in a browser that isn't signed in to DevDash (the native app opens Google in the system browser);
     * a browser signed in as someone else is refused, so nobody can slip their own sign-in link to a teammate.
     */
    async callback(viewer: User | null, p: { code?: string; state?: string; error?: string }): Promise<{ ok: boolean; message: string }> {
      const fail = (message: string) => ({ ok: false, message })
      const started = p.state ? pending.get(p.state) : undefined
      if (p.state) pending.delete(p.state)
      if (!started || now() - started.at > PENDING_MS) return fail('That sign-in link expired. Start again from the Storage page.')
      if (viewer && viewer.id !== started.userId) return fail('Another DevDash member started this Google sign-in. Start again from your own Storage page.')
      const user = q.user.get(started.userId) as Pick<User, 'id' | 'username'> | undefined
      if (!user) return fail('That DevDash account is no longer active.')
      if (p.error || !p.code) return fail(p.error === 'access_denied' ? 'You cancelled on Google, so nothing was connected.' : `Google said: ${p.error ?? 'no code'}`)
      try {
        const a = needApp()
        const t = await google.exchangeCode(f, a, redirectUri, p.code, started.verifier)
        const folderId = await google.ensureFolder(f, t.accessToken)
        // A fresh handle on every connect: whatever an old config file held stops working.
        const handle = `ddh_${newToken()}`
        q.upsert.run(user.id, t.sub, t.email, folderId, seal(masterKey, Buffer.from(t.refreshToken), aad.token(user.id)),
          sha256(handle), seal(masterKey, Buffer.from(handle), aad.handle(user.id)))
        access.set(user.id, { token: t.accessToken, expiresAt: now() + t.expiresIn * 1000 })
        await pushRemote(user.username, forLaunch(user.id))
        return { ok: true, message: `Google Drive connected (${t.email}).` }
      } catch (err) {
        if (err instanceof google.GoogleError || err instanceof AppError) return fail(err.message)
        throw err
      }
    },

    /** Disconnects: Google forgets DevDash, the handle dies, and the remote leaves the member's rclone config. */
    async disconnect(user: User) {
      await forget(user.id, user.username)
      return { ok: true }
    },

    /** A member left the space: their connection goes too (the privacy page promises it). */
    memberRemoved: (userId: number) => forget(userId, null),

    /**
     * The local token endpoint's work (rclone's `token_url`). Trades a member's handle for a short-lived Google access
     * token; an unknown handle or a revoked grant comes back as OAuth's invalid_grant, which rclone reports.
     */
    async token(handle: string) {
      const r = handle.startsWith('ddh_') ? (q.byHandle.get(sha256(handle)) as Row | undefined) : undefined
      if (!r) throw new google.GoogleError('invalid_grant', 'This DevDash storage link was disconnected. Connect Google Drive again on the Storage page.')
      if (r.broken) throw new google.GoogleError('invalid_grant', r.broken)
      const t = await accessToken(r)
      return { access_token: t.token, token_type: 'Bearer', expires_in: Math.max(60, Math.floor((t.expiresAt - now()) / 1000)) }
    },
  }
}

export type StorageService = ReturnType<typeof storageService>
