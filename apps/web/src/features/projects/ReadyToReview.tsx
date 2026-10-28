import { useState } from 'react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BadgeCheck, ExternalLink, Eye, GitBranch, GitMerge, GitPullRequest, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { confirmAction } from '@/components/app/confirm'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'

const fetchDeliveries = (slug: string) => unwrap(api.api.projects[':slug'].deliveries.$get({ param: { slug } }))
export const deliveriesQuery = (slug: string) => queryOptions({ queryKey: ['deliveries', slug], queryFn: () => fetchDeliveries(slug) })
type Delivery = Awaited<ReturnType<typeof fetchDeliveries>>['deliveries'][number]

/** Keeps the deliveries fresh: they change on the same "projects" topic a finished session already fans out on. */
export function useLiveDeliveries(slug: string) {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['deliveries', slug] })
  useTopic('projects', refresh, refresh)
}

/** "Ready to review": a role's approved code work, finished on its branch, shipped in one tap. Shown only when there's some. */
export function ReadyToReview({ slug, isGithub, className }: { slug: string; isGithub: boolean; className?: string }) {
  useLiveDeliveries(slug)
  const q = useQuery(deliveriesQuery(slug))
  const deliveries = q.data?.deliveries ?? []
  if (!deliveries.length) return null
  const ready = deliveries.filter((d) => d.status === 'ready').length
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4', className)}>
      <div className="flex min-h-8 items-center gap-2">
        <BadgeCheck className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Ready to review</h2>
        {ready > 0 && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">{ready}</span>}
      </div>
      <ul className="flex flex-col gap-2">
        {deliveries.map((d) => <DeliveryItem key={d.id} slug={slug} d={d} isGithub={isGithub} />)}
      </ul>
    </section>
  )
}

function DeliveryItem({ slug, d, isGithub }: { slug: string; d: Delivery; isGithub: boolean }) {
  const qc = useQueryClient()
  const [viewing, setViewing] = useState(false)
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['deliveries', slug] })
  const pr = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].deliveries[':id'].pr.$post({ param: { slug, id: String(d.id) } })),
    onSuccess: (r) => { invalidate(); if (r.delivery.prUrl) window.open(r.delivery.prUrl, '_blank', 'noopener') },
    onError: (e) => toast.error(e.message),
  })
  const merge = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].deliveries[':id'].merge.$post({ param: { slug, id: String(d.id) } })),
    onSuccess: () => { invalidate(); toast.success(`Merged into ${d.baseBranch}.`) },
    onError: (e) => toast.error(e.message),
  })
  const dismiss = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].deliveries[':id'].dismiss.$post({ param: { slug, id: String(d.id) } })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const busy = pr.isPending || merge.isPending || dismiss.isPending
  const shipped = d.status === 'merged'
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1">
          <Link to="/claude/$id" params={{ id: d.sessionId }} className="block truncate text-sm font-medium hover:underline">{d.title}</Link>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><BadgeCheck className="size-3.5" />{d.role}</span>
            <span className="flex items-center gap-1 font-mono"><GitBranch className="size-3.5" />{d.branch}</span>
            <Diffstat files={d.files} insertions={d.insertions} deletions={d.deletions} commits={d.commits} />
            {shipped && <span className="flex items-center gap-1 font-medium text-primary"><GitMerge className="size-3.5" />Merged{d.mergedCommit ? <span className="font-mono font-normal">{d.mergedCommit.slice(0, 7)}</span> : ''}</span>}
          </span>
        </span>
        {!shipped && (
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" disabled={busy} onClick={() => dismiss.mutate()}><X /></Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setViewing(true)}><Eye />View changes</Button>
        {d.prUrl ? (
          <Button size="sm" variant={shipped ? 'outline' : 'default'} asChild>
            <a href={d.prUrl} target="_blank" rel="noopener noreferrer"><GitPullRequest />View PR<ExternalLink className="opacity-70" /></a>
          </Button>
        ) : isGithub && !shipped ? (
          <Button size="sm" disabled={busy} onClick={() => pr.mutate()}>{pr.isPending ? <Spinner /> : <GitPullRequest />}Open PR</Button>
        ) : !shipped ? (
          <Button size="sm" disabled={busy}
            onClick={() => void confirmAction({ title: `Merge ${d.branch} into ${d.baseBranch}?`, description: 'This commits the merge on the server.', action: 'Merge' }).then((ok) => { if (ok) merge.mutate() })}>
            {merge.isPending ? <Spinner /> : <GitMerge />}Merge
          </Button>
        ) : null}
      </div>
      <DiffDialog slug={slug} d={d} open={viewing} onClose={() => setViewing(false)} />
    </li>
  )
}

function Diffstat({ files, insertions, deletions, commits }: { files: number; insertions: number; deletions: number; commits: number }) {
  return (
    <span className="flex items-center gap-2 tabular-nums">
      <span>{commits} commit{commits === 1 ? '' : 's'}</span>
      <span>{files} file{files === 1 ? '' : 's'}</span>
      {insertions > 0 && <span className="text-emerald-600 dark:text-emerald-500">+{insertions}</span>}
      {deletions > 0 && <span className="text-red-600 dark:text-red-500">−{deletions}</span>}
    </span>
  )
}

/** The branch's whole diff, monospace, fetched on open; notes when it was capped. */
function DiffDialog({ slug, d, open, onClose }: { slug: string; d: Delivery; open: boolean; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['deliveries', slug, 'diff', d.id],
    queryFn: () => unwrap(api.api.projects[':slug'].deliveries[':id'].diff.$get({ param: { slug, id: String(d.id) } })),
    enabled: open,
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()} title={d.title}
      description={<span className="font-mono">{d.branch} → {d.baseBranch}</span>}>
      {q.isPending ? <Skeleton className="h-64" />
        : q.error ? <ErrorAlert error={q.error} />
        : <div className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/30">
            {q.data.diff
              ? <pre className="min-w-max p-3 text-xs leading-relaxed"><code>{q.data.diff}</code></pre>
              : <p className="p-3 text-sm text-muted-foreground">No textual changes to show.</p>}
          </div>}
      {q.data?.truncated && <p className="mt-2 text-xs text-muted-foreground">The diff is large and was cut off here. Open the PR or the branch to see all of it.</p>}
    </ResponsiveDialog>
  )
}
