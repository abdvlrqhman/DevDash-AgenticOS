import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Check, ChevronRight, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
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
    <article className="flex flex-col gap-3 rounded-2xl bg-surface p-4 md:p-5">
      <div className="flex items-center gap-2.5 text-sm">
        <RoleMark id={x.role.id} name={x.role.name} className="size-7 rounded-lg text-[10px]" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{x.role.name}</span>
          <span className="text-muted-foreground">
            {showProject && <>, in <Link to="/projects/$slug" params={{ slug: x.project.slug }} className="underline-offset-4 hover:underline">{x.project.name}</Link></>}
            , {relativeTime(x.createdAt)}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-background px-2.5 py-0.5 text-xs font-medium">{KIND_LABELS[x.kind] ?? x.kind}</span>
      </div>
      <h3 className="text-lg leading-snug font-semibold tracking-[-0.015em] text-balance">{x.title}</h3>
      {x.why && <div className="text-sm text-foreground/85"><Prose text={x.why} /></div>}
      {x.kind === 'code' && p.prompt && (
        <details className="group rounded-xl bg-background text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-muted-foreground transition-colors duration-150 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 shrink-0 transition-transform duration-300 ease-spring group-open:rotate-90" />What the agent will be asked to do
          </summary>
          <div className="px-3 pb-3 pl-9 whitespace-pre-wrap">{p.prompt}</div>
        </details>
      )}
      {x.kind === 'task' && p.tasks?.length ? (
        <ul className="flex flex-col gap-1.5 rounded-xl bg-background px-3 py-2.5 text-sm">
          {p.tasks.map((t, i) => <li key={i}>{t.title}{t.priority && t.priority !== 'none' ? <span className="text-muted-foreground">, {t.priority} priority</span> : null}</li>)}
        </ul>
      ) : null}
      {x.kind === 'goal' && p.goal && (
        <p className="rounded-xl bg-background px-3 py-2.5 text-sm">
          {p.goal.title}{p.goal.measure ? <span className="text-muted-foreground">, measured by {p.goal.measure}</span> : null}{p.goal.due ? <span className="text-muted-foreground">, by {p.goal.due}</span> : null}
        </p>
      )}
      {x.kind === 'other' && p.details && <p className="rounded-xl bg-background px-3 py-2.5 text-sm whitespace-pre-wrap">{p.details}</p>}
      {isClose && (
        <p className="rounded-xl bg-background px-3 py-2.5 text-sm text-muted-foreground">
          {x.role.name} wants to close {p.target?.label ?? 'this'}{p.confidence ? ` (confidence ${p.confidence}/10)` : ''}.{p.concern ? ` It needs you because ${p.concern}.` : ''}
        </p>
      )}

      {pending ? (
        <>
          {replying && (
            <Textarea rows={2} value={reply} maxLength={4000} onChange={(e) => setReply(e.target.value)} autoFocus aria-label={`Your reply to ${x.role.name}`}
              className="bg-background dark:bg-background" placeholder={`Tell ${x.role.name} what you think. It goes into its notebook either way.`} />
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>{decide.isPending && decide.variables ? <Spinner /> : <Check />}{isClose ? 'Close it' : 'Approve'}</Button>
            <Button size="sm" variant="outline" className="bg-background hover:bg-surface-2" disabled={decide.isPending} onClick={() => decide.mutate(false)}><X />{isClose ? 'Keep open' : 'Reject'}</Button>
            {!replying && <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>Reply…</Button>}
            <span className="basis-full text-xs text-pretty text-muted-foreground sm:ml-auto sm:basis-auto">{x.kind === 'code' ? 'Approving starts Claude on its own branch, as you.' : x.kind === 'other' ? 'Approving makes it a task for you.' : isClose ? 'Closing is logged and can be reopened.' : ''}</span>
          </div>
        </>
      ) : (
        <div className={cn('flex items-start gap-2 text-sm', x.status === 'expired' && 'text-muted-foreground')}>
          {x.status === 'done' ? <Check className="mt-0.5 size-4 shrink-0" /> : x.status === 'rejected' ? <X className="mt-0.5 size-4 shrink-0" /> : null}
          <div className="min-w-0 flex-1">
            {x.status === 'done' ? (x.decidedBy ? `Approved by ${x.decidedBy}` : x.decidedByRole ? `Approved by ${x.decidedByRole} (lead)` : 'Done on its own')
              : x.status === 'rejected' ? `Rejected by ${x.decidedBy ?? (x.decidedByRole ? `${x.decidedByRole} (lead)` : 'someone')}` : 'Expired without an answer'}
            {x.decidedAt ? `, ${relativeTime(x.decidedAt)}` : ''}
            {x.reply && <span className="text-muted-foreground">: "{x.reply}"</span>}
            {x.outcome && <div className="mt-1.5 text-muted-foreground"><Prose text={x.outcome} /></div>}
          </div>
        </div>
      )}
    </article>
  )
}

/** One project's card on the Approvals landing: how many wait, how many are done, and who's waiting. */
function ProjectCard({ p }: { p: ApprovalProject }) {
  return (
    <Link to="/approvals/$slug" params={{ slug: p.slug }}
      className="flex h-full min-w-0 flex-col gap-5 rounded-2xl bg-surface p-4 transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.98]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg leading-tight font-semibold tracking-[-0.02em]">{p.name}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {p.decided > 0 && `${p.decided} decided, `}latest {relativeTime(p.lastAt)}
          </div>
        </div>
        {p.pending > 0
          ? <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-attention-soft px-2.5 py-1 text-xs font-medium text-attention-foreground tabular-nums"><StatusLight state="waiting" className="size-2" />{p.pending} waiting</span>
          : <span className="shrink-0 py-1 text-xs text-muted-foreground">All clear</span>}
      </div>
      {p.roles.length > 0 && (
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
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

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** The projects your AI team needs a person for: open one to answer its approvals. */
export function ApprovalsPage() {
  useLiveTeam()
  const q = useQuery(approvalProjectsQuery)
  const projects = q.data?.projects ?? []
  const waiting = projects.reduce((n, p) => n + p.pending, 0)
  return (
    <>
      <PageHeader title="Approvals" description="Projects your AI team needs a person for" />
      <PageBody className="gap-8 md:py-10">
        <ErrorAlert error={q.error} />
        {!q.data ? <Skeleton className="h-40 rounded-2xl bg-surface" /> : projects.length ? (
          <>
            <h2 className={cn('max-w-[26ch] text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.25rem]', !waiting && 'text-muted-foreground')}>
              {waiting ? `${WORDS[waiting] ?? waiting} ${waiting === 1 ? 'proposal is' : 'proposals are'} waiting for a person.` : 'Nothing is waiting for a person.'}
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => <ProjectCard key={p.slug} p={p} />)}
            </div>
          </>
        ) : (
          <p className="rounded-2xl bg-surface px-6 py-10 text-center text-sm text-pretty text-muted-foreground">
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
      <PageBody className="gap-10 md:py-10">
        <ErrorAlert error={pending.error} />
        {!pending.data ? <Skeleton className="h-48 max-w-3xl rounded-2xl bg-surface" /> : (
          <section className="flex max-w-3xl flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.01em]">Pending{waiting.length > 0 && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{waiting.length}</span>}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Unanswered, waiting for a person.</p>
            </div>
            {waiting.length ? (
              <div className="flex flex-col gap-3">
                {waiting.map((x) => <ProposalCard key={x.id} x={x} showProject={false} />)}
              </div>
            ) : (
              <p className="rounded-2xl bg-surface px-6 py-8 text-center text-sm text-muted-foreground">Nothing waiting in this project.</p>
            )}
            {cleared > 0 && <p className="text-xs text-muted-foreground">{cleared} routine {cleared === 1 ? 'proposal' : 'proposals'} cleared by the lead for the team.</p>}
          </section>
        )}
        {done.length > 0 && (
          <details className="group max-w-3xl">
            <summary className="-mx-3 flex w-fit cursor-pointer list-none items-center gap-2 rounded-full px-3 py-1.5 text-base font-semibold tracking-[-0.01em] transition-colors duration-150 hover:bg-surface [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-spring group-open:rotate-90" />
              Completed approvals<span className="font-normal text-muted-foreground tabular-nums">{done.length}</span>
            </summary>
            <div className="mt-3 flex flex-col gap-3">
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
