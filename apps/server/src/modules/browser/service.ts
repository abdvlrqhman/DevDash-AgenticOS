import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { newToken, seal, sha256, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'
import {
  computeObservationFingerprint,
  createCdpClient,
  type BrowserObservation,
  type CdpAction,
  type CdpActionResult,
} from './cdp.ts'
import { readScreen, screenSnapshot } from './screen.ts'
import type { User } from '../auth/repo.ts'

const NEKO = 'http://127.0.0.1:8090/browser'
const IDLE_MS = 30 * 60_000
const ENV_FILE = '/etc/devdash/browser.env'

type Invite = { id: number; token_hash: string; token_sealed: string; label: string; can_control: number; expires_at: number; created_by: number; created_at: number; revoked_at: number | null; creator_name: string }
type LegacyAction =
  | { kind: 'open'; url: string }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: string }

/**
 * The team's shared remote browser: one Chromium (neko) in Docker, started by the root helper when someone opens it
 * and stopped after 30 minutes with nobody watching (and no autonomous browser run active). Logins and cookies persist
 * in a volume between runs.
 *
 * Members join under their own name with full control; invite links let guests watch only. Caddy lets a request reach
 * /browser/ only with a DevDash session or a live invite cookie, so a revoked or expired invite stops working at once.
 */
export function browserService({ db, runDir, dataDir, masterKey, origin }: { db: Db; runDir: string; dataDir: string; masterKey: Buffer; origin: string }) {
  const q = {
    invites: db.prepare('select i.*, u.name as creator_name from browser_invites i join users u on u.id = i.created_by where i.revoked_at is null and i.expires_at > unixepoch() order by i.id desc'),
    byHash: db.prepare('select i.*, u.name as creator_name from browser_invites i join users u on u.id = i.created_by where i.token_hash = ?'),
    insert: db.prepare("insert into browser_invites (token_hash, token_sealed, label, can_control, expires_at, created_by) values (?, '', ?, ?, ?, ?) returning id"),
    sealToken: db.prepare('update browser_invites set token_sealed = ? where id = ?'),
    revoke: db.prepare('update browser_invites set revoked_at = unixepoch() where id = ?'),
  }
  let lastSeen = 0
  let busyCheck: (() => boolean) | undefined

  /** The bundled neko client only signs in with neko's multiuser mode: members get the admin profile, guests the watch-only one. */
  const secret = (key: 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD' | 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD') => {
    const v = readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]
    if (!v) throw new AppError(409, 'browser', 'The browser is not set up yet. Try again in a moment.')
    return v
  }

  async function helper<T = Record<string, unknown>>(cmd: string, args?: object): Promise<T> {
    if (!runDir) throw new AppError(409, 'no_host', 'The browser needs DevDash running on its Linux server.')
    const r = await requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd, args }, 180_000)
    if (!r.ok) throw new AppError(409, 'browser', r.error?.replace(/^refused: /, '') ?? 'The browser could not start.')
    return r
  }
  const apiToken = () => {
    try { return readFileSync(ENV_FILE, 'utf8').match(/^NEKO_SESSION_API_TOKEN=(.+)$/m)?.[1] ?? '' } catch { return '' }
  }

  const cdp = createCdpClient({ token: apiToken })

  async function start() {
    await helper('browser-start')
    lastSeen = Date.now()
    for (let i = 0; i < 90; i++) {
      try {
        if ((await fetch(`${NEKO}/`, { signal: AbortSignal.timeout(2000) })).ok) return
      } catch { /* still starting */ }
      await new Promise((ok) => setTimeout(ok, 1000))
    }
    throw new AppError(409, 'browser', 'The browser is taking too long to start. Try again in a minute.')
  }

  /** Someone connected to the stream right now (members in DevDash and guests on their own page alike)? */
  async function anyoneWatching() {
    const token = apiToken()
    if (!token) return false
    try {
      const r = await fetch(`${NEKO}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
      const sessions = (await r.json()) as { state?: { is_connected?: boolean } }[]
      return Array.isArray(sessions) && sessions.some((s) => s.state?.is_connected)
    } catch {
      return false
    }
  }

  // Every minute: an unwatched browser stops after 30 minutes, unless a browser agent run is actively executing.
  setInterval(() => {
    void (async () => {
      if (!runDir) return
      if (busyCheck?.()) {
        lastSeen = Date.now()
        return
      }
      if (!lastSeen) {
        const r = await helper<{ running: boolean }>('browser-status').catch(() => ({ running: false }))
        if (r.running) lastSeen = Date.now() // found running (e.g. after a DevDash restart): start counting
      } else if (Date.now() - lastSeen > IDLE_MS) {
        if (await anyoneWatching()) lastSeen = Date.now()
        else {
          lastSeen = 0
          console.log('browser stopped: nobody watched for 30 minutes')
          await helper('browser-stop').catch((err) => console.error('browser stop:', (err as Error).message))
        }
      }
    })()
  }, 60_000).unref()

  async function captureScreen() {
    const r = await fetch(NEKO + '/api/room/screen/shot.jpg', {
      headers: { authorization: 'Bearer ' + apiToken() }, redirect: 'error', signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (!r?.ok || !r.headers.get('content-type')?.startsWith('image/jpeg'))
      throw new AppError(409, 'browser_screen', 'Could not capture the screen. Start the shared browser and try again.')
    lastSeen = Date.now()
    return readScreen(Buffer.from(await r.arrayBuffer()))
  }

  async function legacyAct(action: LegacyAction) {
    lastSeen = Date.now()
    await helper('browser-action', action)
  }

  const link = (i: Invite) => `${origin}/watch/${unseal(masterKey, i.token_sealed, `browser-invite:${i.id}`).toString()}`
  const dto = (i: Invite) => ({ id: i.id, label: i.label, canControl: i.can_control === 1, expiresAt: i.expires_at, creator: i.creator_name, createdAt: i.created_at, url: link(i) })

  return {
    setBusyCheck(fn: () => boolean) {
      busyCheck = fn
    },
    screen: captureScreen,
    act: legacyAct,
    async observe(options?: { includeScreenshot?: boolean }): Promise<BrowserObservation> {
      try {
        const obs = await cdp.observe(options)
        lastSeen = Date.now()
        return obs
      } catch {
        // Fallback to OCR when running against an older container without CDP enabled.
        const lines = await captureScreen()
        const text = screenSnapshot(lines)
        return {
          mode: 'ocr',
          url: '',
          title: '',
          tabs: [],
          elements: [],
          text,
          fingerprint: computeObservationFingerprint({ url: '', title: '', elements: [], text }),
        }
      }
    },
    async actCdp(action: CdpAction, signal?: AbortSignal): Promise<CdpActionResult> {
      lastSeen = Date.now()
      try {
        return await cdp.act(action, signal)
      } catch (err) {
        if (await cdp.available()) {
          throw new AppError(409, 'browser_action', err instanceof Error ? err.message : 'The shared browser could not carry out the action.')
        }
        // Fallback to legacy xdotool helper when CDP is unavailable.
        if (action.kind === 'navigate') {
          await legacyAct({ kind: 'open', url: action.url })
          return { summary: `Opened ${action.url}`, url: action.url }
        }
        if (action.kind === 'click' && action.x !== undefined && action.y !== undefined) {
          await legacyAct({ kind: 'click', x: action.x, y: action.y })
          return { summary: `Clicked (${action.x}, ${action.y})` }
        }
        if (action.kind === 'fill') {
          if (action.x !== undefined && action.y !== undefined) {
            await legacyAct({ kind: 'click', x: action.x, y: action.y })
          }
          const singleLine = action.text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 500)
          if (singleLine) await legacyAct({ kind: 'type', text: singleLine })
          if (action.submit) await legacyAct({ kind: 'press', key: 'Enter' })
          return { summary: `Typed “${singleLine.slice(0, 60)}”${action.submit ? ' and pressed Enter' : ''}` }
        }
        if (action.kind === 'press') {
          await legacyAct({ kind: 'press', key: action.key })
          return { summary: `Pressed ${action.key}` }
        }
        if (action.kind === 'scroll') {
          await legacyAct({ kind: 'scroll', direction: action.direction })
          return { summary: `Scrolled ${action.direction}` }
        }
        throw new AppError(409, 'browser_cdp', 'This browser action requires CDP. Restart the shared browser to enable full DOM control.')
      }
    },
    status: async () => ({ running: (await helper<{ running: boolean }>('browser-status')).running }),

    /** Starts it if needed and returns the address that signs this member in (neko reads usr/pwd from the URL, then drops them). */
    async open(user: Pick<User, 'name'>) {
      await start()
      return `/browser/?${new URLSearchParams({ usr: user.name, pwd: secret('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD') })}`
    },
    heartbeat: () => void (lastSeen = Date.now()),
    async stop() {
      lastSeen = 0
      await helper('browser-stop')
    },

    invites: () => (q.invites.all() as Invite[]).map(dto),
    createInvite(user: Pick<User, 'id'>, o: { label: string; hours: number; canControl: boolean }) {
      const token = newToken()
      const { id } = q.insert.get(sha256(token), o.label.trim(), o.canControl ? 1 : 0, Math.floor(Date.now() / 1000) + o.hours * 3600, user.id) as { id: number }
      q.sealToken.run(seal(masterKey, Buffer.from(token), `browser-invite:${id}`), id)
      return dto((q.invites.all() as Invite[]).find((i) => i.id === id)!)
    },
    /** Revoked guests can't reach /browser/ any more: Caddy checks the invite on every request. */
    revokeInvite(id: number) {
      q.revoke.run(id)
    },

    /** A live invite behind a token, if any. */
    invite(token: string | undefined) {
      if (!token) return null
      const i = q.byHash.get(sha256(token)) as Invite | undefined
      return i && !i.revoked_at && i.expires_at > Date.now() / 1000 ? i : null
    },
    /** For an invite's guest: starts the browser if needed and returns their sign-in address. */
    async guestUrl(i: Invite) {
      await start()
      return `/browser/?${new URLSearchParams({ usr: `${i.label} (guest)`, pwd: secret('NEKO_MEMBER_MULTIUSER_USER_PASSWORD') })}`
    },
  }
}

export type BrowserService = ReturnType<typeof browserService>
