import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Check, ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { SidebarMenuBadge } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Prose } from '../claude/Prose'
import { approvalProjectsQuery, approvalsCountQuery, approvalsQuery, KIND_LABELS, useLiveTeam, type ApprovalProject, type Proposal } from './data'
import { RoleMark } from './TeamTab'

/** What a role wants to do that needs a person: approve, reject, or reply with what you think. */
export function ProposalCard({ x, showProject = true }: { x: Proposal; showProject?: boolean }) {
  const qc = useQueryClient()
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const decide = useMutation({
    mutationFn: (approve: boolean) => unwrap(api.api.team.proposals[':id'].decide.$post({ param: { id: String(x.id) }, json: { approve, reply } })),
    onSuccess: (r, approve) => {
      void qc.invalidateQueries({ queryKey: ['team'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      toast.success(approve ? 'Approved.' : `Rejected. ${x.role.name} will see why.`, { description: approve && r.proposal.outcome ? r.proposal.outcome.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') : undefined })
    },
    onError: (e) => toast.error(e.message),
  })
  const p = x.payload as { prompt?: string; tasks?: { title: string; priority?: string }[]; goal?: { title: string; measure?: string; due?: string }; details?: string; confidence?: number; concern?: string | null; target?: { label?: string } }
  const pending = x.status === 'pending'
  const isClose = x.kind === 'close'
  return (
    <article className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <RoleMark id={x.role.id} name={x.role.name} className="size-7 rounded-md text-[10px]" />
        <span className="font-medium">{x.role.name}</span>
        <span className="text-muted-foreground">
          {showProject && <><Link to="/projects/$slug" params={{ slug: x.project.slug }} className="hover:underline">{x.project.name}</Link> · </>}
          {relativeTime(x.createdAt)}
        </span>
        <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">{KIND_LABELS[x.kind] ?? x.kind}</span>
      </div>
      <h3 className="text-base font-semibold">{x.title}</h3>
      {x.why && <div className="text-sm"><Prose text={x.why} /></div>}
      {x.kind === 'code' && p.prompt && (
        <details className="rounded-lg border bg-muted/30 text-sm">
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground">What Claude will be asked to do</summary>
          <div className="px-3 pb-3 whitespace-pre-wrap">{p.prompt}</div>
        </details>
      )}
      {x.kind === 'task' && p.tasks?.length ? (
        <ul className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          {p.tasks.map((t, i) => <li key={i}>{t.title}{t.priority && t.priority !== 'none' ? <span className="text-muted-foreground"> · {t.priority}</span> : null}</li>)}
        </ul>
      ) : null}
      {x.kind === 'goal' && p.goal && (
        <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          {p.goal.title}{p.goal.measure ? <span className="text-muted-foreground"> · measured by {p.goal.measure}</span> : null}{p.goal.due ? <span className="text-muted-foreground"> · by {p.goal.due}</span> : null}
        </p>
      )}
      {x.kind === 'other' && p.details && <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">{p.details}</p>}
      {isClose && (
        <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {x.role.name} wants to close {p.target?.label ?? 'this'}{p.confidence ? ` (confidence ${p.confidence}/10)` : ''}.{p.concern ? ` It needs you because ${p.concern}.` : ''}
        </p>
      )}

      {pending ? (
        <>
          {replying && (
            <Textarea rows={2} value={reply} maxLength={4000} onChange={(e) => setReply(e.target.value)} autoFocus aria-label={`Your reply to ${x.role.name}`}
              placeholder={`Tell ${x.role.name} what you think. It goes into its notebook either way.`} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>{decide.isPending && decide.variables ? <Spinner /> : <Check />}{isClose ? 'Close it' : 'Approve'}</Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}><X />{isClose ? 'Keep open' : 'Reject'}</Button>
            {!replying && <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>Reply…</Button>}
            <span className="ml-auto text-xs text-muted-foreground">{x.kind === 'code' ? 'Approving starts Claude on its own branch, as you.' : x.kind === 'other' ? 'Approving makes it a task for you.' : isClose ? 'Closing is logged and can be reopened.' : ''}</span>
          </div>
        </>
      ) : (
        <div className={cn('text-sm', x.status === 'rejected' ? 'text-destructive' : x.status === 'expired' ? 'text-muted-foreground' : 'text-live')}>
          {x.status === 'done' ? (x.decidedBy ? `Approved by ${x.decidedBy}` : x.decidedByRole ? `Approved by ${x.decidedByRole} (lead)` : 'Done on its own')
            : x.status === 'rejected' ? `Rejected by ${x.decidedBy ?? (x.decidedByRole ? `${x.decidedByRole} (lead)` : 'someone')}` : 'Expired without an answer'}
          {x.decidedAt ? `, ${relativeTime(x.decidedAt)}` : ''}
          {x.reply && <span className="text-muted-foreground">: "{x.reply}"</span>}
          {x.outcome && <div className="mt-1 text-foreground"><Prose text={x.outcome} /></div>}
        </div>
      )}
    </article>
  )
}

/** One project's card on the Approvals landing: how many wait, how many are done, and who's waiting. */
function ProjectCard({ p }: { p: ApprovalProject }) {
  return (
    <Link to="/approvals/$slug" params={{ slug: p.slug }}
      className={cn('flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40', p.pending > 0 && 'border-attention/40')}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{p.name}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {p.decided > 0 && `${p.decided} decided · `}latest {relativeTime(p.lastAt)}
          </div>
        </div>
        {p.pending > 0
          ? <span className="shrink-0 rounded-full bg-attention-soft px-2.5 py-0.5 text-xs font-semibold text-attention-foreground">{p.pending} waiting</span>
          : <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">All clear</span>}
        <ChevronRight className="-mr-1 size-4 shrink-0 text-muted-foreground" />
      </div>
      {p.roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {p.roles.map((r) => (
            <span key={r.id} className="flex items-center gap-1.5">
              <RoleMark id={r.id} name={r.name} className="size-6 rounded-md text-[9px]" />
              <span className="text-muted-foreground">{r.name}</span>
            </span>
          ))}
        </div>
      )}
    </Link>
  )
}

/** The projects your AI team needs a person for: open one to answer its approvals. */
export function ApprovalsPage() {
  useLiveTeam()
  const q = useQuery(approvalProjectsQuery)
  return (
    <>
      <PageHeader title="Approvals" description="Projects your AI team needs a person for" />
      <PageBody>
        <ErrorAlert error={q.error} />
        {!q.data ? <Skeleton className="h-40" /> : q.data.projects.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {q.data.projects.map((p) => <ProjectCard key={p.slug} p={p} />)}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nothing waiting. When a role wants a coding job, a new goal, or something only people can do, it shows up here and on your phone.
          </p>
        )}
      </PageBody>
    </>
  )
}

/** One project's approvals: what's unanswered up top, with the decided ones tucked away below. */
export function ApprovalsProjectPage() {
  const { slug } = useParams({ from: '/app/approvals/$slug' })
  useLiveTeam()
  const pending = useQuery(approvalsQuery('pending', slug))
  const decided = useQuery(approvalsQuery('decided', slug))
  const name = pending.data?.proposals[0]?.project.name ?? decided.data?.proposals[0]?.project.name ?? slug
  const waiting = pending.data?.proposals ?? []
  const done = decided.data?.proposals ?? []
  const cleared = done.filter((x) => x.decidedByRole).length
  return (
    <>
      <PageHeader title={name} description="Approvals" back="/approvals" />
      <PageBody>
        <ErrorAlert error={pending.error} />
        {!pending.data ? <Skeleton className="h-48" /> : (
          <Section title={waiting.length ? `Pending (${waiting.length})` : 'Pending'} description="Unanswered — waiting for a person.">
            {waiting.length ? (
              <div className="flex max-w-3xl flex-col gap-3">
                {waiting.map((x) => <ProposalCard key={x.id} x={x} showProject={false} />)}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing waiting in this project.</p>
            )}
            {cleared > 0 && <p className="mt-3 text-xs text-muted-foreground">{cleared} routine {cleared === 1 ? 'proposal' : 'proposals'} cleared by the lead for the team.</p>}
          </Section>
        )}
        {done.length > 0 && (
          <details className="max-w-3xl rounded-xl border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Completed approvals ({done.length})</summary>
            <div className="flex flex-col gap-3 px-4 pb-4">
              {done.map((x) => <ProposalCard key={x.id} x={x} showProject={false} />)}
            </div>
          </details>
        )}
      </PageBody>
    </>
  )
}

/** The count beside Approvals in the sidebar. */
export function ApprovalsBadge() {
  useLiveTeam()
  const n = useQuery(approvalsCountQuery).data?.pending ?? 0
  return n > 0 ? <SidebarMenuBadge className="bg-attention-soft text-attention-foreground">{n}</SidebarMenuBadge> : null
}
