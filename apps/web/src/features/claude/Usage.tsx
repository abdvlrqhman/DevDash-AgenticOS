import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'

type Limit = { kind: string; percent: number | null; severity?: string; resets_at: string | null; is_active?: boolean; scope?: { model?: { display_name?: string | null } | null } | null }
type Window = { utilization: number | null; resets_at: string | null } | null

export const usageQuery = (profile: string) => ({
  queryKey: ['claude', 'usage', profile],
  queryFn: () => unwrap(api.api.claude.usage[':profile'].$get({ param: { profile } })),
  staleTime: 60_000,
  refetchInterval: 120_000,
})

export const sessionUsageQuery = (id: string) => ({
  queryKey: ['claude', 'session-usage', id],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].usage.$get({ param: { id } })),
  staleTime: 15_000,
  refetchInterval: 30_000,
})

// Same formatters as the per-answer line (Blocks.tsx) so numbers read the same everywhere.
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const money = (n: number) => (n < 0.0005 ? '$0' : n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`)

/** This session's own running total: cost, tokens in/out and how many answers, above the plan limits. */
function SessionUsage({ id }: { id: string }) {
  const q = useQuery(sessionUsageQuery(id))
  if (q.isPending) return <Skeleton className="h-10" />
  if (q.error) return <ErrorAlert error={q.error} />
  const u = q.data.usage
  // "in" is everything read, like the per-answer line: new tokens plus the cache it reads and writes.
  const read = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">This session</span>
        {u.turns > 0 && <span className="tabular-nums">{money(u.cost)}</span>}
      </div>
      {u.turns > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-muted-foreground">
          <span>{kTokens(read)} in</span><span aria-hidden>·</span><span>{kTokens(u.outputTokens)} out</span>
          <span aria-hidden>·</span><span>{u.turns} turn{u.turns === 1 ? '' : 's'}</span>
        </p>
      ) : <p className="text-xs text-muted-foreground">No answers yet.</p>}
    </div>
  )
}

function label(l: Limit) {
  if (l.kind === 'session') return '5-hour limit'
  if (l.kind === 'weekly_all') return 'Weekly, all models'
  if (l.kind === 'weekly_scoped') return `Weekly, ${l.scope?.model?.display_name ?? 'one model'}`
  return l.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function resets(iso: string | null) {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Resets now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h < 24) return `Resets in ${h ? `${h} h ` : ''}${m} min`
  return `Resets ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

/**
 * This session's own usage (when a session is in view) above the Claude plan limits behind its profile — the
 * limits being the same as /usage in Claude Code. Used on the session page; the session block is only shown
 * where there is a session to show it for.
 */
export function PlanUsage({ profile, sessionId, className }: { profile: string; sessionId?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {sessionId && <SessionUsage id={sessionId} />}
      <div className="flex flex-col gap-3">
        {sessionId && <h3 className="text-xs font-medium text-muted-foreground">Plan limits</h3>}
        <PlanLimits profile={profile} />
      </div>
    </div>
  )
}

function PlanLimits({ profile }: { profile: string }) {
  const q = useQuery(usageQuery(profile))
  if (q.isPending) return <div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
  if (q.error) return <ErrorAlert error={q.error} />
  const u = q.data.usage
  if (!u.available || !u.limits) return <p className="text-muted-foreground">This profile has no plan limits to show (API key or another provider).</p>

  const raw = u.limits as Record<string, unknown>
  let limits = (Array.isArray(raw.limits) ? raw.limits : []) as Limit[]
  if (!limits.length) {
    // Older shape: named windows only.
    const w = (k: string) => raw[k] as Window
    limits = [['session', w('five_hour')], ['weekly_all', w('seven_day')]]
      .filter(([, v]) => v)
      .map(([kind, v]) => ({ kind: kind as string, percent: (v as Window)!.utilization, resets_at: (v as Window)!.resets_at }))
  }
  return (
    <div className="flex flex-col gap-3">
      {limits.map((l, i) => {
        const pct = Math.max(0, Math.min(100, l.percent ?? 0))
        const tone = l.severity === 'critical' || pct >= 90 ? 'bg-destructive' : l.severity === 'warning' || pct >= 75 ? 'bg-attention' : 'bg-foreground/80'
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span>{label(l)}</span>
              <span className="tabular-nums text-muted-foreground">{l.percent === null ? '—' : `${Math.round(pct)}%`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label(l)} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
            </div>
            {l.resets_at && <span className="text-xs text-muted-foreground">{resets(l.resets_at)}</span>}
          </div>
        )
      })}
      {u.plan && <p className="text-xs text-muted-foreground">Claude {u.plan.charAt(0).toUpperCase() + u.plan.slice(1)} plan, {profile === 'default' ? 'default profile' : `profile ${profile}`}. Shared by everything that uses this Claude account.</p>}
    </div>
  )
}
