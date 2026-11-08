import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CircleCheck, CircleStop, FileDiff, GitBranch, Info, ListTodo, Server, TriangleAlert } from 'lucide-react'
import { toast } from '@/lib/toast'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap, type User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import type { Project } from '../work/data'

/** Same rule as the server (projects/service.ts canDelete): who added it, or an admin once that account is disabled. */
export const canDeleteProject = (me: User | null | undefined, p: Pick<Project, 'creator'>) =>
  !!me && (me.id === p.creator.id || (me.role === 'admin' && p.creator.disabled))

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const and = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '')

/** One thing deleting affects: an icon and a sentence. A red icon where work could be lost, quiet when all is well. */
function Risk({ tone, icon, children }: { tone: 'danger' | 'note' | 'ok'; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={cn('flex items-start gap-2.5 text-sm text-pretty [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0',
      tone === 'danger' ? '[&_svg]:text-destructive' : tone === 'ok' && 'text-muted-foreground')}>
      {icon}<span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

/** The project's short name, typed to confirm, GitHub style. */
function ConfirmName({ slug, value, onChange }: { slug: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field>
      <FieldLabel htmlFor="confirm-slug">Type <span className="font-mono font-semibold select-all">{slug}</span> to confirm</FieldLabel>
      <Input id="confirm-slug" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off"
        spellCheck={false} className="font-mono" dir="ltr" />
    </Field>
  )
}

/**
 * Deleting a project: what it would affect, checked live when the dialog opens (uncommitted changes, commits that
 * exist only here, sessions and services that get stopped, tasks and notes), then the short name typed to confirm.
 * It goes to Recently deleted for seven days; the GitHub repository is never touched.
 */
export function DeleteProjectDialog({ project: p, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const check = useQuery({
    queryKey: ['projects', 'delete-check', p.slug],
    queryFn: () => unwrap(api.api.projects[':slug'].delete.$get({ param: { slug: p.slug } })),
    enabled: open, staleTime: 0, gcTime: 0, retry: false,
  })
  const del = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].delete.$post({ param: { slug: p.slug }, json: { confirm: typed } })),
    onSuccess: () => {
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['projects'] })
      void qc.invalidateQueries({ queryKey: ['claude'] })
      void qc.invalidateQueries({ queryKey: ['services'] })
      toast.success(`Deleted ${p.name}`, { description: 'You can restore it from Recently deleted on Projects for 7 days.' })
      void navigate({ to: '/projects' })
    },
  })
  const c = check.data?.check
  const close = (v: boolean) => { if (!v) { setTyped(''); del.reset() } onOpenChange(v) }
  const submit = (e: FormEvent) => { e.preventDefault(); if (typed.trim() === p.slug && c) del.mutate() }

  const dirty = c ? [
    ...(c.git.changes ? [`${c.git.changes} in the checkout`] : []),
    ...c.git.worktrees.filter((w) => w.changes).map((w) => `${w.changes} in ${w.branch ?? w.path.split('/').pop()}`),
  ] : []
  const unpushed = c?.git.unpushed ?? []
  const commits = unpushed.reduce((n, b) => n + b.commits, 0)

  return (
    <ResponsiveDialog open={open} onOpenChange={close} title={`Delete ${p.name}?`}
      description={`It moves to Recently deleted on Projects, where you can restore it for ${c?.keepDays ?? 7} days. After that it's gone for good.`}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {check.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Checking what's at risk…</p>}
        <ErrorAlert error={check.error} />
        {c && (
          <ul className="flex flex-col gap-3 rounded-2xl bg-surface p-4" aria-label="What deleting affects">
            {c.git.error ? <Risk tone="danger" icon={<TriangleAlert />}>Couldn't check the code for unsaved work: {c.git.error}</Risk>
              : dirty.length ? <Risk tone="danger" icon={<FileDiff />}>Uncommitted changes: {and(dirty)}. They go to the trash with the folder.</Risk>
              : <Risk tone="ok" icon={<CircleCheck />}>No uncommitted changes.</Risk>}
            {!c.repoUrl ? <Risk tone="danger" icon={<TriangleAlert />}>This project has no GitHub copy: its code exists only here.</Risk>
              : c.git.unpushed === null && !c.git.error ? <Risk tone="note" icon={<GitBranch />}>Couldn't tell which commits are on GitHub.</Risk>
              : commits ? <Risk tone="danger" icon={<GitBranch />}>{plural(commits, 'commit')} on {and(unpushed.slice(0, 3).map((b) => b.branch))}{unpushed.length > 3 ? ` and ${plural(unpushed.length - 3, 'other branch', 'other branches')}` : ''} {commits === 1 ? "isn't" : "aren't"} on GitHub.</Risk>
              : !c.git.error && <Risk tone="ok" icon={<CircleCheck />}>Every commit is on GitHub.</Risk>}
            {c.sessions.live.length > 0 && (
              <Risk tone="danger" icon={<CircleStop />}>
                {c.sessions.live.length === 1 ? 'A session is' : `${c.sessions.live.length} sessions are`} running or waiting and will be stopped:{' '}
                {and(c.sessions.live.slice(0, 3).map((s) => `“${s.title}” (${s.owner})`))}{c.sessions.live.length > 3 ? ` and ${c.sessions.live.length - 3} more` : ''}.
              </Risk>
            )}
            {c.sessions.total > 0 && <Risk tone="note" icon={<Info />}>{c.sessions.total === 1 ? 'Its session is' : `All ${c.sessions.total} of its sessions are`} archived. They stay readable.</Risk>}
            {c.services.length > 0 && (
              <Risk tone="danger" icon={<Server />}>
                {c.services.length === 1 ? 'This service runs from it and will be stopped and removed' : 'These services run from it and will be stopped and removed'}:{' '}
                {and(c.services.map((s) => `${s.name} (${s.owner})`))}.
              </Risk>
            )}
            {(c.openTasks > 0 || c.notes > 0) && (
              <Risk tone="note" icon={<ListTodo />}>
                {and([...(c.openTasks ? [plural(c.openTasks, 'open task')] : []), ...(c.notes ? [plural(c.notes, 'note')] : [])])} go with it.
              </Risk>
            )}
            {c.repoUrl && <Risk tone="ok" icon={<Info />}>The GitHub repository isn't touched.</Risk>}
          </ul>
        )}
        {c && <ConfirmName slug={p.slug} value={typed} onChange={setTyped} />}
        <ErrorAlert error={del.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => close(false)}>Keep it</Button>
          <Button type="submit" variant="destructive" disabled={!c || typed.trim() !== p.slug || del.isPending}>
            {del.isPending && <Spinner />}Delete project
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  )
}

export const trashQuery = { queryKey: ['projects', 'trash'], queryFn: () => unwrap(api.api.projects.trash.$get()) }

/** Recently deleted, on Projects: only the projects this member may restore or delete for good. */
export function RecentlyDeleted() {
  const qc = useQueryClient()
  const list = useQuery(trashQuery)
  const [purging, setPurging] = useState<{ slug: string; name: string } | null>(null)
  const [typed, setTyped] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['projects'] })
  const restore = useMutation({
    mutationFn: (slug: string) => unwrap(api.api.projects.trash[':slug'].restore.$post({ param: { slug } })),
    onSuccess: (r) => { refresh(); toast.success(`Restored ${r.project.name}`) },
    onError: (e) => toast.error(e.message),
  })
  const purge = useMutation({
    mutationFn: (slug: string) => unwrap(api.api.projects.trash[':slug'].purge.$post({ param: { slug }, json: { confirm: typed } })),
    onSuccess: () => { const name = purging?.name; setPurging(null); setTyped(''); refresh(); toast.success(`Deleted ${name} for good`) },
  })
  const rows = list.data?.projects ?? []
  if (!rows.length) return null
  const daysLeft = (at: number) => Math.max(0, Math.ceil((at * 1000 - Date.now()) / 86_400_000))
  return (
    <section className="flex flex-col gap-3" aria-labelledby="recently-deleted">
      <div className="flex flex-col gap-0.5">
        <h2 id="recently-deleted" className="text-base font-semibold tracking-[-0.01em]">Recently deleted</h2>
        <p className="text-sm text-muted-foreground">Only you see these. Each is gone for good 7 days after it was deleted.</p>
      </div>
      <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
        {rows.map((p) => {
          const left = daysLeft(p.purgeAt)
          return (
            <li key={p.slug} className="flex flex-col gap-2 rounded-xl px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  Deleted {relativeTime(p.deletedAt)}. {left > 1 ? `Gone for good in ${left} days` : left === 1 ? 'Gone for good tomorrow' : 'Gone for good today'}.
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(p.slug)}>
                  {restore.isPending && restore.variables === p.slug && <Spinner />}Restore
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPurging(p)}>Delete forever</Button>
              </span>
            </li>
          )
        })}
      </ul>
      <ResponsiveDialog open={!!purging} onOpenChange={(v) => { if (!v) { setPurging(null); setTyped(''); purge.reset() } }}
        title={`Delete ${purging?.name ?? ''} for good?`}
        description="Its folder, worktrees, tasks and notes are removed now and can't be brought back. Its sessions stay readable under Archived. The GitHub repository isn't touched.">
        <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); if (purging && typed.trim() === purging.slug) purge.mutate(purging.slug) }}>
          {purging && <ConfirmName slug={purging.slug} value={typed} onChange={setTyped} />}
          <ErrorAlert error={purge.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPurging(null)}>Keep it</Button>
            <Button type="submit" variant="destructive" disabled={!purging || typed.trim() !== purging.slug || purge.isPending}>
              {purge.isPending && <Spinner />}Delete forever
            </Button>
          </div>
        </form>
      </ResponsiveDialog>
    </section>
  )
}
