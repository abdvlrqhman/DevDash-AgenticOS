/** How a live notification should surface on the device in hand. */
export type Delivery = 'native' | 'toast' | 'toast-sticky' | 'none'

/**
 * Where an incoming notification goes, given where the user is. One place so the rule stays honest and testable:
 *  - looking (foreground, actively using DevDash): an in-app toast — unless they're already on the page it points to.
 *  - away, and this device gets its own pushes (Android's background service, or Apple push in the iPhone app):
 *    nothing here — that push already posts a system notification.
 *  - away, in the Tauri shell (desktop/iOS) with the native notify bridge: a native OS notification while the app is open.
 *  - away, in a browser or installed web app: a sticky toast that waits for whoever comes back (Web Push covers the away case).
 */
export function deliver(where: {
  looking: boolean
  onPage: boolean
  backgroundPush: boolean
  nativeNotify: boolean
}): Delivery {
  if (where.looking) return where.onPage ? 'none' : 'toast'
  if (where.backgroundPush) return 'none'
  if (where.nativeNotify) return 'native'
  return 'toast-sticky'
}
