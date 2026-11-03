import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Copy, Download, ExternalLink, FileText, Link2, RotateCw, Square } from 'lucide-react'
import { toast } from '@/lib/toast'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { bytes } from '../files/FilesPage'
import { RunIcon } from './BuildsTab'

const duration = (a: string | null, b: string | null) => {
  if (!a) return ''
  const s = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** One workflow run: jobs and steps update every few seconds while it runs; logs and artifacts once done. */
/** Keyed by the URL, so moving to another one starts from a clean slate. */
export function RunPage() {
  const p = useParams({ from: '/app/projects/$slug/builds/$run' })
  return <RunPageView key={`${p.slug}/${p.run}`} />
}

function RunPageView() {
  const { slug, run } = useParams({ from: '/app/projects/$slug/builds/$run' })
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['builds', slug, 'run', run],
    queryFn: () => unwrap(api.api.builds[':slug'].runs[':run'].$get({ param: { slug, run } })),
    refetchInterval: (query) => (query.state.data?.run.status === 'completed' ? false : 4000),
  })
  const [log, setLog] = useState<{ name: string; text: string | null } | null>(null)
  const [sharing, setSharing] = useState<{ id: number; name: string } | null>(null)
  const act = useMutation({
    mutationFn: (what: 'cancel' | 'rerun') => unwrap(api.api.builds[':slug'].runs[':run'][what].$post({ param: { slug, run } })),
    onSuccess: (_r, what) => { toast.success(what === 'cancel' ? 'Cancelling' : 'Started again'); void qc.invalidateQueries({ queryKey: ['builds', slug] }) },
    onError: (e) => toast.error(e.message),
  })
  const openLog = async (job: { id: number; name: string }) => {
    setLog({ name: job.name, text: null })
    try {
      const r = await unwrap(api.api.builds[':slug'].jobs[':job'].log.$get({ param: { slug, job: String(job.id) } }))
      setLog({ name: job.name, text: r.log })
    } catch (e) {
      setLog({ name: job.name, text: (e as Error).message })
    }
  }

  if (q.error) return <><PageHeader title="Build" back={`/projects/${slug}`} /><PageBody><ErrorAlert error={q.error} /></PageBody></>
  if (!q.data) return <><PageHeader title="Build" back={`/projects/${slug}`} /><PageBody><Skeleton className="h-12 w-1/2 rounded-xl bg-surface" /><Skeleton className="h-64 rounded-2xl bg-surface" /></PageBody></>
  const { run: r, jobs, artifacts } = q.data
  const done = r.status === 'completed'
  const took = duration(r.createdAt, done ? r.updatedAt : null)
  // The page's one loud line: how it went, and how long it took (or has taken so far).
  const verdict = !done ? (r.status === 'in_progress' ? `Running for ${took}` : 'Waiting to start')
    : r.conclusion === 'success' ? `Passed in ${took}`
    : r.conclusion === 'cancelled' ? 'Cancelled'
    : r.conclusion === 'skipped' || r.conclusion === 'neutral' ? 'Skipped'
    : `Failed after ${took}`

  return (
    <>
      <PageHeader back={`/projects/${slug}`} title={`${r.workflow} #${r.number}`}
        description={`On ${r.branch}`}
        actions={<>
          {done ? <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('rerun')}><RotateCw /><span className="hidden sm:inline">Run again</span></Button>
            : <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('cancel')}><Square /><span className="hidden sm:inline">Cancel</span></Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openExternal(r.url)}><ExternalLink /></Button>
        </>} />
      <PageBody className="gap-10 md:py-10">
        <header className="flex items-start gap-4">
          <RunIcon status={r.status} conclusion={r.conclusion} className="mt-1 size-8 md:mt-1.5" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className={cn('text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] tabular-nums md:text-[2.25rem]', done && r.conclusion !== 'success' && r.conclusion !== 'failure' && 'text-muted-foreground')}>
              {verdict}{done ? '.' : '…'}
            </h2>
            <p className="text-[15px] text-pretty text-muted-foreground">{r.title}</p>
          </div>
        </header>

        {artifacts.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold tracking-[-0.01em]">Artifacts<span className="ml-2 font-normal text-muted-foreground tabular-nums">{artifacts.length}</span></h2>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {artifacts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-xl py-2 pr-1.5 pl-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate font-medium', a.expired && 'text-muted-foreground')}>{a.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{a.expired ? 'Expired on GitHub' : bytes(a.size)}</span>
                  </span>
                  {!a.expired && <>
                    <Button size="sm" variant="ghost" asChild><a href={`/api/builds/${slug}/artifacts/${a.id}/${encodeURIComponent(a.name)}`} download aria-label={`Download ${a.name}`}><Download /><span className="hidden sm:inline">Download</span></a></Button>
                    <Button size="sm" variant="outline" className="bg-background hover:bg-surface-2" onClick={() => setSharing({ id: a.id, name: a.name })}><Link2 />Share link</Button>
                  </>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Jobs<span className="ml-2 font-normal text-muted-foreground tabular-nums">{jobs.length}</span></h2>
          <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
            {jobs.map((j) => (
              <div key={j.id} className="flex flex-col rounded-2xl bg-surface p-1.5">
                <div className="flex min-h-10 items-center gap-3 rounded-xl py-1 pr-3 pl-3 text-sm has-[button]:pr-1">
                  <span className="flex size-5 shrink-0 items-center justify-center"><RunIcon status={j.status} conclusion={j.conclusion} /></span>
                  <span className="min-w-0 flex-1 truncate font-medium">{j.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{duration(j.startedAt, j.completedAt)}</span>
                  {j.status === 'completed' && <Button size="sm" variant="ghost" onClick={() => void openLog(j)}><FileText />Log</Button>}
                </div>
                <ol className="flex flex-col pb-1">
                  {j.steps.map((s) => (
                    <li key={s.number} className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm">
                      <span className="flex size-5 shrink-0 items-center justify-center"><RunIcon status={s.status} conclusion={s.conclusion} className="size-3.5" /></span>
                      <span className={cn('min-w-0 flex-1 truncate', s.status === 'queued' || s.conclusion === 'skipped' ? 'text-muted-foreground' : 'text-foreground/85')}>{s.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{duration(s.startedAt, s.completedAt)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          {!done && <p className="text-xs text-pretty text-muted-foreground">Updates every few seconds. Full logs appear when each job finishes (GitHub only serves them then).</p>}
        </section>
      </PageBody>
      <ResponsiveDialog open={!!log} onOpenChange={(v) => !v && setLog(null)} title={log?.name ?? 'Log'}>
        {log?.text === null ? <Skeleton className="h-64 rounded-2xl bg-surface" /> : (
          <pre className="max-h-[70vh] overflow-auto rounded-xl bg-term-bg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-term-fg select-text" data-selectable>{log?.text}</pre>
        )}
      </ResponsiveDialog>
      {sharing && <ShareArtifact slug={slug} artifact={sharing} runNumber={r.number} onClose={() => setSharing(null)} />}
    </>
  )
}

function ShareArtifact({ slug, artifact, runNumber, onClose }: { slug: string; artifact: { id: number; name: string }; runNumber: number; onClose: () => void }) {
  const [expires, setExpires] = useState<'1d' | '7d' | '30d' | 'never'>('7d')
  const [password, setPassword] = useState('')
  const share = useMutation({
    mutationFn: () => unwrap(api.api.builds[':slug'].artifacts[':id'].share.$post({ param: { slug, id: String(artifact.id) }, json: { name: artifact.name, runNumber, expires, password: password || undefined } })),
  })
  const s = share.data?.share
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title={s ? 'Link ready' : `Share ${artifact.name}`}
      description={s ? 'Send it to your testers. No account needed.' : 'DevDash downloads the artifact from GitHub and keeps a copy for the link.'}>
      {s ? (
        <div className="flex gap-2 pb-2">
          <Input readOnly value={s.url} className="h-10 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button className="h-10" onClick={() => void navigator.clipboard.writeText(s.url).then(() => toast.success('Link copied'))}><Copy />Copy</Button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); share.mutate() }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sa-exp">Link works for</FieldLabel>
              <NativeSelect id="sa-exp" value={expires} onChange={(e) => setExpires(e.target.value as typeof expires)}>
                <option value="1d">1 day</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="never">Never expires</option>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="sa-pw">Password</FieldLabel>
              <Input id="sa-pw" className="h-10" placeholder="None" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorAlert error={share.error} />
            <Button type="submit" className="h-10" disabled={share.isPending}><Link2 />{share.isPending ? 'Copying the artifact…' : 'Create link'}</Button>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialog>
  )
}
