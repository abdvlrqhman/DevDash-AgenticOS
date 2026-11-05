import { lazy, Suspense, useEffect } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { cn } from '@/lib/utils'
import { sessionQuery, type Session } from '../claude/data'
import { AGENT_NAME, panelCoversPage, setAssistantOpen, toggleAssistant, useAssistantOpen, useBig } from './store'

/**
 * Hamasa, each member's personal agent: an expandable chat over the page's bottom-right corner, never part of the
 * page's layout. Closed, nothing of it covers the page: it opens from the sidebar (the top bar on phones) or ⌘I, never
 * by itself, and Esc or its minimize button puts it away again. It can be expanded when there's more to read; on
 * phones it takes the whole screen. The launchers show when it works or waits for you, so it can stay closed. The
 * conversation itself loads only once it's opened (AssistantPanel).
 */
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })))

export const assistantQuery = queryOptions({ queryKey: ['assistant'], queryFn: () => unwrap(api.api.assistant.$get()), staleTime: 60_000 })

export function AssistantDock() {
  const open = useAssistantOpen()
  const big = useBig()
  useAssistantEvents(open)
  if (!open) return null
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

/** The agent's mark, with a dot while it works (pulsing) or waits for the person (amber). */
export function AgentGlyph({ status, className }: { status: Session['status'] | null; className?: string }) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <Bot className="size-4" />
      {(status === 'working' || status === 'waiting') && (
        <span className={cn('absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background', status === 'waiting' ? 'bg-attention' : 'animate-pulse bg-emerald-500')} />
      )}
    </span>
  )
}
export const statusTitle = (status: Session['status'] | null) =>
  status === 'waiting' ? `${AGENT_NAME} needs you` : status === 'working' ? `${AGENT_NAME} is working` : `${AGENT_NAME}, your agent`

/** On phones and tablets (no sidebar): the agent in every page's top bar. */
export function AssistantHeaderButton({ className }: { className?: string }) {
  const status = useAssistantStatus()
  const open = useAssistantOpen()
  return (
    <Button variant="ghost" size="icon-lg" className={cn('-mr-2', className)} aria-pressed={open} aria-label={statusTitle(status)} title={statusTitle(status)}
      onClick={toggleAssistant}>
      <AgentGlyph status={status} className="[&_svg]:size-5" />
    </Button>
  )
}
