import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { CLOSED_AS, firstLine, nextLabel, roleMark, roleTone, teamQuery, useLiveTeam, type CloseAs, type Role, type Team } from './data'
import { RoleDialog } from './RoleDialog'
import { Sources } from './Sources'
import { Prose } from '../claude/Prose'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { confirmAction } from '@/components/app/confirm'

/** A project's AI team: its roles, the brief and decisions they work from, and the journal of what happened. */
export function TeamTab({ slug }: { slug: string }) {
  useLiveTeam()
  const q = useQuery(teamQuery(slug))
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data) return <Skeleton className="h-64" />
  return q.data.enabled ? <TeamView t={q.data} /> : <TurnOn slug={slug} name={q.data.project.name} />
}

function TurnOn({ slug, name }: { slug: string; name: string }) {
  const qc = useQueryClient()
  const on = useMutation({
    // Schedules read in the time zone of whoever turns Team on.
    mutationFn: () => unwrap(api.api.team.projects[':slug'].$put({ param: { slug }, json: { enabled: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
    onError: (e) => toast.error(e.message),
  })
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Users /></EmptyMedia>
        <EmptyTitle>An AI team for {name}</EmptyTitle>
        <EmptyDescription>
          Roles like a CEO, CTO or Marketing that know this project, work on their own, keep notes and tell you what to do next.
          They run as you, on your Claude plan. They can read and suggest; they can't change code, publish or spend.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button disabled={on.isPending} onClick={() => on.mutate()}>Turn on Team</Button></EmptyContent>
    </Empty>
  )
}

function TeamView({ t }: { t: Team }) {
  const slug = t.project.slug
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const off = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].$put({ param: { slug }, json: { enabled: false } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  })
  const pause = useMutation({
    mutationFn: (paused: boolean) => unwrap(api.api.team.projects[':slug'].settings.$put({ param: { slug }, json: { paused } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
    onError: (e) => toast.error(e.message),
  })
  return (
    <div className="flex flex-col gap-6">
      {t.pending > 0 && (
        <Link to="/approvals" className="flex flex-wrap items-center gap-3 rounded-xl border border-attention/40 bg-attention-soft px-4 py-3 text-attention-foreground dark:bg-attention/10 dark:text-attention">
          <StatusLight state="waiting" />
          <span className="font-medium">{t.pending === 1 ? '1 thing is' : `${t.pending} things are`} waiting for your approval</span>
          <span className="ml-auto text-sm font-medium">Review →</span>
        </Link>
      )}
      {t.paused && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm">
          <span>The team is paused: no role works on its own until you resume it. You can still chat and run shifts by hand.</span>
          <Button size="sm" className="ml-auto" disabled={pause.isPending} onClick={() => pause.mutate(false)}>Resume team</Button>
        </div>
      )}
      {t.digest && (
        <Link to="/projects/$slug/team/$role" params={{ slug, role: String(t.digest.role.id) }} className="flex flex-col gap-2 rounded-xl border p-4 hover:bg-accent/30">
          <div className="flex items-center gap-2.5 text-sm">
            <RoleMark id={t.digest.role.id} name={t.digest.role.name} className="size-7 rounded-md text-[10px]" />
            <span className="font-medium">{t.digest.role.name}'s digest</span>
            <span className="text-muted-foreground">{relativeTime(t.digest.at)}</span>
          </div>
          <div className="line-clamp-6 text-sm"><Prose text={t.digest.report} /></div>
        </Link>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Block title="Roles" action={t.roles.length > 0 && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />New role</Button>}>
            {t.roles.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {t.roles.map((r) => <RoleCard key={r.id} slug={slug} r={r} />)}
              </div>
            ) : (
              <button onClick={() => setAdding(true)} className="flex flex-col items-center gap-1 rounded-xl border border-dashed p-8 text-center hover:bg-accent/40">
                <Plus className="size-5 text-muted-foreground" />
                <span className="font-medium">Add the first role</span>
                <span className="text-sm text-muted-foreground">Start with a CEO: it looks at the whole project and says what matters next.</span>
              </button>
            )}
          </Block>
          {t.roles.length > 0 && <Threads slug={slug} threads={t.threads} roles={t.roles} />}
          <Block title="Journal" description="What happened in the project. Claude sessions get a short summary after each stretch of work.">
            {t.journal.length ? (
              <ol className="flex flex-col divide-y rounded-xl border">
                {t.journal.map((j) => (
                  <li key={j.id} className="flex gap-3 px-3.5 py-2.5 text-sm">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(j.at)}</span>
                    <span className="min-w-0">
                      {j.who && <span className="text-muted-foreground">{j.who}{j.kind === 'session' ? "'s Claude" : ''}: </span>}
                      {j.url ? <a href={j.url} className="hover:underline">{j.text}</a> : j.text}
                    </span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">Nothing yet. Work in this project's Claude sessions shows up here.</p>}
          </Block>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Priorities slug={slug} priorities={t.priorities} />
          <Goals slug={slug} goals={t.goals} />
          <Brief slug={slug} brief={t.brief} />
          <Decisions slug={slug} decisions={t.decisions} />
          <Sources slug={slug} sources={t.sources} />
          <CloseGuard slug={slug} guard={t.closeGuard} />
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Roles run as {t.runsAs?.name}, on their Claude plan. Schedules use {t.tz.replace('_', ' ')} time.</span>
        {!t.paused && <button className="underline-offset-2 hover:underline" disabled={pause.isPending} onClick={() => pause.mutate(true)}>Pause team</button>}
        <button className="underline-offset-2 hover:underline" disabled={off.isPending}
          onClick={() => void confirmAction({ title: 'Turn off Team for this project?', description: 'Roles stop working; their notes and history stay.', action: 'Turn off', destructive: true }).then((ok) => { if (ok) off.mutate() })}>
          Turn off Team
        </button>
      </p>
      <RoleDialog open={adding} onOpenChange={setAdding} slug={slug}
        onSaved={(id) => void navigate({ to: '/projects/$slug/team/$role', params: { slug, role: String(id) } })} />
    </div>
  )
}

function Block({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function RoleMark({ id, name, className }: { id: number; name: string; className?: string }) {
  return <div aria-hidden className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold', roleTone(id), className)}>{roleMark(name)}</div>
}

/** How a closed thread ended: Done, Declined, Duplicate, Not needed, Handled elsewhere. */
export function OutcomeBadge({ as, className }: { as: CloseAs | null; className?: string }) {
  const o = CLOSED_AS[as ?? 'done']
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', o.tone, className)}>{o.label}</span>
}

function RoleCard({ slug, r }: { slug: string; r: Role }) {
  const last = r.lastShift
  return (
    <Link to="/projects/$slug/team/$role" params={{ slug, role: String(r.id) }}
      className={cn('flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40', r.working && 'border-live/40')}>
      <div className="flex items-center gap-3">
        <RoleMark id={r.id} name={r.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{r.name}</div>
          {r.summary && <div className="truncate text-xs text-muted-foreground">{r.summary}</div>}
        </div>
        {r.working
          ? <span className="flex shrink-0 items-center gap-1.5 text-xs text-live"><StatusLight state="live" />Working</span>
          : <span className="shrink-0 text-xs text-muted-foreground">{r.paused ? 'Paused' : 'Idle'}</span>}
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        {r.shift ? `On a shift since ${relativeTime(r.shift.startedAt)}.`
          : last ? `${relativeTime(last.at)}: ${firstLine(last.report) || (last.status === 'error' ? 'Stopped with an error.' : 'Finished.')}`
          : 'No shifts yet. Open it to run one or chat.'}
      </p>
      <p className="mt-auto flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{r.nextShiftAt ? `Next: ${nextLabel(r.nextShiftAt)}` : r.paused ? 'Paused' : r.schedule.length ? 'Team paused' : 'No schedule'}</span>
        {r.model && <span className="capitalize">{r.model}</span>}
      </p>
    </Link>
  )
}

/** Issues the team is working through. People can open one too, for a role to pick up. */
function Threads({ slug, threads, roles }: { slug: string; threads: Team['threads']; roles: Team['roles'] }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ to: '', title: '', body: '' })
  const start = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].threads.$post({ param: { slug }, json: { to: f.to || undefined, title: f.title, body: f.body, kind: 'request' } })),
    onSuccess: (r) => { setOpen(false); setF({ to: '', title: '', body: '' }); void navigate({ to: '/projects/$slug/team/threads/$thread', params: { slug, thread: String(r.thread) } }) },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Block title="Threads" description="Issues roles, sessions and people raise. One owner, everyone involved in one place."
      action={<div className="flex gap-1">
        <Button size="sm" variant="ghost" asChild><Link to="/projects/$slug/team/threads" params={{ slug }}>All threads</Link></Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Plus />New</Button>
      </div>}>
      {threads.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {threads.map((x) => (
            <li key={x.id}>
              <Link to="/projects/$slug/team/threads/$thread" params={{ slug, thread: String(x.id) }} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm hover:bg-accent/40', x.status === 'resolved' && 'opacity-60')}>
                <StatusLight state={x.status === 'resolved' ? 'idle' : x.needsPeople ? 'waiting' : 'live'} />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">#{x.id}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{x.title}</span>
                {x.status !== 'resolved' && x.priority === 'blocker' && <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">Blocker</span>}
                {x.status === 'resolved' && <OutcomeBadge as={x.closedAs} />}
                <span className="text-xs text-muted-foreground">
                  {x.status === 'resolved' ? (x.closedBy ? `By ${x.closedBy}` : 'Closed') : x.needsPeople ? 'Needs you' : x.owner ? x.owner.name : 'Nobody owns it'} · {x.messages} {x.messages === 1 ? 'message' : 'messages'} · {relativeTime(x.lastAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">None yet. A role, a Claude session or you can raise one, e.g. "views but no likes on the last videos".</p>}
      <ResponsiveDialog open={open} onOpenChange={setOpen} title="New thread" description="Raise something for a role to look into. It starts on it right away.">
        <form className="pb-2" onSubmit={(e) => { e.preventDefault(); if (f.title.trim() && f.body.trim()) start.mutate() }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="th-to">For</FieldLabel>
              <NativeSelect id="th-to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
                <option value="">The lead</option>
                {roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="th-title">What about</FieldLabel>
              <Input id="th-title" className="h-10" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Sign-ups dropped this week" />
            </Field>
            <Field>
              <FieldLabel htmlFor="th-body">Message</FieldLabel>
              <Textarea id="th-body" rows={4} value={f.body} maxLength={8000} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="What you noticed, and what you want to know or done." />
            </Field>
            <Button type="submit" className="h-10" disabled={!f.title.trim() || !f.body.trim() || start.isPending}>Start thread</Button>
          </FieldGroup>
        </form>
      </ResponsiveDialog>
    </Block>
  )
}

function Goals({ slug, goals }: { slug: string; goals: Team['goals'] }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [g, setG] = useState({ title: '', measure: '', due: '' })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const add = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].goals.$post({ param: { slug }, json: { title: g.title, measure: g.measure, due: g.due || null } })),
    onSuccess: () => { setG({ title: '', measure: '', due: '' }); setAdding(false); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const update = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'done' | 'dropped' | 'active' }) => unwrap(api.api.team.goals[':id'].$patch({ param: { id: String(id) }, json: { status } })),
    onSuccess: refresh,
  })
  const today = new Date().toISOString().slice(0, 10)
  return (
    <Block title="Goals" description="What the team works towards. Roles propose goals and report progress."
      action={!adding && <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus />Add</Button>}>
      {adding && (
        <form className="flex flex-col gap-2 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); if (g.title.trim()) add.mutate() }}>
          <Input className="h-9" value={g.title} maxLength={200} onChange={(e) => setG({ ...g, title: e.target.value })} placeholder="v1 on the Play Store" aria-label="Goal" autoFocus />
          <Input className="h-9" value={g.measure} maxLength={300} onChange={(e) => setG({ ...g, measure: e.target.value })} placeholder="How we know: live in the store" aria-label="Measure" />
          <div className="flex gap-2">
            <Input className="h-9" type="date" value={g.due} onChange={(e) => setG({ ...g, due: e.target.value })} aria-label="Due date" />
            <Button size="sm" className="h-9" type="submit" disabled={!g.title.trim() || add.isPending}>Add goal</Button>
            <Button size="sm" className="h-9" type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {goals.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {goals.map((x) => {
            const late = x.status === 'active' && x.due && x.due < today
            return (
              <li key={x.id} className={cn('group flex flex-col gap-2 px-3.5 py-3 text-sm', x.status !== 'active' && 'opacity-60')}>
                <div className="flex items-start gap-2">
                  <span className={cn('min-w-0 flex-1 font-medium', x.status === 'done' && 'line-through')}>{x.title}</span>
                  {x.due && <span className={cn('shrink-0 text-xs', late ? 'text-destructive' : 'text-muted-foreground')}>{late ? 'Late · ' : ''}{x.due}</span>}
                </div>
                {x.status === 'active' && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground" style={{ width: `${x.progress}%` }} />
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    {x.status === 'active' ? `${x.progress}%` : x.status === 'done' ? 'Done' : 'Dropped'}
                    {x.note ? ` · ${x.note}` : x.measure ? ` · ${x.measure}` : ''}{x.owner ? ` · ${x.owner}` : ''}
                  </span>
                  {x.status === 'active' ? (
                    <span className="flex shrink-0 gap-1">
                      <button className="hover:text-foreground hover:underline" onClick={() => update.mutate({ id: x.id, status: 'done' })}>Done</button>
                      <button className="hover:text-foreground hover:underline" onClick={() => update.mutate({ id: x.id, status: 'dropped' })}>Drop</button>
                    </span>
                  ) : <button className="shrink-0 hover:text-foreground hover:underline" onClick={() => update.mutate({ id: x.id, status: 'active' })}>Reopen</button>}
                </div>
              </li>
            )
          })}
        </ul>
      ) : !adding && <p className="text-sm text-muted-foreground">No goals yet. Add one, or let the CEO propose some.</p>}
    </Block>
  )
}

/** What matters now, in the founder's words. It outranks the roles' own plans in every role's context. */
function Priorities({ slug, priorities }: { slug: string; priorities: string }) {
  const qc = useQueryClient()
  const [body, setBody] = useState(priorities)
  const [editing, setEditing] = useState(!priorities)
  useEffect(() => setBody(priorities), [priorities])
  const save = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].priorities.$put({ param: { slug }, json: { body } })),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['team'] }) },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Block title="What matters now" description="Your priorities, in your words. Every role weighs these above its own plans."
      action={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Textarea rows={4} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} aria-label="What matters now"
            placeholder={'Fix the crashes users are hitting before anything else.\nHold the test build until login works.'} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={save.isPending || body.trim() === priorities}>Save</Button>
            {priorities && <Button size="sm" type="button" variant="ghost" onClick={() => { setBody(priorities); setEditing(false) }}>Cancel</Button>}
          </div>
        </form>
      ) : priorities ? (
        <div className="rounded-xl border border-attention/40 bg-attention-soft p-3.5 text-sm whitespace-pre-wrap text-attention-foreground dark:bg-attention/10 dark:text-attention">{priorities}</div>
      ) : (
        <button onClick={() => setEditing(true)} className="rounded-xl border border-dashed p-3.5 text-left text-sm text-muted-foreground hover:bg-accent/40">
          Say what matters most right now, so the team works on that first.
        </button>
      )}
    </Block>
  )
}

/** The founder's per-project guard: which closes always need a person, whatever a role's confidence. */
function CloseGuard({ slug, guard }: { slug: string; guard: Team['closeGuard'] }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: Partial<Team['closeGuard']>) => unwrap(api.api.team.projects[':slug']['close-guard'].$put({ param: { slug }, json: patch })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
    onError: (e) => toast.error(e.message),
  })
  const rows: [keyof Team['closeGuard'], string, string][] = [
    ['money', 'Spends money', 'Pricing, billing, budgets, payouts.'],
    ['production', 'Touches production', 'Deploys, releases, incidents, going live.'],
    ['person_decision', "A person's decision", 'A choice a person made or owns, not a status.'],
  ]
  return (
    <Block title="Always ask before closing" description="Whatever a role's confidence, these closes come to you as a one-tap Close? Yes/No.">
      <div className="flex flex-col gap-3">
        {rows.map(([k, label, hint]) => (
          <label key={k} className="flex items-start justify-between gap-3 text-sm">
            <span><span className="font-medium">{label}</span><br /><span className="text-muted-foreground">{hint}</span></span>
            <Switch checked={guard[k]} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ [k]: v })} aria-label={label} />
          </label>
        ))}
      </div>
    </Block>
  )
}

function Brief({ slug, brief }: { slug: string; brief: Team['brief'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState(brief.body)
  const [editing, setEditing] = useState(!brief.body)
  useEffect(() => setBody(brief.body), [brief.body])
  const save = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].brief.$put({ param: { slug }, json: { body } })),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['team'] }) },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Block title="Brief" description="What this is, who it's for, and where it stands. Every role reads it first."
      action={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Brief"
            placeholder={'Shop is an Android app for … \nFor: …\nStage: beta, aiming for v1 on the Play Store by …'} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={save.isPending || body.trim() === brief.body}>Save brief</Button>
            {brief.body && <Button size="sm" type="button" variant="ghost" onClick={() => { setBody(brief.body); setEditing(false) }}>Cancel</Button>}
          </div>
        </form>
      ) : (
        <div className="rounded-xl border p-3.5 text-sm whitespace-pre-wrap">
          {brief.body}
          {brief.updatedBy && brief.updatedAt && <p className="mt-2 text-xs text-muted-foreground">{brief.updatedBy}, {relativeTime(brief.updatedAt)}</p>}
        </div>
      )}
    </Block>
  )
}

function Decisions({ slug, decisions }: { slug: string; decisions: Team['decisions'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const add = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].decisions.$post({ param: { slug }, json: { body } })),
    onSuccess: () => { setBody(''); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => unwrap(api.api.team.projects[':slug'].decisions[':id'].$delete({ param: { slug, id: String(id) } })),
    onSuccess: refresh,
  })
  return (
    <Block title="Decisions" description="Settled, so nobody argues them again.">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate() }}>
        <Input className="h-9" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="No paid ads before v1" aria-label="New decision" />
        <Button size="sm" className="h-9" type="submit" disabled={!body.trim() || add.isPending}>Add</Button>
      </form>
      {decisions.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {decisions.map((d) => (
            <li key={d.id} className="group flex items-start gap-2 px-3.5 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p>{d.body}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{d.by ?? 'Someone'}, {relativeTime(d.at)}</p>
              </div>
              <Button size="icon" variant="ghost" className="size-7 shrink-0 opacity-60 hover:opacity-100" aria-label="Remove decision" onClick={() => remove.mutate(d.id)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  )
}
