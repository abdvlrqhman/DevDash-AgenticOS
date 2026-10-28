import { useEffect, useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Bot, GitCommitHorizontal, MessagesSquare, Pencil, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { AuthorTag } from '@/components/app/author'
import { NativeSelect } from '@/components/app/native-select'
import { PageHeader, pageCol } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { PinButton } from '../pins/pins'
import { ErrorAlert } from '../auth/LoginPage'
import { Prose } from '../claude/Blocks'
import { relativeTime } from '../claude/data'
import { PRIORITIES, STATUSES, taskQuery, useLiveWork, type Priority, type Status, type TaskDetail } from '../work/data'
import { StatusIcon, useMembers } from '../work/TaskBits'

/** Keyed by the URL, so moving to another one starts from a clean slate. */
export function TaskPage() {
  const p = useParams({ from: '/app/tasks/$slug/$number' })
  return <TaskPageView key={`${p.slug}#${p.number}`} />
}

function TaskPageView() {
  useLiveWork()
  const { slug, number } = useParams({ from: '/app/tasks/$slug/$number' })
  const n = Number(number)
  const qc = useQueryClient()
  const q = useQuery(taskQuery(slug, n))
  const members = useMembers()
  const [giving, setGiving] = useState(false)
  const t = q.data?.task

  const update = useMutation({
    mutationFn: (json: { title?: string; body?: string; status?: Status; priority?: Priority; due?: string | null; assignee?: number | null }) =>
      unwrap(api.api.tasks[':slug'][':number'].$patch({ param: { slug, number }, json })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (e) => toast.error(e.message),
  })

  if (q.error) return <><PageHeader title={`${slug}#${number}`} back="/tasks" /><div className="p-4"><ErrorAlert error={q.error} /></div></>
  if (!t) return <><PageHeader title={`${slug}#${number}`} back="/tasks" /><div className="flex flex-col gap-3 p-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-32" /></div></>

  return (
    <>
      <PageHeader back="/tasks" title={<span className="font-mono">{t.key}</span>}
        description={<Link to="/projects/$slug" params={{ slug: t.project.slug }} className="hover:underline">{t.project.name}</Link>}
        actions={<><PinButton kind="task" id={`${slug}/${number}`} /><Button size="sm" onClick={() => setGiving(true)}><Sparkles />Give to Claude</Button></>} />
      <div style={pageCol()} className="page-col grid w-full gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Title t={t} onSave={(title) => update.mutate({ title })} />
          <Body t={t} onSave={(body) => update.mutate({ body })} />
          <Comments t={t} />
        </div>

        <aside className="flex flex-col gap-4 text-sm lg:border-l lg:pl-6" aria-label="Task details">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <Field>
              <FieldLabel htmlFor="t-status">Status</FieldLabel>
              <NativeSelect id="t-status" value={t.status} onChange={(e) => update.mutate({ status: e.target.value as Status })}>
                {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="t-priority">Priority</FieldLabel>
              <NativeSelect id="t-priority" value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value as Priority })}>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="t-assignee">Assignee</FieldLabel>
              <NativeSelect id="t-assignee" value={t.assignee?.id ?? ''} onChange={(e) => update.mutate({ assignee: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Nobody</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="t-due">Due</FieldLabel>
              <Input id="t-due" type="date" className="h-10" value={t.due ?? ''} onChange={(e) => update.mutate({ due: e.target.value || null })} />
            </Field>
          </div>
          {t.thread && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Thread</h3>
              <Link to="/projects/$slug/team/threads/$thread" params={{ slug: t.project.slug, thread: String(t.thread.id) }} className="flex items-start gap-2 hover:underline">
                <MessagesSquare className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0"><span className="text-muted-foreground">From thread #{t.thread.id}:</span> {t.thread.title}</span>
              </Link>
            </div>
          )}
          <Links t={t} />
          <p className="text-xs text-muted-foreground">Created by {t.creatorRole ? <span className="text-foreground">{t.creatorRole} · AI team</span> : t.creator} {relativeTime(t.createdAt)}. Commits that say <code className="font-mono">fixes #{t.number}</code> move it to Review on a branch and to Done on the default branch.</p>
        </aside>
      </div>
      <GiveToClaude t={t} open={giving} onClose={() => setGiving(false)} />
    </>
  )
}

function Title({ t, onSave }: { t: TaskDetail; onSave: (title: string) => void }) {
  const [v, setV] = useState(t.title)
  useEffect(() => setV(t.title), [t.title])
  const save = () => { if (v.trim() && v.trim() !== t.title) onSave(v.trim()); else setV(t.title) }
  return (
    <div className="flex items-start gap-2">
      <StatusIcon status={t.status} className="mt-2 size-5" />
      <Textarea aria-label="Title" rows={1} value={v} onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } if (e.key === 'Escape') { setV(t.title); e.currentTarget.blur() } }}
        className="min-h-0 resize-none border-transparent bg-transparent px-1 py-0.5 text-xl! leading-snug font-semibold shadow-none field-sizing-content hover:border-input focus-visible:border-ring dark:bg-transparent" />
    </div>
  )
}

function Body({ t, onSave }: { t: TaskDetail; onSave: (body: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(t.body)
  useEffect(() => { if (!editing) setV(t.body) }, [t.body, editing])
  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea autoFocus rows={8} value={v} onChange={(e) => setV(e.target.value)} placeholder="Markdown works here." className="min-h-40 field-sizing-content" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setV(t.body); setEditing(false) }}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(v); setEditing(false) }}>Save</Button>
        </div>
      </div>
    )
  }
  return t.body.trim() ? (
    <div className="group relative">
      <Prose text={t.body} />
      <Button size="icon-sm" variant="ghost" aria-label="Edit details" className="absolute -top-1 right-0 opacity-60 group-hover:opacity-100" onClick={() => setEditing(true)}><Pencil /></Button>
    </div>
  ) : (
    <button className="rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground hover:bg-accent/40" onClick={() => setEditing(true)}>Add details</button>
  )
}

function Comments({ t }: { t: TaskDetail }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const add = useMutation({
    mutationFn: () => unwrap(api.api.tasks[':slug'][':number'].comments.$post({ param: { slug: t.project.slug, number: String(t.number) }, json: { body } })),
    onSuccess: () => { setBody(''); void qc.invalidateQueries({ queryKey: ['tasks'] }) },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (body.trim()) add.mutate()
  }
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Comments</h2>
      {t.comments.map((c) => (
        <div key={c.id} className="flex gap-3">
          {c.role ? <Avatar className="size-7"><AvatarFallback className="text-[11px]"><Bot className="size-3.5" /></AvatarFallback></Avatar> : <UserAvatar user={c.user} className="size-7" textClassName="text-[11px]" />}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="font-medium">{c.role ?? c.user.name}</span>
              <AuthorTag role={c.role} viaClaude={c.viaClaude} account={c.role ? c.user.name : null} />
              <span className="text-xs text-muted-foreground">{relativeTime(c.at)}</span>
            </p>
            <Prose text={c.body} />
          </div>
        </div>
      ))}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Textarea aria-label="Write a comment" placeholder="Write a comment" rows={2} value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e) }} />
        <ErrorAlert error={add.error} />
        <div className="flex justify-end"><Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>Comment</Button></div>
      </form>
    </section>
  )
}

function Links({ t }: { t: TaskDetail }) {
  const commits = t.links.filter((l) => l.kind === 'commit')
  const sessions = t.links.filter((l) => l.kind === 'session')
  if (!commits.length && !sessions.length) return null
  return (
    <div className="flex flex-col gap-3">
      {sessions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Claude sessions</h3>
          {sessions.map((l) => (
            <Link key={l.ref} to="/claude/$id" params={{ id: l.ref }} className="flex items-center gap-2 hover:underline"><Sparkles className="size-3.5 shrink-0" /><span className="truncate">{l.title}</span></Link>
          ))}
        </div>
      )}
      {commits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Commits</h3>
          {commits.map((l) => (
            <div key={l.ref} className="flex items-start gap-2" title={l.title}>
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0"><span className="font-mono text-xs">{l.ref.slice(0, 7)}</span> <span className="line-clamp-2">{l.title}</span>
                <span className="block text-xs text-muted-foreground">{l.meta.replace(/^default:/, '')}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GiveToClaude({ t, open, onClose }: { t: TaskDetail; open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [worktree, setWorktree] = useState(true)
  const give = useMutation({
    mutationFn: () => unwrap(api.api.tasks[':slug'][':number'].claude.$post({ param: { slug: t.project.slug, number: String(t.number) }, json: { note, worktree } })),
    onSuccess: ({ sessionId }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] })
      onClose()
      void navigate({ to: '/claude/$id', params: { id: sessionId } })
    },
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && onClose()} title={`Give ${t.key} to Claude`}
      description="Claude starts on it right away in the project, as you, and keeps going when you close the app.">
      <form onSubmit={(e) => { e.preventDefault(); give.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="g-note">Anything to add?</FieldLabel>
            <Textarea id="g-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional. The task's title and details are sent already." />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="g-wt">Work on a separate branch</FieldLabel>
              <FieldDescription>A worktree of its own, so it doesn't collide with other sessions in this project.</FieldDescription>
            </FieldContent>
            <Switch id="g-wt" checked={worktree} onCheckedChange={setWorktree} />
          </Field>
          <ErrorAlert error={give.error} />
          <Button type="submit" className="h-10" disabled={give.isPending}><Sparkles />Start Claude</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
