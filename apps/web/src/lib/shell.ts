import { toast } from 'sonner'

// Bridge injected by the native app (apps/shell/src-tauri/src/lib.rs). Absent in a normal browser.
declare global {
  interface Window {
    devdashShell?: {
      switchSpace(): void
      openExternal(url: string): void
      /** The app's version, from 0.1.9 on. */
      version?: string
      /** Desktop app from 0.1.11: shows a finished download (by the number devdashDownloaded gave) in its folder. */
      showDownload?(id: number): void
      /** Native apps from 0.1.3 on. */
      notify?(title: string, body: string): void
      notificationPermission?(ask: boolean): Promise<'granted' | 'denied' | 'prompt'>
      /** The iPhone app with Apple push (lib/ios-push.ts): asks Apple for a device token again. */
      registerPush?(): void
    }
    /** The Android app from 0.1.4 on (apps/shell/android): notifications while the app is closed, from this server. */
    DevDashAndroid?: {
      enableBackgroundNotifications(origin: string): boolean
      disableBackgroundNotifications(): void
      backgroundNotifications(): boolean
      /** From 0.1.9: a file made in the page, saved to Downloads in base64 pieces (lib/download.ts). */
      saveFileStart?(name: string, mimeType: string): string
      saveFilePiece?(id: string, base64: string): boolean
      saveFileEnd?(id: string): boolean
    }
    /**
     * The app says when a download starts and ends (the iPhone app from 0.1.9, the desktop app from 0.1.11), with where
     * it went and, on desktop, a number to show it in its folder.
     */
    devdashDownloading?(name: string): void
    devdashDownloaded?(name: string, ok: boolean, where?: string, id?: number): void
  }
}

export const inShell = () => window.devdashShell !== undefined
export const inIosShell = () => inShell() && /iPhone|iPad|iPod/.test(navigator.userAgent)
/** Whether app version `v` ("0.1.11") is `want` or newer; false when the app doesn't say (before 0.1.9). */
export function atLeast(v: string | undefined, want: string) {
  if (!v) return false
  const a = v.split('.').map(Number)
  const b = want.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

/** The Android or iPhone app, where pages can't open new windows and files only reach the phone as downloads. */
export const inPhoneApp = () => inShell() && (window.DevDashAndroid !== undefined || inIosShell())

let asking: Promise<unknown> = Promise.resolve()
/**
 * The app's notification permission (asking shows the system prompt). One question at a time: each is a navigation the
 * app answers through a single callback, and a second navigation at once would cancel the first.
 */
export function notificationPermission(ask: boolean): Promise<'granted' | 'denied' | 'prompt'> {
  const bridge = window.devdashShell?.notificationPermission
  if (!bridge) return Promise.resolve('denied')
  const answer = asking.then(() => bridge(ask), () => bridge(ask))
  asking = answer.catch(() => {})
  return answer
}

const BG_OFF = 'devdash.background-notifications-off'
/** Notifications while the app is closed were turned off on this device (Android and iPhone apps). */
export function backgroundOff() {
  try { return localStorage.getItem(BG_OFF) !== null } catch { return false } // storage blocked: treat as on
}
export function setBackgroundOff(off: boolean) {
  try { if (off) localStorage.setItem(BG_OFF, '1'); else localStorage.removeItem(BG_OFF) } catch { /* not remembered */ }
}

/** Android app: keep the background connection on whenever notifications are allowed, unless turned off here. */
export async function syncBackgroundNotifications() {
  const android = window.DevDashAndroid
  if (!android || android.backgroundNotifications() || backgroundOff()) return
  if ((await notificationPermission(false)) === 'granted') android.enableBackgroundNotifications(location.origin)
}
export function setBackgroundNotifications(on: boolean) {
  const android = window.DevDashAndroid
  if (!android) return
  setBackgroundOff(!on)
  if (on) android.enableBackgroundNotifications(location.origin)
  else android.disableBackgroundNotifications()
}

/** Opens a link outside DevDash: the system browser in the app, a new tab in a browser. */
export function openExternal(url: string) {
  if (window.devdashShell) window.devdashShell.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * In the app: a link meant for a new tab goes to the system browser (the phone apps' WebViews drop new windows), and
 * the iPhone app's downloads say where they went.
 */
export function handleAppLinksAndDownloads() {
  // Apps before 0.1.9 froze opening links on phones; there such links keep doing nothing until the app is updated.
  if (window.devdashShell?.version) document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || !(e.target instanceof Element)) return
    const a = e.target.closest<HTMLAnchorElement>('a[target=_blank][href]')
    if (!a || a.hasAttribute('download')) return
    const url = new URL(a.href, location.href)
    // This space's own pages and files need its sign-in, which the system browser doesn't have: those stay as they are.
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin === location.origin) return
    e.preventDefault()
    openExternal(url.href)
  })
  // Desktop apps before 0.1.11 save downloads to the Downloads folder without a word: say so when one starts.
  if (!inPhoneApp() && !atLeast(window.devdashShell?.version, '0.1.11')) document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[download][href]') : null
    if (a) toast(`Downloading ${a.download || 'the file'}`, { description: 'It goes to your Downloads folder.' })
  })
  window.devdashDownloading = (name) => { toast.loading(`Downloading ${name}…`, { id: `download:${name}` }) }
  window.devdashDownloaded = (name, ok, where, id) => {
    const show = window.devdashShell?.showDownload
    if (!ok) return void toast.error(`Couldn't download ${name}`, { id: `download:${name}` })
    toast.success(`Downloaded ${name}`, {
      id: `download:${name}`,
      description: where ?? (inIosShell() ? 'In the Files app: On My iPhone › DevDash' : undefined),
      action: id !== undefined && show ? { label: 'Show in folder', onClick: () => show(id) } : undefined,
    })
  }
}

/** The app's downloads page, served by this space (the releases themselves are in a private repository). */
export const APP_DOWNLOADS = `${location.origin}/api/app`
