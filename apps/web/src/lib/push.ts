import { api, unwrap } from './api'
import { inShell } from './shell'

/** Web Push works in browsers and installed web apps (iPhone: from the Home Screen), not inside the native app. */
export const pushSupported = () =>
  !inShell() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
/** iPhone Safari only allows push for sites added to the Home Screen. */
export const needsHomeScreen = () => isIos() && !standalone()

function deviceName() {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${browser} on ${os}`
}

const base64ToBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' })
}

/** True when this device has a live subscription the server knows about. */
export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== 'granted') return false
  const sub = await (await registration()).pushManager.getSubscription()
  if (!sub) return false
  return (await unwrap(api.api.notifications.subscriptions.check.$post({ json: { endpoint: sub.endpoint } }))).subscribed
}

/** Asks for permission (must run from a tap) and registers this device. */
export async function enablePush(publicKey: string) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.')
  const reg = await registration()
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }))
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  await unwrap(api.api.notifications.subscriptions.$post({ json: { subscription: { endpoint: json.endpoint, keys: json.keys }, device: deviceName() } }))
}

export async function disablePush() {
  const sub = await (await registration()).pushManager.getSubscription()
  if (!sub) return
  await unwrap(api.api.notifications.subscriptions.remove.$post({ json: { endpoint: sub.endpoint } }))
  await sub.unsubscribe()
}
