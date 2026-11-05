import { useEffect } from 'react'

/** Sets the browser tab to "DevDash — <name>" while mounted (e.g. the session name), back to "DevDash" after. */
export function usePageTitle(name: string | null | undefined, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    document.title = name?.trim() ? `DevDash — ${name.trim()}` : 'DevDash'
    return () => { document.title = 'DevDash' }
  }, [name, enabled])
}
