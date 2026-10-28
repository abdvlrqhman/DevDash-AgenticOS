import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CircleCheck, CircleDashed, CircleX, Ellipsis, LoaderCircle, Play, Plug, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { GitHubConnection } from '../work/GitHub'

export const buildsQuery = (slug: string) => ({ queryKey: ['builds', slug], queryFn: () => unwrap(api.api.builds[':slug'].$get({ param: { slug } })), refetchInterval: 15_000 })

const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toLocaleDateString()
}

/** GitHub's status + conclusion as one icon. */
export function RunIcon({ status, conclusion, className }: { status: string; conclusion: string | null; className?: string }) {
  const c = cn('size-4 shrink-0', className)
  if (status !== 'completed') return status === 'in_progress' ? <LoaderCircle className={cn(c, 'animate-spin text-live')} aria-label="Running" /> : <CircleDashed className={cn(c, 'text-muted-foreground')} aria-label="Waiting" />
  if (conclusion === 'success') return <CircleCheck className={cn(c, 'text-live')} aria-label="Succeeded" />
  if (conclusion === 'skipped' || conclusion === 'cancelled' || conclusion === 'neutral') return <CircleDashed className={cn(c, 'text-muted-foreground')} aria-label={conclusion} />
  return <CircleX className={cn(c, 'text-destructive')} aria-label="Failed" />
}

export function BuildsTab({ slug, isGithub }: { slug: string; isGithub: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ ...buildsQuery(slug), enabled: isGithub })
  const [adding, setAdding] = useState(false)
  const start = useMutation({
    mutationFn: (id: number) => unwrap(api.api.builds[':slug'].targets[':id'].start.$post({ param: { slug, id: String(id) } })),
    onSuccess: ({ runId }) => {
      void qc.invalidateQueries({ queryKey: ['builds', slug] })
      if (runId) void navigate({ to: '/projects/$slug/builds/$run', params: { slug, run: String(runId) } })
      else toast.success('Started. It shows up below in a moment.')
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => unwrap(api.api.builds[':slug'].targets[':id'].$delete({ param: { slug, id: String(id) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['builds', slug] }),
  })

  if (!isGithub) return <ConnectRepo slug={slug} />
  if (q.isPending) return <Skeleton className="h-48" />
  if (q.error) return <div className="flex flex-col gap-3"><ErrorAlert error={q.error} /><GitHubConnection compact /></div>
  const d = q.data

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Build targets</h3>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add target</Button>
        </div>
        {!d.targets.length ? (
          <p className="text-sm text-muted-foreground">A target is a workflow you start with one tap, like "Android APK" or "Windows installer". It needs <code className="font-mono">workflow_dispatch</code> in the workflow file.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.targets.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border p-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{t.workflow} @ {t.ref}</span>
                </span>
                <Button size="sm" disabled={start.isPending} onClick={() => start.mutate(t.id)}>
                  {start.isPending && start.variables === t.id ? <LoaderCircle className="animate-spin" /> : <Play />}Run
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Options for ${t.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => remove.mutate(t.id)}><Trash2 />Remove target</DropdownMenuItem></DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Recent runs</h3>
        {!d.runs.length ? <p className="text-sm text-muted-foreground">No workflow runs yet.</p> : (
          <ul className="overflow-hidden rounded-xl border">
            {d.runs.map((r) => (
              <li key={r.id} className="border-b last:border-b-0">
                <Link to="/projects/$slug/builds/$run" params={{ slug, run: String(r.id) }} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/40">
                  <RunIcon status={r.status} conclusion={r.conclusion} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{r.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{r.workflow} #{r.number}, {r.branch}, {r.event.replace(/_/g, ' ')}{r.actor ? ` by ${r.actor}` : ''}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(r.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <AddTarget slug={slug} open={adding} onClose={() => setAdding(false)} workflows={d.workflows} defaultBranch={d.defaultBranch} />
    </div>
  )
}

/** When a project has no github.com remote (one started from a .zip or a plain `git init`): link it to a repository,
 *  which turns on Builds — and fetching and commit history — for it, instead of a dead-end message. */
function ConnectRepo({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState('')
  const connect = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].connect.$post({ param: { slug }, json: { repoUrl: url.trim() } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['builds', slug] })
      toast.success('Connected. Builds run from this repository now.')
    },
    onError: (e) => toast.error(e.message),
  })
  const ok = /github\.com[:/][\w.-]+\/[\w.-]+/.test(url.trim())
  const submit = (e: FormEvent) => { e.preventDefault(); if (ok) connect.mutate() }
  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Connect a GitHub repository</h3>
        <p className="text-sm text-muted-foreground">Builds run on GitHub Actions. This project isn't linked to a repository yet — add its github.com address to run its workflows from here. It also turns on fetching and commit history for the project.</p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="connect-url">Repository address</FieldLabel>
          <Input id="connect-url" autoFocus className="h-10 font-mono" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} />
          <FieldDescription>An https:// or git@ address on github.com. For a private repository you'll need your GitHub access set up (<code className="font-mono">gh auth login</code>) in your DevDash terminal.</FieldDescription>
        </Field>
        <ErrorAlert error={connect.error} />
        <div><Button type="submit" className="h-10" disabled={!ok || connect.isPending}>{connect.isPending ? <LoaderCircle className="animate-spin" /> : <Plug />}Connect repository</Button></div>
      </FieldGroup>
    </form>
  )
}

function AddTarget({ slug, open, onClose, workflows, defaultBranch }: { slug: string; open: boolean; onClose: () => void; workflows: { name: string; file: string }[]; defaultBranch: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [workflow, setWorkflow] = useState('')
  const [ref, setRef] = useState('')
  const [inputs, setInputs] = useState('')
  const parsed = Object.fromEntries(inputs.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  const add = useMutation({
    mutationFn: () => unwrap(api.api.builds[':slug'].targets.$post({ param: { slug }, json: { name, workflow: workflow || workflows[0]!.file, ref: ref || defaultBranch, inputs: parsed } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['builds', slug] }); close() },
  })
  const close = () => { onClose(); setName(''); setWorkflow(''); setRef(''); setInputs(''); add.reset() }
  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim() && workflows.length) add.mutate() }
  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && close()} title="Add a build target" description="Starts a GitHub Actions workflow with your GitHub account.">
      {!workflows.length ? <p className="pb-4 text-sm text-muted-foreground">This repository has no active workflows yet. Add one under .github/workflows (Claude can write it) and come back.</p> : (
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="bt-name">Name</FieldLabel>
              <Input id="bt-name" autoFocus className="h-10" placeholder="Android APK" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bt-wf">Workflow</FieldLabel>
              <NativeSelect id="bt-wf" value={workflow || workflows[0]!.file} onChange={(e) => setWorkflow(e.target.value)}>
                {workflows.map((w) => <option key={w.file} value={w.file}>{w.name} ({w.file})</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="bt-ref">Branch or tag</FieldLabel>
              <Input id="bt-ref" className="h-10 font-mono" placeholder={defaultBranch} value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bt-in">Inputs</FieldLabel>
              <Textarea id="bt-in" rows={3} className="font-mono text-sm" placeholder={'platform=android\nflavor=release'} value={inputs} onChange={(e) => setInputs(e.target.value)} />
              <FieldDescription>One name=value per line, matching the workflow's inputs. Optional.</FieldDescription>
            </Field>
            <ErrorAlert error={add.error} />
            <Button type="submit" className="h-10" disabled={!name.trim() || add.isPending}>Add target</Button>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialog>
  )
}
