import { useEffect, useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CalendarClock, Circle, CircleCheck, CircleDashed, CircleDot, CircleEllipsis, TriangleAlert } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { dueLabel, PRIORITIES, projectsQuery, STATUSES, type Priority, type Status, type Task } from './data'

export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const c = cn('size-4 shrink-0', className)
  switch (status) {
    case 'backlog': return <CircleDashed className={cn(c, 'text-muted-foreground')} aria-label="Backlog" />
    case 'todo': return <Circle className={cn(c, 'text-muted-foreground')} aria-label="To do" />
    case 'in_progress': return <CircleDot className={cn(c, 'text-live')} aria-label="In progress" />
    case 'review': return <CircleEllipsis className={cn(c, 'text-attention')} aria-label="Review" />
    default: return <CircleCheck className={cn(c, 'text-muted-foreground')} aria-label="Done" />
  }
}

export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
  if (priority === 'urgent') return <TriangleAlert className={cn('size-4 shrink-0 text-destructive', className)} aria-label="Urgent" />
  const level = ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[priority]
  if (!level) return null
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={`${priority[0]!.toUpperCase()}${priority.slice(1)} priority`} className={cn('size-4 shrink-0 text-foreground/75', className)}>
      {[0, 1, 2].map((i) => <rect key={i} x={2 + i * 4.5} y={11 - i * 3.5} width="3" height={3 + i * 3.5} rx="0.75" fill="currentColor" opacity={i < level ? 1 : 0.2} />)}
    </svg>
  )
}

export function Due({ due, done }: { due: string | null; done?: boolean }) {
  const d = dueLabel(due)
  if (!d) return null
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', !done && d.late ? 'text-destructive' : !done && 'today' in d ? 'text-attention-foreground' : 'text-muted-foreground')}>
      <CalendarClock className="size-3.5" />{d.text}
    </span>
  )
}

const meta = (t: Task, showProject: boolean) => (
  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    <span className="shrink-0 font-mono">{showProject ? t.key : `#${t.number}`}</span>
    <Due due={t.due} done={t.status === 'done'} />
  </span>
)

/** One task on the board. Drag on desktop; tap to open. */
export function TaskCard({ t, showProject, onDragStart }: { t: Task; showProject: boolean; onDragStart?: (e: React.DragEvent) => void }) {
  return (
    <Link to="/tasks/$slug/$number" params={{ slug: t.project.slug, number: String(t.number) }} draggable={!!onDragStart} onDragStart={onDragStart}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs transition-colors hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      <span className="flex items-start gap-2">
        <PriorityIcon priority={t.priority} className="mt-0.5" />
        <span className={cn('min-w-0 flex-1 leading-snug', t.status === 'done' && 'text-muted-foreground line-through')}>{t.title}</span>
      </span>
      <span className="flex items-center justify-between gap-2">
        {meta(t, showProject)}
        {t.assignee && <UserAvatar user={t.assignee} className="size-6" textClassName="text-[10px]" title={t.assignee.name} />}
      </span>
    </Link>
  )
}

/** One task in a list. */
export function TaskRow({ t, showProject }: { t: Task; showProject: boolean }) {
  return (
    <Link to="/tasks/$slug/$number" params={{ slug: t.project.slug, number: String(t.number) }}
      className="flex items-center gap-3 border-b px-3 py-2.5 text-sm last:border-b-0 hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline-none">
      <StatusIcon status={t.status} />
      <span className={cn('min-w-0 flex-1 truncate', t.status === 'done' && 'text-muted-foreground line-through')}>{t.title}</span>
      <PriorityIcon priority={t.priority} />
      {meta(t, showProject)}
      {t.assignee && <UserAvatar user={t.assignee} className="size-6" textClassName="text-[10px]" title={t.assignee.name} />}
    </Link>
  )
}

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()), staleTime: 60_000 }).data?.users ?? []
}

export function NewTask({ open, onClose, project, status }: { open: boolean; onClose: () => void; project?: string; status?: Status }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useQuery({ ...projectsQuery, enabled: open }).data?.projects ?? []
  const members = useMembers()
  const blank = { project: project ?? '', title: '', body: '', status: status ?? ('todo' as Status), priority: 'none' as Priority, due: '', assignee: '' }
  const [f, setF] = useState(blank)
  const set = (v: Partial<typeof blank>) => setF((o) => ({ ...o, ...v }))
  useEffect(() => { if (open) setF({ ...blank, project: project ?? projects[0]?.slug ?? '' }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !f.project && projects[0]) set({ project: projects[0].slug }) }, [open, projects, f.project])

  const create = useMutation({
    mutationFn: () => unwrap(api.api.tasks.$post({
      json: { project: f.project, title: f.title, body: f.body, status: f.status, priority: f.priority, due: f.due || null, assignee: f.assignee ? Number(f.assignee) : null },
    })),
    onSuccess: ({ task }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      onClose()
      void navigate({ to: '/tasks/$slug/$number', params: { slug: task.project.slug, number: String(task.number) } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (f.project && f.title.trim()) create.mutate()
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && onClose()} title="New task">
      {!projects.length && open ? (
        <p className="pb-4 text-sm text-muted-foreground">Tasks live in projects. <Link to="/projects" className="underline" onClick={onClose}>Add a project</Link> first.</p>
      ) : (
        <form onSubmit={submit}>
          <FieldGroup>
            {!project && (
              <Field>
                <FieldLabel htmlFor="nt-project">Project</FieldLabel>
                <NativeSelect id="nt-project" value={f.project} onChange={(e) => set({ project: e.target.value })}>
                  {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </NativeSelect>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="nt-title">Title</FieldLabel>
              <Input id="nt-title" required autoFocus className="h-10" value={f.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="nt-body">Details</FieldLabel>
              <Textarea id="nt-body" rows={4} placeholder="Markdown works here." value={f.body} onChange={(e) => set({ body: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="nt-status">Status</FieldLabel>
                <NativeSelect id="nt-status" value={f.status} onChange={(e) => set({ status: e.target.value as Status })}>
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="nt-priority">Priority</FieldLabel>
                <NativeSelect id="nt-priority" value={f.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
                  {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="nt-assignee">Assignee</FieldLabel>
                <NativeSelect id="nt-assignee" value={f.assignee} onChange={(e) => set({ assignee: e.target.value })}>
                  <option value="">Nobody</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="nt-due">Due</FieldLabel>
                <Input id="nt-due" type="date" className="h-10" value={f.due} onChange={(e) => set({ due: e.target.value })} />
              </Field>
            </div>
            <ErrorAlert error={create.error} />
            <Button type="submit" className="h-10" disabled={!f.project || !f.title.trim() || create.isPending}>Create task</Button>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialog>
  )
}
