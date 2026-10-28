import { api, unwrap } from './api'
import { backgroundOff, notificationPermission, setBackgroundOff } from './shell'

// The iPhone app's notifications while it's closed, through Apple's push service. The app
// asks Apple for a device token at each launch and hands it to this page (apps/shell/src-tauri/src/ios_push.rs); the
// page registers it with this server for the signed-in member.

/** What the iPhone app knows: a device token, or why there is none ("no-entitlement": signed without push). */
export type IosPushState = { token: string | null; environment: 'sandbox' | 'production' | null; error: string | null }

declare global {
  interface Window {
    /** Set by the iPhone app on each page load and whenever it changes, with a 'devdash-push' event. */
    __devdashPushState?: IosPushState
  }
}

/** The iPhone app with Apple push (from the version after 0.1.7). */
export const iosPushApp = () => typeof window.devdashShell?.registerPush === 'function'

const settled = (s: IosPushState | undefined): s is IosPushState => !!s && (!!s.token || !!s.error)

/** The app's answer, waiting a little for it after launch. null if it doesn't come. */
export function iosPushState(timeoutMs = 10_000): Promise<IosPushState | null> {
  if (!iosPushApp()) return Promise.resolve(null)
  if (settled(window.__devdashPushState)) return Promise.resolve(window.__devdashPushState)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('devdash-push', check)
      resolve(window.__devdashPushState ?? null)
    }
    const check = () => { if (settled(window.__devdashPushState)) done() }
    const timer = setTimeout(done, timeoutMs)
    window.addEventListener('devdash-push', check)
  })
}

/** The token this page gave the server, while the server can push to it. */
let registered: string | null = null
/** This iPhone gets DevDash's notifications through Apple, so the page doesn't post its own as well. */
export const iosPushActive = () => registered !== null

async function register(s: IosPushState) {
  if (!s.token || !s.environment) return false
  const device = /iPad/.test(navigator.userAgent) ? 'DevDash app on iPad' : 'DevDash app on iPhone'
  const { configured } = await unwrap(api.api.notifications.apns.$post({ json: { token: s.token, environment: s.environment, device } }))
  registered = configured ? s.token : null
  return configured
}

let watching = false
/** At each start of the app: hand this launch's token to the server (and any new one later), unless turned off here. */
export async function syncIosPush() {
  if (!iosPushApp()) return
  const sync = async () => {
    if (backgroundOff() || (await notificationPermission(false)) !== 'granted') return
    const s = await iosPushState()
    if (s?.token && s.token !== registered) await register(s).catch(() => {})
  }
  if (!watching) {
    watching = true
    window.addEventListener('devdash-push', () => void sync())
  }
  await sync()
}

/** Turns notifications on for this iPhone (from a tap: may show the system prompt). Says what reaches it while closed. */
export async function enableIosPush(): Promise<{ state: IosPushState | null; configured: boolean }> {
  if ((await notificationPermission(true)) !== 'granted') {
    throw new Error('Notifications are off for DevDash. Turn them on in Settings → Notifications → DevDash, then come back.')
  }
  setBackgroundOff(false)
  let state: IosPushState | null = window.__devdashPushState ?? null
  if (!state?.token) {
    // Ask Apple again (offline at launch, say); the answer replaces the old one.
    window.__devdashPushState = undefined
    window.devdashShell!.registerPush!()
    state = await iosPushState(15_000)
  }
  return { state, configured: state?.token ? await register(state) : false }
}

/** Turns them off for this iPhone: the server forgets its token. */
export async function disableIosPush() {
  setBackgroundOff(true)
  const token = registered ?? window.__devdashPushState?.token
  registered = null
  if (token) await unwrap(api.api.notifications.apns.remove.$post({ json: { token } }))
}

/** Signing out: this iPhone stops getting the member's notifications. Best effort. */
export async function forgetIosPush() {
  const token = registered ?? window.__devdashPushState?.token
  registered = null
  if (token) await api.api.notifications.apns.remove.$post({ json: { token } }).catch(() => {})
}
