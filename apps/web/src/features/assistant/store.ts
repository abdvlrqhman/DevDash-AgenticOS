import { useSyncExternalStore } from 'react'

/** What everyone's personal agent is called (the server's AGENT_NAME). */
export const AGENT_NAME = 'Hamasa'

// Whether Hamasa's chat is open, and whether it's expanded (bigger, remembered on this device). It never opens by
// itself: only when the person asks (the sidebar, the top bar on phones, ⌘I).
const BIG = 'devdash.assistant-big'
let open = false
let big = (() => {
  try { return localStorage.getItem(BIG) === 'true' } catch { return false }
})()
let session: string | null = null
const listeners = new Set<() => void>()
const changed = () => { for (const l of listeners) l() }
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

export function setAssistantOpen(v: boolean) {
  if (v === open) return
  open = v
  changed()
}
export const toggleAssistant = () => setAssistantOpen(!open)
export const useAssistantOpen = () => useSyncExternalStore(subscribe, () => open)

export function toggleBig() {
  big = !big
  try { localStorage.setItem(BIG, String(big)) } catch { /* not remembered */ }
  changed()
}
export const useBig = () => useSyncExternalStore(subscribe, () => big)

/** On phones the chat covers the whole page: what it opens there has to close it to be seen. */
export const panelCoversPage = () => !window.matchMedia('(min-width: 640px)').matches

/** The conversation the open chat shows, so a notification about it isn't shown on top of it. */
export const showingSession = (id: string | null) => void (session = id)
export const assistantShows = (url: string) => open && !!session && url === `/sessions/${session}`

/**
 * What the agent is told about the page the person is on, before each message: its path and its heading. Attribute
 * values are escaped, so a page title can't close the tag. Pure, tested.
 */
export function pageTag(path: string, title: string) {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim()
  return `<devdash-page path="${esc(path)}" title="${esc(title).slice(0, 160)}"/>`
}
