import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { BadgeCheck, Bot, ChevronRight, Copy, GitBranch, GitCommitHorizontal, KeyRound, Lock, Plus, RefreshCw, Search, Share2, Sparkles, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabCount, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorAlert } from '../auth/LoginPage'
import { projectSessionsQuery, relativeTime, STATUS_LABEL, useLiveProjectSessions, type ProjectSession, type Session } from '../claude/data'
import { NewSession } from '../claude/SessionsPage'
import { CAPS, capsLabel, projectCapsQuery, type Cap } from '../claude/ShareDialog'
import { Board } from '../work/Board'
import { activityQuery, commitsQuery, notesQuery, projectQuery, STATUSES, tasksQuery, useLiveWork, type SessionSharing, type Task } from '../work/data'
import { StatusIcon, TaskRow } from '../work/TaskBits'
import { cn } from '@/lib/utils'
import { ActivityList } from '../work/Activity'
import { NoteList } from '../notes/NotesPage'
import { repoLabel } from './ProjectsPage'
import { BuildsTab } from '../builds/BuildsTab'
import { api, unwrap } from '@/lib/api'
import { PinButton } from '../pins/pins'
import { TeamTab } from '../team/TeamTab' // Team (optional)
import { deliveriesQuery, ReadyToReview, useLiveDeliveries } from './ReadyToReview'

/** Keyed by the URL, so moving to another one starts from a clean slate. */
export function ProjectPage() {
  const p = useParams({ from: '/app/projects/$slug' })
  return <ProjectPageView key={p.slug} />
}

function ProjectPageView() {
  useLiveWork()
  const { slug } = useParams({ from: '/app/projects/$slug' })
  const qc = useQueryClient()
  const q = useQuery(projectQuery(slug))
  const tasks = useQuery(tasksQuery({ project: slug }))
  useLiveDeliveries(slug)
  const readyCount = useQuery(deliveriesQuery(slug)).data?.readyCount ?? 0
  const [session, setSession] = useState(false)
  // Coming back to a project (from a task, a run or a role) opens the tab you left.
  const [tab, setTabState] = useState(() => { try { return sessionStorage.getItem(`project-tab:${slug}`) ?? 'overview' } catch { return 'overview' } })
  const setTab = (v: string) => { setTabState(v); try { sessionStorage.setItem(`project-tab:${slug}`, v) } catch { /* private mode */ } }
  const fetchNow = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].fetch.$post({ param: { slug } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['projects'] }); toast.success('Fetched.') },
    onError: (e) => toast.error(e.message),
  })
  const p = q.data?.project

  if (q.error) return <><PageHeader title={slug} back="/projects" /><div className="p-4"><ErrorAlert error={q.error} /></div></>
  if (!p) return <><PageHeader title={slug} back="/projects" /><div className="p-4"><Skeleton className="h-40" /></div></>

  return (
    <>
      <PageHeader back="/projects" title={p.name}
        description={<span className="flex items-center gap-1.5"><span className="truncate font-mono">{repoLabel(p.repoUrl)}</span><GitBranch className="size-3.5 shrink-0" />{p.defaultBranch}</span>}
        actions={<>
          {p.repoUrl && <Button size="icon-sm" variant="ghost" aria-label="Fetch now" disabled={fetchNow.isPending} onClick={() => fetchNow.mutate()}><RefreshCw className={fetchNow.isPending ? 'animate-spin' : ''} /></Button>}
          <GuestCapsDefault slug={p.slug} />
          <PinButton kind="project" id={p.slug} />
          <Button size="sm" variant="outline" onClick={() => setSession(true)}><Sparkles /><span className="hidden sm:inline">Claude</span></Button>
        </>} />
      <PageBody>
        {p.fetchError && (
          <Alert variant="destructive"><AlertDescription>Couldn't fetch: {p.fetchError}</AlertDescription></Alert>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <button className="flex items-center gap-1 font-mono hover:text-foreground" onClick={() => void navigator.clipboard.writeText(p.path).then(() => toast.success('Path copied'))}>
            <Copy className="size-3.5" />{p.path}
          </button>
          {p.repoUrl && <span>{p.fetchedAt ? `Fetched ${relativeTime(p.fetchedAt)}` : 'Not fetched yet'}, every 5 minutes</span>}
          <span>Task numbers here are DevDash's own: <span className="font-mono">fixes #N</span> in a commit refers to {p.slug}#N.</span>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview{readyCount > 0 && <TabCount>{readyCount}</TabCount>}</TabsTrigger>
            <TabsTrigger value="tasks">Tasks{p.openTasks > 0 && <TabCount>{p.openTasks}</TabCount>}</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="sessions">
              Claude
              {p.live.working + p.live.waiting > 0 ? <StatusLight state={p.live.working ? 'live' : 'waiting'} /> : p.sessions > 0 && <TabCount>{p.sessions}</TabCount>}
            </TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="builds">Builds</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview slug={slug} live={p.live} tasks={tasks.data?.tasks} isGithub={/github\.com/.test(p.repoUrl ?? '')} instructions={p.instructions} onTab={setTab} onNew={() => setSession(true)} />
          </TabsContent>
          <TabsContent value="tasks">
            <ErrorAlert error={tasks.error} />
            {tasks.data && <Board tasks={tasks.data.tasks} project={slug} showProject={false} />}
          </TabsContent>
          <TabsContent value="notes"><ProjectNotes slug={slug} /></TabsContent>
          <TabsContent value="sessions"><ProjectSessions slug={slug} sharing={p.sessionSharing} onNew={() => setSession(true)} /></TabsContent>
          <TabsContent value="builds"><BuildsTab slug={slug} isGithub={/github\.com/.test(p.repoUrl ?? '')} /></TabsContent>
          <TabsContent value="commits"><Commits slug={slug} /></TabsContent>
          <TabsContent value="activity"><ProjectActivity slug={slug} /></TabsContent>
          <TabsContent value="team"><TeamTab slug={slug} /></TabsContent>
        </Tabs>
      </PageBody>
      <NewSession open={session} onClose={() => setSession(false)} initialProject={slug} />
    </>
  )
}

function ProjectNotes({ slug }: { slug: string }) {
  const notes = useQuery(notesQuery(slug))
  return (
    <Section action={<Button size="sm" variant="outline" asChild><Link to="/notes/$id" params={{ id: 'new' }} search={{ project: slug }}><StickyNote />New note</Link></Button>}>
      <ErrorAlert error={notes.error} />
      {notes.data && <NoteList notes={notes.data.notes} empty="No notes in this project yet. Pin decisions, setup steps and links here." />}
    </Section>
  )
}

const isActive = (s: Session) => s.status === 'working' || s.status === 'waiting'
const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')
// Working or waiting first, then the most recent.
const byUrgency = (a: Session, b: Session) => Number(isActive(b)) - Number(isActive(a)) || b.lastActivityAt - a.lastActivityAt
const firstName = (n: string) => n.split(' ')[0]!
const branch = (s: Session) => (s.worktree ? `dd/${s.worktree.split('/').pop()}` : null)

/** Whose it is: you, a teammate, or a team role (which runs as a person, but people know it by the role). */
function Who({ s }: { s: ProjectSession }) {
  if (s.kind === 'proposal' && s.role) return <span className="flex items-center gap-1"><BadgeCheck className="size-3.5" />{s.role.name}'s approval</span>
  if (s.role) return <span className="flex items-center gap-1"><Bot className="size-3.5" />{s.role.name}</span>
  if (s.kind === 'mine') return <span className="flex items-center gap-1">{s.audience !== 'private' ? <Share2 className="size-3" aria-label="Shared" /> : <Lock className="size-3" aria-label="Private" />}You</span>
  return <span>{firstName(s.owner.name)}</span>
}

function SessionRow({ s, nested }: { s: ProjectSession; nested?: boolean }) {
  return (
    <Link to="/claude/$id" params={{ id: s.id }} className={cn('flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50', nested && 'pl-9')}>
      <StatusLight state={light(s)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{s.title}</span>
        {(isActive(s) || s.status === 'error') && <span className="block text-xs text-muted-foreground">{STATUS_LABEL[s.status]}</span>}
      </span>
      {s.worktree && <span className="hidden shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground sm:flex"><GitBranch className="size-3.5" />{branch(s)}</span>}
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">{!nested && <><Who s={s} />,</>} {relativeTime(s.lastActivityAt)}</span>
    </Link>
  )
}

/** Many kindred sessions under one foldaway row, so dozens don't bury everything else: a role's shifts ("CEO · 14
 *  shifts"), or the sessions started off approved proposals ("From approvals · 3 sessions"). */
function SessionGroup({ icon, label, noun, sessions, open: forced }: { icon: ReactNode; label: string; noun: [string, string]; sessions: ProjectSession[]; open?: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open || !!forced
  const top = sessions[0]!
  const busy = sessions.some(isActive)
  return (
    <>
      <button onClick={() => setOpen(!shown)} aria-expanded={shown} className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-accent/50">
        <StatusLight state={busy ? light(top) : 'idle'} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">{icon}<span className="truncate">{label}</span>
            <span className="shrink-0 text-muted-foreground">· {sessions.length} {sessions.length === 1 ? noun[0] : noun[1]}</span></span>
          {busy && <span className="block text-xs text-muted-foreground">{STATUS_LABEL[top.status]}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">last {relativeTime(top.lastActivityAt)}</span>
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', shown && 'rotate-90')} />
      </button>
      {shown && <ul className="border-t bg-muted/30">{sessions.map((s) => <li key={s.id} className="border-b last:border-b-0"><SessionRow s={s} nested /></li>)}</ul>}
    </>
  )
}

type Group = { icon: ReactNode; label: string; noun: [string, string]; sessions: ProjectSession[] }
type Row = { key: string; at: Session } & ({ s: ProjectSession } | { group: Group })
/** Sessions in order, with each role's shifts and all approval-born sessions folded into one row that sits where its
 *  latest member would. */
function rows(sessions: ProjectSession[]): Row[] {
  const sorted = [...sessions].sort(byUrgency)
  const shifts = new Map<number, { role: { id: number; name: string }; list: ProjectSession[] }>()
  const proposals: ProjectSession[] = []
  const out: Row[] = []
  for (const s of sorted) {
    const role = s.role
    if (s.kind === 'shift' && role && 'id' in role) {
      const g = shifts.get(role.id) ?? { role, list: [] }
      g.list.push(s)
      shifts.set(role.id, g)
    } else if (s.kind === 'proposal') proposals.push(s)
    else out.push({ key: s.id, at: s, s })
  }
  for (const [id, g] of shifts) {
    out.push({ key: `shifts:${id}`, at: g.list[0]!, group: { icon: <Bot className="size-3.5 shrink-0 text-muted-foreground" />, label: g.role.name, noun: ['shift', 'shifts'], sessions: g.list } })
  }
  if (proposals.length) {
    out.push({ key: 'proposals', at: proposals[0]!, group: { icon: <BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" />, label: 'From approvals', noun: ['session', 'sessions'], sessions: proposals } })
  }
  return out.sort((a, b) => byUrgency(a.at, b.at))
}

function SessionList({ sessions, expand }: { sessions: ProjectSession[]; expand?: boolean }) {
  return (
    <ul className="overflow-hidden rounded-xl border">
      {rows(sessions).map((r) => (
        <li key={r.key} className="border-b last:border-b-0">
          {'s' in r ? <SessionRow s={r.s} /> : <SessionGroup {...r.group} open={expand} />}
        </li>
      ))}
    </ul>
  )
}

const FILTERS = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'mine', label: 'Mine', test: (s: ProjectSession) => s.kind === 'mine' },
  { value: 'teammates', label: 'Teammates', test: (s: ProjectSession) => s.kind === 'shared' },
  { value: 'roles', label: 'Team roles', test: (s: ProjectSession) => s.kind === 'role' || s.kind === 'shift' },
  { value: 'approvals', label: 'From approvals', test: (s: ProjectSession) => s.kind === 'proposal' },
] as const

/** "2 private sessions by Ahmed": counted by the server, never listed. */
function HiddenLine({ hidden, archived }: { hidden: { count: number; people: string[] }; archived: boolean }) {
  if (!hidden.count) return null
  const names = hidden.people.map(firstName)
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Lock className="size-3.5 shrink-0" />{hidden.count} {archived ? 'archived ' : ''}private {hidden.count === 1 ? 'session' : 'sessions'} by {who}
    </p>
  )
}

/** Everything in the project you may open, the roles' sessions too: filter by whose, search when there are many. */
function ProjectSessions({ slug, sharing, onNew }: { slug: string; sharing: SessionSharing; onNew: () => void }) {
  useLiveProjectSessions(slug)
  const [archived, setArchived] = useState(false)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all')
  const [q, setQ] = useState('')
  const list = useQuery(projectSessionsQuery(slug, archived))
  const all = list.data?.sessions ?? []
  const needle = q.trim().toLowerCase()
  const found = needle
    ? all.filter((s) => [s.title, s.owner.name, s.role?.name ?? '', branch(s) ?? ''].some((t) => t.toLowerCase().includes(needle)))
    : all
  const sessions = found.filter(FILTERS.find((f) => f.value === filter)!.test)
  return (
    <Section action={<div className="flex items-center gap-1"><SharingDefault slug={slug} sharing={sharing} /><Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button></div>}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Whose sessions">
          {FILTERS.map((f) => (
            <button key={f.value} onClick={() => setFilter(f.value)} aria-pressed={filter === f.value}
              className={cn('flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                filter === f.value && 'border-foreground/20 bg-foreground/10 text-foreground')}>
              {f.label}<span className="tabular-nums opacity-70">{found.filter(f.test).length}</span>
            </button>
          ))}
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" className="ml-auto" value={archived ? 'archived' : 'active'} onValueChange={(v) => v && setArchived(v === 'archived')}>
          <ToggleGroupItem value="active">Active</ToggleGroupItem>
          <ToggleGroupItem value="archived">Archived</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {(all.length > 8 || needle) && (
        <InputGroup>
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput aria-label="Search sessions" placeholder="Search titles, people, roles, branches" value={q} onChange={(e) => setQ(e.target.value)} />
        </InputGroup>
      )}
      <ErrorAlert error={list.error} />
      {list.isPending ? <Skeleton className="h-32 rounded-xl" />
        : sessions.length ? <SessionList sessions={sessions} expand={!!needle} />
        : <p className="text-sm text-muted-foreground">{needle ? 'No sessions match.' : filter !== 'all' ? 'None here.' : archived ? 'No archived sessions in this project.' : 'No Claude sessions in this project yet.'}</p>}
      {list.data && !needle && (filter === 'all' || filter === 'teammates') && <HiddenLine hidden={list.data.hidden} archived={archived} />}
    </Section>
  )
}

const SHARING: { value: SessionSharing; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'Only whoever starts a session sees it, until they share it.' },
  { value: 'shared', label: 'Shared', hint: 'Everyone can watch; only the owner, and whoever they let in, can send.' },
  { value: 'shared_can_send', label: 'Anyone can send', hint: 'Everyone can watch and send messages.' },
]

/** How new Claude sessions in the project start out, for everyone. Each one can still be changed when it starts or later. */
function SharingDefault({ slug, sharing }: { slug: string; sharing: SessionSharing }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (v: SessionSharing) => unwrap(api.api.projects[':slug'].$patch({ param: { slug }, json: { sessionSharing: v } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e) => toast.error(e.message),
  })
  const current = SHARING.find((o) => o.value === sharing)!
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="text-muted-foreground" aria-label={`New sessions here: ${current.label}`}>
          {sharing === 'private' ? <Lock /> : <Share2 />}<span className="max-sm:hidden">New: {current.label.toLowerCase()}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="font-medium">New Claude sessions here are</p>
        <ToggleGroup type="single" variant="outline" size="sm" className="mt-3 w-full" value={sharing} disabled={save.isPending}
          onValueChange={(v) => v && v !== sharing && save.mutate(v as SessionSharing)}>
          {SHARING.map((o) => <ToggleGroupItem key={o.value} value={o.value} className="flex-1">{o.label}</ToggleGroupItem>)}
        </ToggleGroup>
        <p className="mt-2 text-xs text-muted-foreground">{current.hint} For everyone's new sessions in this project; whoever starts one can still change it then or later.</p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Share permissions, in the project's header: what teammates' requests can use of mine without asking me, in my Claude
 * sessions here. Each member sets their own, and a session's Share dialog can still change it for that session.
 */
function GuestCapsDefault({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const q = useQuery(projectCapsQuery(slug))
  const save = useMutation({
    mutationFn: (caps: Cap[]) => unwrap(api.api.claude.projects[':slug']['guest-caps'].$put({ param: { slug }, json: { caps } })),
    onSuccess: (r) => qc.setQueryData(projectCapsQuery(slug).queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  const caps = q.data?.caps ?? []
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="text-muted-foreground" title={`Share permissions: ${capsLabel(caps)}`}
          aria-label={`Share permissions: ${capsLabel(caps)}`}>
          <span className="relative">
            <KeyRound />
            {caps.length > 0 && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" />}
          </span>
          <span className="hidden sm:inline">Share permissions</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="font-medium">Share permissions</p>
        <p className="mt-1 text-xs text-muted-foreground">In your Claude sessions in this project, teammates’ requests can use these of yours without asking you.</p>
        <div className="mt-3 flex flex-col divide-y rounded-md border">
          {CAPS.map((c) => (
            <label key={c.value} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{c.label}</span>
                <span className="text-xs text-muted-foreground">{c.what}</span>
              </span>
              <Switch checked={caps.includes(c.value)} disabled={!q.data || save.isPending} aria-label={`Share ${c.label}`}
                onCheckedChange={(on) => save.mutate(on ? [...caps, c.value] : caps.filter((x) => x !== c.value))} />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Off: Claude asks you. Yours only: everyone sets their own. A session’s Share dialog can still change it for that session.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** The project at a glance: whose Claude is on it now, where the tasks stand, the latest commits and activity. */
function Overview({ slug, live, tasks, isGithub, instructions, onTab, onNew }: {
  slug: string; live: { working: number; waiting: number; people: string[] }; tasks: Task[] | undefined; isGithub: boolean
  instructions: string; onTab: (tab: string) => void; onNew: () => void
}) {
  useLiveProjectSessions(slug)
  const active = (useQuery(projectSessionsQuery(slug, false)).data?.sessions ?? []).filter(isActive)
  // Private sessions of other people: counted by the server, never listed.
  const hidden = Math.max(0, live.working + live.waiting - active.length)
  const shown = new Set(active.map((s) => s.owner.name))
  const others = live.people.filter((n) => !shown.has(n)).map((n) => n.split(' ')[0])
  const open = (tasks ?? []).filter((t) => t.status !== 'done')
  const moving = open.filter((t) => t.status === 'in_progress' || t.status === 'review')
  const commits = useQuery(commitsQuery(slug))
  const activity = useQuery(activityQuery(slug))
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ReadyToReview slug={slug} isGithub={isGithub} className="md:col-span-2" />
      <ProjectInstructions slug={slug} instructions={instructions} className="md:col-span-2" />
      <Card title="Claude right now" className="md:col-span-2" action={<Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button>}>
        {active.length > 0 && <SessionList sessions={active} expand />}
        {hidden > 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <StatusLight state="live" />
            {hidden} private {hidden === 1 ? 'session' : 'sessions'} working here{others.length ? ` (${others.join(', ')})` : ''}
          </p>
        )}
        {!active.length && !hidden && <p className="text-sm text-muted-foreground">Nobody's Claude is working in this project right now.</p>}
        <button className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onTab('sessions')}>All sessions</button>
      </Card>

      <Card title="Tasks" action={<Button size="sm" variant="ghost" onClick={() => onTab('tasks')}>Board</Button>}>
        {!tasks ? <Skeleton className="h-24" /> : <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 xl:grid-cols-4">
            {STATUSES.filter((st) => st.value !== 'done').map((st) => (
              <button key={st.value} onClick={() => onTab('tasks')} className="flex min-w-0 flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left hover:bg-accent/50">
                <span className="text-lg font-semibold tabular-nums">{open.filter((t) => t.status === st.value).length}</span>
                <span className="flex w-full min-w-0 items-center gap-1 text-xs text-muted-foreground"><StatusIcon status={st.value} className="size-3.5" /><span className="truncate">{st.label}</span></span>
              </button>
            ))}
          </div>
          {moving.length > 0
            ? <div className="overflow-hidden rounded-xl border">{moving.slice(0, 6).map((t) => <TaskRow key={t.id} t={t} showProject={false} />)}</div>
            : <p className="text-sm text-muted-foreground">Nothing in progress or in review.</p>}
        </>}
      </Card>

      <Card title="Latest commits" action={<Button size="sm" variant="ghost" onClick={() => onTab('commits')}>All</Button>}>
        {commits.isPending ? <Skeleton className="h-24" /> : commits.error ? <ErrorAlert error={commits.error} />
          : !commits.data.commits.length ? <p className="text-sm text-muted-foreground">No commits yet.</p>
          : <CommitList commits={commits.data.commits.slice(0, 5)} />}
      </Card>

      <Card title="Activity" className="md:col-span-2" action={<Button size="sm" variant="ghost" onClick={() => onTab('activity')}>All</Button>}>
        {activity.data ? <ActivityList items={activity.data.activity.slice(0, 6)} /> : <Skeleton className="h-24" />}
      </Card>
    </div>
  )
}

/** A project's instructions: rules every Claude session here follows, like a Claude Project's instructions. */
function ProjectInstructions({ slug, instructions, className }: { slug: string; instructions: string; className?: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  const start = () => { setBody(instructions); setEditing(true) }
  const save = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].$patch({ param: { slug }, json: { instructions: body } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['projects'] }); setEditing(false); toast.success('Saved.') },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Card title="Instructions" className={className} action={!editing && <Button size="sm" variant="ghost" onClick={start}>{instructions ? 'Edit' : 'Add'}</Button>}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus rows={5} className="min-h-28 text-sm" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={'Rules every Claude session in this project follows. e.g. "You are a gold analyst. Follow these rules…"'} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Added to the system prompt of every Claude session here.</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setBody(instructions); setEditing(false) }}>Cancel</Button>
              <Button size="sm" disabled={save.isPending || body === instructions} onClick={() => save.mutate()}>Save</Button>
            </span>
          </div>
        </div>
      ) : instructions ? (
        <p className="max-h-48 overflow-auto whitespace-pre-wrap text-sm text-muted-foreground">{instructions}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No instructions yet. Add rules every Claude session in this project should follow — set once, like a Claude Project's instructions.</p>
      )}
    </Card>
  )
}

function Card({ title, action, className, children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 rounded-xl border p-4', className)}>
      <div className="flex min-h-8 items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  )
}

function Commits({ slug }: { slug: string }) {
  const q = useQuery(commitsQuery(slug))
  if (q.isPending) return <Skeleton className="h-40" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.commits.length) return <p className="text-sm text-muted-foreground">No commits yet.</p>
  return <CommitList commits={q.data.commits} />
}

function CommitList({ commits }: { commits: { sha: string; subject: string; author: string; at: number }[] }) {
  return (
    <ul className="overflow-hidden rounded-xl border">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-start gap-3 border-b px-3 py-2.5 text-sm last:border-b-0">
          <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2">{c.subject}</span>
            <span className="text-xs text-muted-foreground">{c.author}, {relativeTime(c.at)}</span>
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
        </li>
      ))}
    </ul>
  )
}

function ProjectActivity({ slug }: { slug: string }) {
  const q = useQuery(activityQuery(slug))
  return q.data ? <ActivityList items={q.data.activity} /> : <Skeleton className="h-32" />
}
