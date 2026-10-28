// DevDash service worker: Web Push only (no offline caching). Every push shows a notification, as iOS requires.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'DevDash', body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'DevDash', {
    body: d.body || '',
    tag: d.tag,
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' },
  }))
})

// Tapping a notification focuses an open DevDash window on that page, or opens one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => w.url.startsWith(self.location.origin))
    if (win) {
      await win.focus()
      if ('navigate' in win) await win.navigate(url).catch(() => {})
      return
    }
    await self.clients.openWindow(url)
  })())
})
