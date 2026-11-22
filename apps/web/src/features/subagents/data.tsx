import { useEffect, useRef } from 'react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { InferResponseType } from 'hono/client'
import {
  BookOpen, Bot, Brain, Bug, CheckCircle2, Code2, Compass, FileSearch,
  Globe, Loader2, Search, Shield, Sparkles, Square, Terminal, Wrench, XCircle, Zap, AlertCircle,
} from 'lucide-react'
import { SidebarMenuBadge } from '@/components/ui/sidebar'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { panelCoversPage, setAssistantOpen } from '../assistant/store'

export type SubagentsOverview = InferResponseType<typeof api.api.subagents.$get>
export type CustomSubagent = SubagentsOverview['subagents'][number]
export type SubagentRun = SubagentsOverview['recentRuns'][number]
export type SubagentTemplate = SubagentsOverview['templates'][number]
export type SubagentRunStatus = SubagentRun['status']
export type SubagentIcon = CustomSubagent['icon']
export type SubagentColor = CustomSubagent['color']
export type SubagentScope = CustomSubagent['scope']

export const subagentsOverviewQuery = queryOptions({
  queryKey: ['subagents', 'overview'],
  queryFn: () => unwrap(api.api.subagents.$get()),
  staleTime: 10_000,
})

export const subagentRunsQuery = (opts?: { subagentId?: number; status?: SubagentRunStatus; limit?: number }) => queryOptions({
  queryKey: ['subagents', 'runs', opts?.subagentId ?? null, opts?.status ?? null, opts?.limit ?? 80],
  queryFn: () => unwrap(api.api.subagents.runs.$get({
    query: {
      ...(opts?.subagentId ? { subagentId: String(opts.subagentId) } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
      ...(opts?.limit ? { limit: String(opts.limit) } : {}),
    },
  })),
  staleTime: 5_000,
})

export const subagentRunQuery = (runId: number) => queryOptions({
  queryKey: ['subagents', 'run', runId],
  queryFn: () => unwrap(api.api.subagents.runs[':runId'].$get({ param: { runId: String(runId) } })),
  staleTime: 2_000,
})

/** Keeps subagents + run activity in sync over the shared /api/live WebSocket. */
export function useLiveSubagents() {
  const qc = useQueryClient()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRunIds = useRef<Set<number>>(new Set())

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  useTopic('subagents', (e) => {
    if (typeof e.runId === 'number') pendingRunIds.current.add(e.runId)
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const ids = [...pendingRunIds.current]
      pendingRunIds.current.clear()
      void qc.invalidateQueries({ queryKey: ['subagents', 'overview'] })
      void qc.invalidateQueries({ queryKey: ['subagents', 'runs'] })
      for (const id of ids) void qc.invalidateQueries({ queryKey: ['subagents', 'run', id] })
    }, 150)
  })
}

export const ICON_LIST: { value: SubagentIcon; label: string }[] = [
  { value: 'bot', label: 'Agent' },
  { value: 'globe', label: 'Web' },
  { value: 'search', label: 'Search' },
  { value: 'file-search', label: 'Code search' },
  { value: 'code', label: 'Code' },
  { value: 'brain', label: 'Research' },
  { value: 'sparkles', label: 'Sparkles' },
  { value: 'bug', label: 'Debug' },
  { value: 'shield', label: 'Review' },
  { value: 'book', label: 'Docs' },
  { value: 'compass', label: 'Explore' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'wrench', label: 'Tools' },
  { value: 'zap', label: 'Fast' },
]

const ICONS: Record<SubagentIcon, typeof Bot> = {
  bot: Bot,
  search: Search,
  globe: Globe,
  code: Code2,
  'file-search': FileSearch,
  sparkles: Sparkles,
  bug: Bug,
  shield: Shield,
  book: BookOpen,
  compass: Compass,
  terminal: Terminal,
  wrench: Wrench,
  brain: Brain,
  zap: Zap,
}

export function SubagentIconGlyph({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon as SubagentIcon] ?? Bot
  return <Icon className={className} />
}

export const COLOR_STYLES: Record<SubagentColor, { badge: string; dot: string; ring: string; label: string }> = {
  blue: {
    label: 'Blue',
    badge: 'bg-blue-500/12 text-blue-600 dark:text-blue-400 border-blue-500/20',
    dot: 'bg-blue-500',
    ring: 'ring-blue-500/40',
  },
  emerald: {
    label: 'Emerald',
    badge: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/40',
  },
  violet: {
    label: 'Violet',
    badge: 'bg-violet-500/12 text-violet-600 dark:text-violet-400 border-violet-500/20',
    dot: 'bg-violet-500',
    ring: 'ring-violet-500/40',
  },
  amber: {
    label: 'Amber',
    badge: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/20',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/40',
  },
  rose: {
    label: 'Rose',
    badge: 'bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/20',
    dot: 'bg-rose-500',
    ring: 'ring-rose-500/40',
  },
  cyan: {
    label: 'Cyan',
    badge: 'bg-cyan-500/12 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    dot: 'bg-cyan-500',
    ring: 'ring-cyan-500/40',
  },
  orange: {
    label: 'Orange',
    badge: 'bg-orange-500/12 text-orange-600 dark:text-orange-400 border-orange-500/20',
    dot: 'bg-orange-500',
    ring: 'ring-orange-500/40',
  },
  slate: {
    label: 'Slate',
    badge: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground',
    ring: 'ring-muted-foreground/40',
  },
}

export const COLOR_LIST = Object.keys(COLOR_STYLES) as SubagentColor[]

export const SCOPE_LABELS: Record<SubagentScope, string> = {
  both: 'Hamasa & sessions',
  hamasa: 'Hamasa only',
  sessions: 'Sessions only',
}

export const CALLER_LABELS: Record<string, string> = {
  hamasa: 'Hamasa',
  session: 'Session',
  manual: 'Manual',
}

export function statusMeta(status: SubagentRunStatus) {
  switch (status) {
    case 'running':
      return { label: 'Running', icon: Loader2, spin: true, badge: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/25', dot: 'bg-emerald-500 animate-pulse' }
    case 'waiting':
      return { label: 'Needs input', icon: AlertCircle, spin: false, badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30', dot: 'bg-amber-500 animate-pulse' }
    case 'completed':
      return { label: 'Done', icon: CheckCircle2, spin: false, badge: 'bg-muted text-foreground border-border', dot: 'bg-emerald-500' }
    case 'failed':
      return { label: 'Failed', icon: XCircle, spin: false, badge: 'bg-destructive/12 text-destructive border-destructive/25', dot: 'bg-destructive' }
    case 'stopped':
      return { label: 'Stopped', icon: Square, spin: false, badge: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground' }
  }
}

export function formatDuration(startedAt: number, finishedAt: number | null) {
  const end = finishedAt ?? Math.floor(Date.now() / 1000)
  const sec = Math.max(0, Math.round(end - startedAt))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem ? `${min}m ${rem}s` : `${min}m`
}

export function useStopSubagentRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: number) => unwrap(api.api.subagents.runs[':runId'].stop.$post({ param: { runId: String(runId) } })),
    onSuccess: (_data, runId) => {
      void qc.invalidateQueries({ queryKey: ['subagents'] })
      void qc.invalidateQueries({ queryKey: ['subagents', 'run', runId] })
    },
    onError: (e) => toast.error(e.message),
  })
}

/** Live badge on the Subagents nav item showing how many subagents are actively running/waiting. */
export function SubagentsBadge() {
  useLiveSubagents()
  const active = useQuery(subagentsOverviewQuery).data?.activeRuns ?? []
  if (!active.length) return null
  const waiting = active.some((r) => r.status === 'waiting')
  return (
    <SidebarMenuBadge className={cn(
      'gap-1 tabular-nums',
      waiting ? 'bg-attention-soft text-attention-foreground' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    )}>
      <span className={cn('size-1.5 rounded-full animate-pulse', waiting ? 'bg-amber-500' : 'bg-emerald-500')} />
      {active.length}
    </SidebarMenuBadge>
  )
}

/**
 * Compact live indicator showing running subagents and exactly what they're doing right now.
 * Shown in Hamasa's panel ("panel") and in the sidebar ("sidebar") whenever >= 1 subagent is active.
 */
export function ActiveSubagentsStrip({ variant = 'panel' }: { variant?: 'panel' | 'sidebar' }) {
  useLiveSubagents()
  const active = useQuery(subagentsOverviewQuery).data?.activeRuns ?? []
  const stop = useStopSubagentRun()
  if (!active.length) return null

  if (variant === 'sidebar') {
    return (
      <div className="mx-2 mb-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-2 group-data-[collapsible=icon]:hidden">
        <div className="mb-1 flex items-center justify-between gap-1 px-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {active.length === 1 ? 'Subagent working' : `${active.length} subagents working`}
          </span>
          <Link to="/subagents" search={{ tab: 'history' }} className="text-[10px] text-muted-foreground hover:text-foreground hover:underline">
            All
          </Link>
        </div>
        <ul className="flex flex-col gap-1">
          {active.slice(0, 3).map((r) => {
            const color = COLOR_STYLES[r.subagentColor as SubagentColor] ?? COLOR_STYLES.blue
            return (
              <li key={r.id}>
                <Link
                  to="/subagents"
                  search={{ run: r.id }}
                  className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-background/70"
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border', color.badge)}>
                    <SubagentIconGlyph icon={r.subagentIcon} className="size-2.5" />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate font-medium text-foreground">{r.subagentName}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{r.activity || 'Working…'}</span>
                  </span>
                  {r.status === 'waiting'
                    ? <AlertCircle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                    : <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-emerald-500" />}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 flex-col border-b bg-emerald-500/[0.05] px-3 py-1.5" aria-label="Running custom subagents">
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Subagents active ({active.length})
        </span>
        <Link
          to="/subagents"
          search={{ tab: 'history' }}
          onClick={() => { if (panelCoversPage()) setAssistantOpen(false) }}
          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          Open tab
        </Link>
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {active.map((r) => {
          const color = COLOR_STYLES[r.subagentColor as SubagentColor] ?? COLOR_STYLES.blue
          return (
            <li key={r.id} className="flex items-center gap-2 rounded-lg bg-background/60 px-2 py-1 text-xs">
              <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-md border', color.badge)}>
                <SubagentIconGlyph icon={r.subagentIcon} className="size-3" />
              </span>
              <Link
                to="/subagents"
                search={{ run: r.id }}
                onClick={() => { if (panelCoversPage()) setAssistantOpen(false) }}
                className="min-w-0 flex-1 leading-tight hover:underline"
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">{r.subagentName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{CALLER_LABELS[r.callerKind] ?? r.callerKind}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{r.activity || r.task}</span>
              </Link>
              {r.status === 'waiting'
                ? <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">Waiting</span>
                : <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" />}
              <button
                type="button"
                aria-label={`Stop ${r.subagentName}`}
                title="Stop subagent"
                disabled={stop.isPending}
                onClick={() => stop.mutate(r.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Square className="size-3" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export type SubagentsSearch = {
  tab?: 'agents' | 'history'
  run?: number
  subagent?: number
}

export function validateSubagentsSearch(s: Record<string, unknown>): SubagentsSearch {
  const out: SubagentsSearch = {}
  if (s.tab === 'agents' || s.tab === 'history') out.tab = s.tab
  const run = Number(s.run)
  if (Number.isInteger(run) && run > 0) out.run = run
  const subagent = Number(s.subagent)
  if (Number.isInteger(subagent) && subagent > 0) out.subagent = subagent
  return out
}
