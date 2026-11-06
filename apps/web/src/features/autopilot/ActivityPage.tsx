import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { day, KEY, LogEntry, TIER, time } from './AutopilotPage'
import { TIERS, WHO, type ActivitySearch } from './search'

const PAGE = 20
/** Everything in the autopilot log: what autopilot did, what the sessions decided, and settings. Filtered and paged. */
export function ActivityPage() {
  const f = useSearch({ from: '/app/autopilot/activity' })
  const navigate = useNavigate({ from: '/autopilot/activity' })
  const qc = useQueryClient()
  const page = f.page ?? 1
  const set = (patch: Partial<ActivitySearch>) => void navigate({ search: (old: ActivitySearch) => ({ ...old, page: undefined, ...patch }) })
  const log = useQuery({
    queryKey: [...KEY, 'log', 'all', f],
    queryFn: () => unwrap(api.api.autopilot.log.$get({ query: {
      ...(f.who ? { who: f.who } : {}), ...(f.tier ? { tier: f.tier } : {}), ...(f.project ? { project: f.project } : {}),
      ...(f.q ? { q: f.q } : {}), ...(f.order ? { order: f.order } : {}), limit: PAGE, offset: (page - 1) * PAGE,
    } })),
    placeholderData: keepPreviousData,
  })
  useTopic('autopilot', () => void qc.invalidateQueries({ queryKey: [...KEY, 'log'] }))

  // The search box waits for a pause in typing before it filters.
  const [text, setText] = useState(f.q ?? '')
  useEffect(() => setText(f.q ?? ''), [f.q])
  useEffect(() => {
    if ((f.q ?? '') === text.trim()) return
    const t = setTimeout(() => set({ q: text.trim() || undefined }), 350)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = log.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const entries = log.data?.entries ?? []
  const filtered = !!(f.who || f.tier || f.project || f.q)

  return (
    <>
      <PageHeader title="Autopilot activity" description={log.data ? `${total} entr${total === 1 ? 'y' : 'ies'}` : undefined} back="/autopilot" />
      <PageBody className="gap-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]">
          <div className="relative col-span-2 md:col-span-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search" placeholder="Search what and why" className="pl-8" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <NativeSelect aria-label="Who" value={f.who ?? ''} onChange={(e) => set({ who: (e.target.value || undefined) as ActivitySearch['who'] })}>
            <option value="">Everyone</option>
            {Object.entries(WHO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Tier" value={f.tier ?? ''} onChange={(e) => set({ tier: (e.target.value || undefined) as ActivitySearch['tier'] })}>
            <option value="">Every tier</option>
            {Object.entries(TIERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Project" value={f.project ?? ''} onChange={(e) => set({ project: e.target.value || undefined })}>
            <option value="">Every project</option>
            {(log.data?.projects ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Sort" value={f.order ?? 'new'} onChange={(e) => set({ order: e.target.value === 'old' ? 'old' : undefined })}>
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
          </NativeSelect>
        </div>
        {filtered && (
          <div><Button variant="ghost" size="sm" className="-ml-2" onClick={() => void navigate({ search: {} })}>Clear filters</Button></div>
        )}

        <ErrorAlert error={log.error} />
        {log.isSuccess && !entries.length && (
          <p className="text-sm text-muted-foreground">{filtered ? 'Nothing matches these filters.' : 'Nothing logged yet.'}</p>
        )}

        {/* Phones: the same entries as on the Autopilot page. Wider screens: a table. */}
        {!!entries.length && (
          <ul className={cn('divide-y rounded-2xl bg-surface md:hidden', log.isPlaceholderData && 'opacity-60')}>
            {entries.map((e) => <LogEntry key={e.id} e={e} withDay />)}
          </ul>
        )}
        {!!entries.length && (
          <div className={cn('hidden overflow-hidden rounded-2xl border md:block', log.isPlaceholderData && 'opacity-60')}>
            <table className="w-full table-fixed text-sm">
              <thead className="bg-surface text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-48 px-3 py-2 font-normal">When</th>
                  <th className="w-40 px-3 py-2 font-normal">Type</th>
                  <th className="w-32 px-3 py-2 font-normal">Project</th>
                  <th className="px-3 py-2 font-normal">What and why</th>
                  <th className="w-48 px-3 py-2 font-normal">Session</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => {
                  const t = TIER[e.tier] ?? TIER.system!
                  return (
                    <tr key={e.id} className="align-top">
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">{day(e.at)}, {time(e.at)}</td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-2"><span className={cn('size-2 shrink-0 rounded-full', t.dot)} />{t.label}</span>
                        {e.source === 'session' && <div className="text-xs text-muted-foreground">Your session</div>}
                      </td>
                      <td className="truncate px-3 py-2.5">{e.project ?? <span className="text-muted-foreground">·</span>}</td>
                      <td className="px-3 py-2.5">
                        <div className="break-words">{e.what}</div>
                        {e.why && <div className="mt-0.5 break-words text-muted-foreground italic">{e.why}</div>}
                      </td>
                      <td className="truncate px-3 py-2.5">
                        {e.session
                          ? <Link to="/sessions/$id" params={{ id: e.session.id }} className="underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">{e.session.title ?? 'Session'}</Link>
                          : <span className="text-muted-foreground">·</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE && (
          <nav className="flex items-center justify-between gap-3" aria-label="Pages">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => void navigate({ search: (old: ActivitySearch) => ({ ...old, page: page - 1 > 1 ? page - 1 : undefined }) })}>
              <ChevronLeft />Previous
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} of {total}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => void navigate({ search: (old: ActivitySearch) => ({ ...old, page: page + 1 }) })}>
              Next<ChevronRight />
            </Button>
          </nav>
        )}
      </PageBody>
    </>
  )
}
