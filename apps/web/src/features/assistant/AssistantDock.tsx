import { lazy, Suspense, useEffect } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { sessionQuery, type Session } from '../claude/data'
import { AGENT_NAME, panelCoversPage, setAssistantOpen, toggleAssistant, useAssistantOpen, useBig } from './store'

/**
 * Hamasa, each member's personal agent: an expandable chat over the page's bottom-right corner, never part of the
 * page's layout. Closed, a round button holds its place there on a desk (the top bar on phones); the sidebar and ⌘I
 * open it too, never by itself, and Esc or its minimize button puts it away again. It can be expanded when there's more to read; on
 * phones it takes the whole screen. The launchers show when it works or waits for you, so it can stay closed. The
 * conversation itself loads only once it's opened (AssistantPanel).
 */
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })))

export const assistantQuery = queryOptions({ queryKey: ['assistant'], queryFn: () => unwrap(api.api.assistant.$get()), staleTime: 60_000 })

export function AssistantDock() {
  const open = useAssistantOpen()
  const big = useBig()
  useAssistantEvents(open)
  if (!open) return <Launcher />
  return (
    <section data-assistant role="dialog" aria-modal="false" aria-label={AGENT_NAME}
      // Esc puts it away, unless something inside used it first (a menu, the composer's suggestions).
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && e.target instanceof Element && e.target.closest('[data-assistant]')) setAssistantOpen(false) }}
      className={cn(
        'fixed inset-0 z-40 flex flex-col overflow-hidden bg-background',
        'sm:inset-auto sm:right-4 sm:bottom-4 sm:rounded-2xl sm:border sm:shadow-2xl',
        big ? 'sm:h-[min(88%,60rem)] sm:w-[min(calc(100%-2rem),52rem)]' : 'sm:h-[min(calc(100%-2rem),40rem)] sm:w-[26rem]',
      )}>
      <Suspense fallback={<div className="flex flex-col gap-3 p-3">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>}>
        <AssistantPanel />
      </Suspense>
    </section>
  )
}

/** Closed, on a desk: a round button in the corner the chat opens in, with the launchers' dot. */
function Launcher() {
  const mobile = useIsMobile()
  const status = useAssistantStatus()
  const unread = useAssistantUnread()
  if (mobile !== false) return null // phones and narrow windows have it in the top bar
  return (
    <Button size="icon" onClick={toggleAssistant} aria-label={statusTitle(status, unread)} title={`${statusTitle(status, unread)} (⌘I)`}
      className="fixed right-5 bottom-5 z-40 size-12 rounded-full shadow-lg">
      <AgentGlyph status={status} unread={unread} className="[&_svg]:size-5" />
    </Button>
  )
}

/** Whether the agent wrote in their chat since they last looked. */
export const useAssistantUnread = () => !!useQuery(assistantQuery).data?.unread

/** Their chat with the agent in sight (the panel, or its full page a notification opens): what it wrote is seen. */
export function useMarkSeen(id: string) {
  const qc = useQueryClient()
  const st = useQuery(assistantQuery).data
  const due = st?.sessionId === id && st.unread
  useEffect(() => {
    if (!due) return
    const look = () => {
      if (document.visibilityState === 'visible') void unwrap(api.api.assistant.seen.$post()).then((r) => qc.setQueryData(assistantQuery.queryKey, r), () => {})
    }
    look()
    document.addEventListener('visibilitychange', look)
    return () => document.removeEventListener('visibilitychange', look)
  }, [due, qc])
}

/** The agent showing a page (its open_page tool), the panel's data changing elsewhere, and the keyboard shortcut. */
function useAssistantEvents(open: boolean) {
  const qc = useQueryClient()
  const router = useRouter()
  useTopic('assistant', (e) => {
    if (e.type === 'changed') void qc.invalidateQueries({ queryKey: ['assistant'] })
    // Only where the person is talking to it: not in every tab they left open.
    else if (e.type === 'open' && open && document.visibilityState === 'visible' && typeof e.path === 'string' && /^\/(?!\/)/.test(e.path)) {
      router.history.push(e.path)
      if (panelCoversPage()) setAssistantOpen(false) // on a phone the panel covers the page it opened
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('.xterm')) return // Ctrl+I is Tab in a terminal
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        toggleAssistant()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Whether the agent is working or waiting for the person, for the launcher (the open panel keeps it current itself). */
export function useAssistantStatus(): Session['status'] | null {
  const id = useQuery(assistantQuery).data?.sessionId ?? null
  const open = useAssistantOpen()
  const qc = useQueryClient()
  const s = useQuery({ ...sessionQuery(id ?? ''), enabled: !!id }).data?.session
  useTopic(id && !open ? `session:${id}` : null, (e) => {
    if (e.type === 'session') qc.setQueryData(sessionQuery(id!).queryKey, (old) => (old ? { ...old, session: e.session as Session } : old))
  })
  return s?.status ?? null
}

/** The agent's mark, with a dot while it works (pulsing), waits for the person (amber) or wrote something they haven't seen (blue). */
export function AgentGlyph({ status, unread, className }: { status: Session['status'] | null; unread?: boolean; className?: string }) {
  const dot = status === 'waiting' ? 'bg-attention' : status === 'working' ? 'animate-pulse bg-emerald-500' : unread ? 'bg-sky-500' : null
  return (
    <span className={cn('relative inline-flex', className)}>
      <Bot className="size-4" />
      {dot && <span className={cn('absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background', dot)} />}
    </span>
  )
}
export const statusTitle = (status: Session['status'] | null, unread?: boolean) =>
  status === 'waiting' ? `${AGENT_NAME} needs you` : status === 'working' ? `${AGENT_NAME} is working`
    : unread ? `${AGENT_NAME} wrote to you` : `${AGENT_NAME}, your agent`

/** On phones and tablets (no sidebar): the agent in every page's top bar. */
export function AssistantHeaderButton({ className }: { className?: string }) {
  const status = useAssistantStatus()
  const unread = useAssistantUnread()
  const open = useAssistantOpen()
  return (
    <Button variant="ghost" size="icon-lg" className={cn('-mr-2', className)} aria-pressed={open} aria-label={statusTitle(status, unread)} title={statusTitle(status, unread)}
      onClick={toggleAssistant}>
      <AgentGlyph status={status} unread={unread} className="[&_svg]:size-5" />
    </Button>
  )
}
