import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { CheckCheck, ListChecks, Plus, RotateCcw, SendHorizontal, SquareTerminal, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Prose } from '../claude/Prose'
import { ProposalCard } from './Approvals'
import { CLOSED_AS, MESSAGE_KINDS, threadQuery, useLiveTeam, type ThreadDetail } from './data'
import { OutcomeBadge, RoleMark } from './TeamTab'

export function ThreadPage() {
  const { slug, thread } = useParams({ from: '/app/projects/$slug/team/threads/$thread' })
  return <ThreadView key={thread} slug={slug} id={Number(thread)} />
}

function ThreadView({ slug, id }: { slug: string; id: number }) {
  useLiveTeam()
  const qc = useQueryClient()
  const q = useQuery(threadQuery(id))
  const [body, setBody] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const reply = useMutation({
    mutationFn: () => unwrap(api.api.team.threads[':id'].messages.$post({ param: { id: String(id) }, json: { kind: 'reply', body } })),
    onSuccess: () => { setBody(''); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const resolve = useMutation({
    mutationFn: () => unwrap(api.api.team.threads[':id'].resolve.$post({ param: { id: String(id) }, json: { resolution: '', as: 'done' } })),
    onSuccess: refresh,
  })
  const reopen = useMutation({ mutationFn: () => unwrap(api.api.team.threads[':id'].reopen.$post({ param: { id: String(id) } })), onSuccess: refresh })
  const linkTask = useMutation({
    mutationFn: (task: number) => unwrap(api.api.team.threads[':id'].tasks.$post({ param: { id: String(id) }, json: { task } })),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })
  const unlinkTask = useMutation({
    mutationFn: (task: number) => unwrap(api.api.team.threads[':id'].tasks[':task'].$delete({ param: { id: String(id), task: String(task) } })),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })
  const setPriority = useMutation({
    mutationFn: (priority: 'normal' | 'blocker') => unwrap(api.api.team.threads[':id'].priority.$post({ param: { id: String(id) }, json: { priority } })),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  if (q.error) return <><PageHeader title="Thread" back={`/projects/${slug}`} /><PageBody><ErrorAlert error={q.error} /></PageBody></>
  if (!q.data) return <><PageHeader title="Thread" back={`/projects/${slug}`} /><PageBody><Skeleton className="h-64" /></PageBody></>
  const { thread: t, messages, proposals, tasks } = q.data
  const open = t.status === 'open'
  const declined = !open && !!t.closedAs && t.closedAs !== 'done'

  return (
    <>
      <PageHeader back={`/projects/${slug}`} title={t.title}
        description={<span className="flex items-center gap-1.5">
          <StatusLight state={!open ? 'idle' : t.needsPeople ? 'waiting' : 'live'} />
          {!open ? (declined ? CLOSED_AS[t.closedAs!].label : 'Resolved') : t.needsPeople ? 'Waiting for people' : 'Open'}
          <span className="truncate">· {t.owner ? `${t.owner.name} owns it` : 'Nobody owns it'}{t.roles.length > 1 ? ` · with ${t.roles.filter((r) => r.id !== t.owner?.id).map((r) => r.name).join(', ')}` : ''}</span>
        </span>}
        actions={open
          ? <div className="flex gap-2">
              <Button size="sm" variant={t.priority === 'blocker' ? 'default' : 'outline'} disabled={setPriority.isPending}
                onClick={() => setPriority.mutate(t.priority === 'blocker' ? 'normal' : 'blocker')}>
                <TriangleAlert />{t.priority === 'blocker' ? 'Blocker' : 'Mark blocker'}
              </Button>
              <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate()}><CheckCheck />Resolve</Button>
            </div>
          : !declined && <Button size="sm" variant="outline" disabled={reopen.isPending} onClick={() => reopen.mutate()}><RotateCcw />Reopen</Button>} />
      <PageBody>
        <div className="flex max-w-3xl flex-col gap-5">
          {open && t.priority === 'blocker' && (
            <p className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
              <TriangleAlert className="size-4 shrink-0" />Blocker — the owning role treats this as top priority.
            </p>
          )}
          {open && t.needsPeople && (
            <div className="rounded-xl border border-attention/40 bg-attention-soft px-4 py-3 text-sm text-attention-foreground dark:bg-attention/10 dark:text-attention">
              {t.ask && <p className="text-base font-semibold">Decision needed: {t.ask}</p>}
              <p className={cn(t.ask && 'mt-1 opacity-90')}>
                {t.owner ? 'The roles need you to decide. Reply to settle it; they carry on after you.' : 'No role owns this. Reply, or resolve it.'}
              </p>
            </div>
          )}
          {declined && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
              <OutcomeBadge as={t.closedAs} />
              <p className="min-w-0 flex-1">
                <span className="font-medium">{t.closedBy ?? 'A role'}</span> closed this{t.resolvedAt ? ` ${relativeTime(t.resolvedAt)}` : ''}{t.resolution ? <>: <span className="text-muted-foreground">{t.resolution}</span></> : '.'}
                <span className="block text-xs text-muted-foreground">If it's needed after all, reopen it or reply below: replying reopens it.</span>
              </p>
              <Button size="sm" variant="outline" disabled={reopen.isPending} onClick={() => reopen.mutate()}><RotateCcw />Reopen</Button>
            </div>
          )}
          <LinkedTasks slug={slug} tasks={tasks} onLink={(n) => linkTask.mutate(n)} onUnlink={(n) => unlinkTask.mutate(n)} busy={linkTask.isPending || unlinkTask.isPending} />
          {/* Proposals sit where they were made, so the newest message is always the one above the reply box. */}
          <ol className="flex flex-col gap-5">
            {[...messages.map((m) => ({ at: m.at, el: <Message key={`m${m.id}`} m={m} /> })),
              ...proposals.map((x) => ({ at: x.createdAt, el: <li key={`p${x.id}`} className="sm:pl-11"><ProposalCard x={x} showProject={false} /></li> }))]
              .sort((a, b) => a.at - b.at).map((i) => i.el)}
          </ol>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) reply.mutate() }}>
            <Textarea rows={2} value={body} maxLength={8000} onChange={(e) => setBody(e.target.value)} aria-label="Reply"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (body.trim()) reply.mutate() } }}
              placeholder={!open ? 'Reply to reopen it.' : t.owner ? `Reply to everyone here. ${t.owner.name} picks it up right away.` : 'Reply to everyone here.'}
              className="max-h-48 min-h-11 flex-1 resize-none [field-sizing:content]" />
            <Button type="submit" size="icon" className="size-11 shrink-0" aria-label="Send" disabled={!body.trim() || reply.isPending}><SendHorizontal /></Button>
          </form>
          {t.resolution && !declined && <p className="text-sm text-muted-foreground">Outcome: {t.resolution}{t.closedBy ? ` (${t.closedBy})` : ''}</p>}
          <p className="text-xs text-muted-foreground">
            Opened by {t.openedBy}, {relativeTime(t.createdAt)}. <Link to="/projects/$slug/team/threads" params={{ slug }} className="hover:underline">All threads</Link>
            {' · '}<Link to="/projects/$slug" params={{ slug }} className="hover:underline">Back to the team</Link>
          </p>
        </div>
      </PageBody>
    </>
  )
}

/** The tasks a thread turned into ("one job per object"): each links to the task; a number box links another. */
function LinkedTasks({ slug, tasks, onLink, onUnlink, busy }: {
  slug: string; tasks: ThreadDetail['tasks']; onLink: (n: number) => void; onUnlink: (n: number) => void; busy: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [n, setN] = useState('')
  const submit = () => { const num = Number(n); if (Number.isInteger(num) && num > 0) { onLink(num); setN(''); setAdding(false) } }
  if (!tasks.length && !adding) {
    return <button className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}><Plus className="size-3.5" />Link a task</button>
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 px-4 py-3">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ListChecks className="size-3.5" />Tasks for this thread</h3>
      <ul className="flex flex-col gap-1">
        {tasks.map((x) => (
          <li key={x.number} className="flex items-center gap-2 text-sm">
            <Link to="/tasks/$slug/$number" params={{ slug: x.slug, number: String(x.number) }} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
              <span className={cn('font-mono text-xs', x.done && 'text-muted-foreground line-through')}>{x.slug}#{x.number}</span>
              <span className="truncate">{x.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{x.status}</span>
            </Link>
            <Button size="icon-sm" variant="ghost" aria-label={`Unlink ${x.slug}#${x.number}`} disabled={busy} onClick={() => onUnlink(x.number)}><X /></Button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <span className="text-sm text-muted-foreground">{slug}#</span>
          <input autoFocus type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} aria-label="Task number"
            className="h-8 w-20 rounded-md border bg-background px-2 text-sm" placeholder="10" />
          <Button type="submit" size="sm" disabled={!n || busy}>Link</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setN('') }}>Cancel</Button>
        </form>
      ) : (
        <button className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}><Plus className="size-3.5" />Link another task</button>
      )}
    </div>
  )
}

function Message({ m }: { m: ThreadDetail['messages'][number] }) {
  const kind = MESSAGE_KINDS[m.kind]
  return (
    <li className="flex gap-3">
      {m.role ? <RoleMark id={m.role.id} name={m.author} className="size-8 rounded-lg text-[10px]" />
        : m.sessionId ? <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SquareTerminal className="size-4" /></div>
        : <Avatar className="size-8"><AvatarFallback className="text-[11px]">{initials(m.author)}</AvatarFallback></Avatar>}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          {m.sessionId ? <Link to="/claude/$id" params={{ id: m.sessionId }} className="font-medium hover:underline">{m.author}</Link> : <span className="font-medium">{m.author}</span>}
          {kind?.label && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', kind.tone)}>{kind.label}</span>}
          <span className="text-xs text-muted-foreground">{relativeTime(m.at)}</span>
        </div>
        <Prose text={m.body} />
        {m.evidence && (
          <details className="rounded-lg border bg-muted/30 text-sm">
            <summary className="cursor-pointer px-3 py-1.5 text-muted-foreground">Evidence</summary>
            <div className="px-3 pb-2"><Prose text={m.evidence} /></div>
          </details>
        )}
      </div>
    </li>
  )
}
