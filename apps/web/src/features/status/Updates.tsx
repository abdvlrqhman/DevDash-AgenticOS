import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpCircle, ChevronRight, CircleAlert, GitCommitHorizontal, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { confirmAction } from '@/components/app/confirm'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { relativeTime } from '../claude/data'

const short = (sha: string) => sha.slice(0, 7)
const firstLine = (s: string) => s.split('\n')[0]

/**
 * Updating DevDash itself: what's live, what's new on GitHub, and requests from people and their Claude sessions.
 * Admins deploy with one tap; the server builds, switches, restarts and checks itself, rolling back if it's unhealthy.
 */
export function Updates() {
  const qc = useQueryClient()
  const [showAll, setShowAll] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const q = useQuery({
    queryKey: ['status', 'deploy'],
    queryFn: () => unwrap(api.api.status.deploy.$get({ query: {} })),
    // While a deploy runs the server restarts: keep what we had and look again soon.
    refetchInterval: (query) => (query.state.data?.running ? 4000 : 60_000),
    placeholderData: (prev) => prev,
    retry: 8,
  })
  const refresh = useMutation({
    mutationFn: () => unwrap(api.api.status.deploy.$get({ query: { refresh: '1' } })),
    onSuccess: (d) => qc.setQueryData(['status', 'deploy'], d),
    onError: (e) => toast.error(e.message),
  })
  const done = () => void qc.invalidateQueries({ queryKey: ['status'] })
  const deploy = useMutation({
    mutationFn: (o: { sha?: string; requestId?: number }) => unwrap(api.api.status.deploy.$post({ json: o })),
    onSuccess: (d) => { toast.success(`Deploying ${short(d.sha)}. DevDash restarts for a few seconds near the end; Claude sessions keep running.`); done() },
    onError: (e) => toast.error(e.message),
  })
  const decline = useMutation({
    mutationFn: (id: number) => unwrap(api.api.status.deploy.requests[':id'].decline.$post({ param: { id: String(id) } })),
    onSuccess: done,
    onError: (e) => toast.error(e.message),
  })
  const ask = useMutation({
    mutationFn: () => unwrap(api.api.status.deploy.requests.$post({ json: {} })),
    onSuccess: (r) => { toast.success(r.existing ? 'Already waiting for an admin.' : 'Asked the admins.'); done() },
    onError: (e) => toast.error(e.message),
  })
  const d = q.data
  if (!d) return q.isLoading ? null : <Card><p className="text-sm text-muted-foreground">Couldn't load updates right now. This page tries again in a minute.</p></Card>

  const busy = !!d.running || deploy.isPending
  const go = (o: { sha?: string; requestId?: number }, sha: string) => {
    void confirmAction({
      title: `Deploy ${short(sha)}?`, action: 'Deploy',
      description: "DevDash builds it (a few minutes), then restarts for a few seconds. If the new version isn't healthy, it goes back on its own.",
    }).then((ok) => { if (ok) deploy.mutate(o) })
  }
  const ahead = d.ahead ?? []
  const shown = showAll ? ahead : ahead.slice(0, 5)
  return (
    <Card action={
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Check GitHub again" title="Check GitHub again" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? <Spinner /> : <RefreshCw />}
        </Button>
        {d.canAct && d.newest && ahead.length > 0 && !d.requests.length && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => go({ sha: d.newest!.sha }, d.newest!.sha)}><ArrowUpCircle />Deploy newest</Button>
        )}
        {!d.canAct && ahead.length > 0 && !d.requests.length && !d.running && (
          <Button size="sm" variant="outline" disabled={ask.isPending} onClick={() => ask.mutate()}>Ask to deploy</Button>
        )}
      </div>
    }>
      <p className="-mt-1 text-sm text-muted-foreground">
        {d.live ? <>Live: <span className="font-mono text-[13px] text-foreground">{d.live.id.slice(0, 7)}</span>, deployed {relativeTime(d.live.since)}.</> : 'The live version is unknown.'}
      </p>

      {d.running && (
        <div className="flex items-start gap-3 rounded-2xl bg-attention-soft px-4 py-3.5 text-sm">
          <Spinner className="mt-0.5 shrink-0 text-attention-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Deploying <span className="font-mono text-[13px]">{short(d.running.sha)}</span></div>
            <div className="text-pretty text-attention-foreground">Started by {d.running.decidedBy ?? 'an admin'}{d.running.startedAt ? ` ${relativeTime(d.running.startedAt)}` : ''}. It builds, restarts and checks itself; this page catches up on its own.</div>
          </div>
        </div>
      )}

      {/* A request waits on an admin: the one thing in this section that asks for someone. */}
      {d.requests.map((r) => (
        <div key={r.id} className="flex flex-col gap-3 rounded-2xl bg-attention-soft px-4 py-3.5 text-sm">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-attention-foreground" />
            <div className="min-w-0 flex-1">
              <div><span className="font-medium">{r.by ?? 'Someone'}{r.session ? '’s Claude' : ''}</span> asks to deploy <span className="font-mono text-[13px]">{short(r.sha)}</span></div>
              {r.note && <p className="mt-1 break-words whitespace-pre-wrap text-pretty">{r.note}</p>}
              <div className="mt-1 text-xs text-attention-foreground">
                {relativeTime(r.createdAt)}
                {r.session && <>, from <Link to="/claude/$id" params={{ id: r.session.id }} className="underline decoration-attention-foreground/40 underline-offset-4 hover:decoration-current">{r.session.title}</Link></>}
              </div>
            </div>
          </div>
          {d.canAct && (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" className="hover:bg-attention/15 dark:hover:bg-attention/15" disabled={decline.isPending} onClick={() => decline.mutate(r.id)}>Decline</Button>
              <Button size="sm" disabled={busy} onClick={() => go({ requestId: r.id }, r.sha)}>{deploy.isPending && deploy.variables?.requestId === r.id ? <Spinner /> : <ArrowUpCircle />}Deploy</Button>
            </div>
          )}
        </div>
      ))}

      {d.ahead === null ? (
        d.newest && <p className="text-sm text-pretty text-muted-foreground">The live version isn't among the newest commits on main (deployed from a computer, or long ago). Newest: <span className="font-mono text-[13px]">{short(d.newest.sha)}</span> {firstLine(d.newest.message)}</p>
      ) : ahead.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><StatusLight state="live" />Up to date with main</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-sm text-muted-foreground"><span className="tabular-nums">{ahead.length}</span> new commit{ahead.length === 1 ? '' : 's'} on main</div>
          <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
            {shown.map((c) => (
              <li key={c.sha}>
                <a href={c.url} target="_blank" rel="noreferrer"
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="break-words">{firstLine(c.message)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      <span className="font-mono">{short(c.sha)}</span>, {c.author.split(' ')[0]}{c.at ? `, ${relativeTime(c.at)}` : ''}
                    </span>
                  </span>
                </a>
              </li>
            ))}
            {ahead.length > shown.length && (
              <li>
                <button type="button" className="w-full rounded-xl px-3 py-2 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground" onClick={() => setShowAll(true)}>
                  Show {ahead.length - shown.length} more
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      {d.last && !d.running && (
        <div className="text-sm">
          <button type="button" disabled={d.last.status !== 'failed' || !d.last.log} onClick={() => setShowLog((v) => !v)}
            className={cn('-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 enabled:hover:bg-surface', d.last.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {d.last.status === 'failed' ? <CircleAlert className="size-4 shrink-0" /> : <StatusLight state="live" />}
            <span className="min-w-0 flex-1 text-pretty">
              Last deploy, <span className="font-mono text-[13px]">{short(d.last.sha)}</span>, {d.last.status === 'failed' ? 'failed' : 'went live'} {d.last.finishedAt ? relativeTime(d.last.finishedAt) : ''}
              {d.last.status === 'failed' && ': the previous version kept running'}
            </span>
            {d.last.status === 'failed' && d.last.log && <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-300 ease-spring', showLog && 'rotate-90')} />}
          </button>
          {showLog && d.last.log && <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-term-bg px-3 py-2.5 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-term-fg [overflow-wrap:anywhere]">{d.last.log}</pre>}
        </div>
      )}

      {d.error && <p className="text-xs text-pretty text-muted-foreground">{d.error}</p>}
      {d.tokenExpires && d.tokenExpires * 1000 - Date.now() < 30 * 86_400_000 && (
        <p className="rounded-xl bg-attention-soft px-3 py-2.5 text-xs text-pretty text-attention-foreground">
          DevDash's GitHub token (DEVDASH_GITHUB_TOKEN) expires on {new Date(d.tokenExpires * 1000).toLocaleDateString()}. Make a new one before then, or updates stop.
        </p>
      )}
      {!d.canAct && d.requests.length === 0 && ahead.length > 0 && <p className="text-xs text-pretty text-muted-foreground">Admins deploy. Your Claude session can ask too, from DevDash's own project.</p>}
    </Card>
  )
}

function Card({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 lg:col-span-2">
      <div className="flex min-h-8 items-center justify-between gap-2"><h2 className="text-base font-semibold tracking-[-0.01em]">DevDash updates</h2>{action}</div>
      {children}
    </section>
  )
}
