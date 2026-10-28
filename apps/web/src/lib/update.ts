import { useEffect } from 'react'
import { toast } from 'sonner'
import { live } from './live'

// The entry script Vite names after its content: a deploy with any change to the app gives it a new name.
const ENTRY = /src="(\/assets\/index-[^"]+\.js)"/
const loaded = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? null

let lastCheck = 0
let told = false
async function check() {
  const mine = loaded()
  // The dev server has no built entry; once told, there's nothing more to say.
  if (!mine || told || Date.now() - lastCheck < 60_000) return
  lastCheck = Date.now()
  const html = await fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''), () => '')
  const served = html.match(ENTRY)?.[1]
  if (!served || served === mine) return
  told = true
  toast('DevDash was updated', {
    id: 'devdash-update', duration: Infinity,
    description: 'This tab still runs the old version. Reload to get the new one.',
    action: { label: 'Reload', onClick: () => location.reload() },
  })
}

/**
 * A tab can stay open for days, running the version it loaded. After a deploy (the server restarts, so the live
 * connection comes back), when the tab comes back into view, and every half hour, it looks whether DevDash serves a
 * newer app and offers to reload. Not automatically: a half-written message would be lost.
 */
export function useUpdateCheck() {
  useEffect(() => {
    const offReconnect = live.whenReconnected(() => void check())
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(() => void check(), 30 * 60_000)
    return () => {
      offReconnect()
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])
}
