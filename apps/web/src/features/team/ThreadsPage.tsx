import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { CLOSED_AS, threadsQuery, useLiveTeam, type CloseAs, type ThreadItem, type ThreadStatus } from './data'
import { OutcomeBadge } from './TeamTab'

const STATUSES: { value: ThreadStatus; label: string }[] = [
  { value: 'open', label: 'Open' }, { value: 'waiting', label: 'Waiting for people' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' },
]

/** Every thread in a project, open and closed: what roles declined is here too, to check and reopen. */
export function ThreadsPage() {
  const { slug } = useParams({ from: '/app/projects/$slug/team/threads' })
  useLiveTeam()
  const [status, setStatus] = useState<ThreadStatus>('all')
  const [outcome, setOutcome] = useState<CloseAs | ''>('')
  const [role, setRole] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])
  const list = useInfiniteQuery(threadsQuery(slug, {
    status, outcome: status === 'open' || status === 'waiting' ? undefined : outcome || undefined, role: role ? Number(role) : undefined, q: q || undefined,
  }))
  const first = list.data?.pages[0]
  const threads = list.data?.pages.flatMap((p) => p.threads) ?? []

  return (
    <>
      <PageHeader back={`/projects/${slug}`} title="Threads" description={first ? `${first.project.name} · open and closed` : 'Open and closed'} />
      <PageBody>
        <div className="flex max-w-3xl flex-col gap-4">
          <ToggleGroup type="single" variant="outline" size="sm" value={status} onValueChange={(v) => v && setStatus(v as ThreadStatus)} aria-label="Show"
            className="-mx-4 w-auto self-stretch overflow-x-auto px-4 sm:mx-0 sm:self-start sm:px-0">
            {STATUSES.map((s) => (
              <ToggleGroupItem key={s.value} value={s.value} className="shrink-0 gap-1.5 px-2.5">
                {s.label}{first && <span className="tabular-nums text-muted-foreground">{first.counts[s.value]}</span>}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 pl-8 pointer-coarse:h-10" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles" aria-label="Search titles" />
            </div>
            <NativeSelect className="w-40" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="">Every role</option>
              {first?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </NativeSelect>
            {(status === 'closed' || status === 'all') && (
              <NativeSelect className="w-44" value={outcome} onChange={(e) => setOutcome(e.target.value as CloseAs | '')} aria-label="Outcome">
                <option value="">Any outcome</option>
                {Object.entries(CLOSED_AS).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
              </NativeSelect>
            )}
          </div>

          <ErrorAlert error={list.error} />
          {!list.data ? <Skeleton className="h-64" /> : threads.length ? (
            <ul className="flex flex-col divide-y rounded-xl border">
              {threads.map((x) => <Row key={x.id} slug={slug} x={x} />)}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              {q || role || outcome || status !== 'all' ? 'No threads match.' : 'No threads yet. Roles, Claude sessions and people raise them from the Team tab.'}
            </p>
          )}
          {list.hasNextPage && (
            <Button variant="outline" className="self-center" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      </PageBody>
    </>
  )
}

function Row({ slug, x }: { slug: string; x: ThreadItem }) {
  const closed = x.status === 'resolved'
  return (
    <li>
      <Link to="/projects/$slug/team/threads/$thread" params={{ slug, thread: String(x.id) }} className="flex flex-col gap-1 px-3.5 py-2.5 text-sm hover:bg-accent/40">
        <div className="flex items-center gap-x-3">
          <StatusLight state={closed ? 'idle' : x.needsPeople ? 'waiting' : 'live'} />
          <span className={cn('min-w-0 flex-1 truncate font-medium', closed && 'text-muted-foreground')}>{x.title}</span>
          {!closed && x.priority === 'blocker' && <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">Blocker</span>}
          {closed ? <OutcomeBadge as={x.closedAs} /> : x.needsPeople && <span className="shrink-0 text-xs font-medium text-attention-foreground dark:text-attention">Needs you</span>}
        </div>
        <div className="flex flex-wrap gap-x-1.5 pl-5 text-xs text-muted-foreground">
          <span>#{x.id}</span>
          <span>· {x.owner ? x.owner.name : 'Nobody owns it'}</span>
          <span>· {x.messages} {x.messages === 1 ? 'message' : 'messages'}</span>
          <span>· {relativeTime(closed && x.resolvedAt ? x.resolvedAt : x.lastAt)}</span>
        </div>
        {closed && (x.closedBy || x.resolution) && (
          <p className="line-clamp-2 pl-5 text-xs text-muted-foreground">
            {x.closedBy && <span className="font-medium text-foreground/80">{x.closedBy}</span>}{x.closedBy && x.resolution ? ': ' : ''}{x.resolution}
          </p>
        )}
      </Link>
    </li>
  )
}
