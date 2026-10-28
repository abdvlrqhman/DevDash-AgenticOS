import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Copy, Download, ExternalLink, FileText, Link2, RotateCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
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

  if (q.error) return <><PageHeader title="Build" back={`/projects/${slug}`} /><div className="p-4"><ErrorAlert error={q.error} /></div></>
  if (!q.data) return <><PageHeader title="Build" back={`/projects/${slug}`} /><div className="p-4"><Skeleton className="h-48" /></div></>
  const { run: r, jobs, artifacts } = q.data
  const done = r.status === 'completed'

  return (
    <>
      <PageHeader back={`/projects/${slug}`} title={`${r.workflow} #${r.number}`}
        description={<span className="flex items-center gap-1.5"><RunIcon status={r.status} conclusion={r.conclusion} className="size-3.5" />{done ? (r.conclusion ?? 'done') : r.status.replace('_', ' ')}, {r.branch}</span>}
        actions={<>
          {done ? <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('rerun')}><RotateCw /><span className="hidden sm:inline">Run again</span></Button>
            : <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('cancel')}><Square /><span className="hidden sm:inline">Cancel</span></Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Open on GitHub" onClick={() => openExternal(r.url)}><ExternalLink /></Button>
        </>} />
      <PageBody>
        <p className="text-sm">{r.title}</p>
        {artifacts.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Artifacts</h3>
            <ul className="overflow-hidden rounded-xl border">
              {artifacts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 border-b px-3 py-2.5 text-sm last:border-b-0">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.name}</span><span className="text-xs text-muted-foreground">{a.expired ? 'Expired on GitHub' : bytes(a.size)}</span></span>
                  {!a.expired && <>
                    <Button size="sm" variant="ghost" asChild><a href={`/api/builds/${slug}/artifacts/${a.id}/${encodeURIComponent(a.name)}`} download><Download /><span className="hidden sm:inline">Download</span></a></Button>
                    <Button size="sm" variant="outline" onClick={() => setSharing({ id: a.id, name: a.name })}><Link2 />Share link</Button>
                  </>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Jobs</h3>
          {jobs.map((j) => (
            <div key={j.id} className="overflow-hidden rounded-xl border">
              <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm">
                <RunIcon status={j.status} conclusion={j.conclusion} />
                <span className="min-w-0 flex-1 truncate font-medium">{j.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{duration(j.startedAt, j.completedAt)}</span>
                {j.status === 'completed' && <Button size="sm" variant="ghost" onClick={() => void openLog(j)}><FileText />Log</Button>}
              </div>
              <ol>
                {j.steps.map((s) => (
                  <li key={s.number} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    <RunIcon status={s.status} conclusion={s.conclusion} className="size-3.5" />
                    <span className={s.status === 'queued' || s.conclusion === 'skipped' ? 'min-w-0 flex-1 truncate text-muted-foreground' : 'min-w-0 flex-1 truncate'}>{s.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{duration(s.startedAt, s.completedAt)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {!done && <p className="text-xs text-muted-foreground">Updates every few seconds. Full logs appear when each job finishes (GitHub only serves them then).</p>}
        </section>
      </PageBody>
      <ResponsiveDialog open={!!log} onOpenChange={(v) => !v && setLog(null)} title={log?.name ?? 'Log'}>
        {log?.text === null ? <Skeleton className="h-64" /> : (
          <pre className="max-h-[70vh] overflow-auto rounded-lg bg-term-bg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-term-fg select-text" data-selectable>{log?.text}</pre>
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
