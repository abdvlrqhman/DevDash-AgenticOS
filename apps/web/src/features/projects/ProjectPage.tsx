import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { BadgeCheck, Bot, ChevronRight, Copy, Ellipsis, GitBranch, GitCommitHorizontal, KeyRound, Lock, Plus, RefreshCw, Search, Share2, Sparkles, StickyNote, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { authorName } from '@/components/app/author'
import { Orb } from '@/components/app/orb'
import { PageBody, PageHeader } from '@/components/app/page'
import { UserAvatar } from '@/components/app/user-avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabCount, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorAlert } from '../auth/LoginPage'
import { projectSessionsQuery, relativeTime, STATUS_LABEL, useLiveProjectSessions, type ProjectSession, type Session } from '../claude/data'
import { agentName } from '../claude/harness'
import { NewSession } from '../claude/SessionsPage'
import { CAPS, capsLabel, projectCapsQuery, type Cap } from '../claude/ShareDialog'
import { Board } from '../work/Board'
import { activityQuery, commitsQuery, notesQuery, projectQuery, STATUSES, tasksQuery, useLiveWork, type Activity, type Project, type SessionSharing, type Task } from '../work/data'
import { Due, PriorityIcon, StatusIcon } from '../work/TaskBits'
import { cn } from '@/lib/utils'
import { NoteList } from '../notes/NotesPage'
import { count, repoLabel, segment, segmented } from './ProjectsPage'
import { BuildsTab } from '../builds/BuildsTab'
import { api, meQuery, unwrap } from '@/lib/api'
import { PinButton } from '../pins/pins'
import { ProjectSkills } from '../skills/ProjectSkills'
import { TeamTab } from '../team/TeamTab' // Team (optional)
import { deliveriesQuery, ReadyToReview, useLiveDeliveries } from './ReadyToReview'
import { canDeleteProject, DeleteProjectDialog } from './DeleteProject'

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
  const [deleting, setDeleting] = useState(false)
  const me = useQuery(meQuery).data
  // Coming back to a project (from a task, a run or a role) opens the tab you left.
  const [tab, setTabState] = useState(() => { try { return sessionStorage.getItem(`project-tab:${slug}`) ?? 'overview' } catch { return 'overview' } })
  const setTab = (v: string) => { setTabState(v); try { sessionStorage.setItem(`project-tab:${slug}`, v) } catch { /* private mode */ } }
  const fetchNow = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].fetch.$post({ param: { slug } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['projects'] }); toast.success('Fetched.') },
    onError: (e) => toast.error(e.message),
  })
  const p = q.data?.project

  if (q.error) return <><PageHeader title={slug} back="/projects" /><PageBody><ErrorAlert error={q.error} /></PageBody></>
  if (!p) return <><PageHeader title={slug} back="/projects" /><PageBody><Skeleton className="h-10 w-2/3 rounded-xl bg-surface" /><Skeleton className="h-48 rounded-2xl bg-surface" /></PageBody></>
  const isGithub = /github\.com/.test(p.repoUrl ?? '')

  return (
    <>
      <PageHeader back="/projects" title={p.name}
        description={<span className="flex items-center gap-1.5"><span className="truncate">{repoLabel(p.repoUrl)}</span><GitBranch className="size-3.5 shrink-0" />{p.defaultBranch}</span>}
        actions={<>
          {p.repoUrl && <Button size="icon-sm" variant="ghost" aria-label="Fetch now" title="Fetch now" disabled={fetchNow.isPending} onClick={() => fetchNow.mutate()}><RefreshCw className={fetchNow.isPending ? 'animate-spin' : ''} /></Button>}
          <GuestCapsDefault slug={p.slug} />
          <PinButton kind="project" id={p.slug} />
          <Button size="sm" variant="outline" onClick={() => setSession(true)}><Sparkles /><span className="hidden sm:inline">Session</span></Button>
          {/* Deleting: only for whoever added it (or an admin once they're disabled); everyone else never sees it. */}
          {canDeleteProject(me, p) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More"><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}><Trash2 />Delete project…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>} />
      <PageBody className="gap-5 md:pt-8">
        {p.fetchError && (
          <p className="flex items-start gap-3 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-pretty">Couldn't fetch the repository: {p.fetchError}. DevDash tries again every 5 minutes, or fetch now with the button up top.</span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <button className="-mx-2 flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 transition-colors duration-150 hover:bg-surface hover:text-foreground"
            title="Copy the path" onClick={() => void navigator.clipboard.writeText(p.path).then(() => toast.success('Path copied'))}>
            <Copy className="size-3.5 shrink-0" /><span className="truncate font-mono">{p.path}</span>
          </button>
          {p.repoUrl && <span>{p.fetchedAt ? `Fetched ${relativeTime(p.fetchedAt)}` : 'Not fetched yet'}, every 5 minutes</span>}
        </div>

        <Tabs value={tab} onValueChange={setTab} className="gap-6">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview{readyCount > 0 && <TabCount className="bg-attention-soft text-attention-foreground">{readyCount}</TabCount>}</TabsTrigger>
            <TabsTrigger value="tasks">Tasks{p.openTasks > 0 && <TabCount>{p.openTasks}</TabCount>}</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="sessions">
              Sessions
              {p.live.working + p.live.waiting > 0 ? <StatusLight state={p.live.working ? 'live' : 'waiting'} /> : p.sessions > 0 && <TabCount>{p.sessions}</TabCount>}
            </TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="builds">Builds</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview p={p} readyCount={readyCount} tasks={tasks.data?.tasks} isGithub={isGithub} onTab={setTab} onNew={() => setSession(true)} />
          </TabsContent>
          <TabsContent value="tasks">
            <ErrorAlert error={tasks.error} />
            {tasks.data && <Board tasks={tasks.data.tasks} project={slug} showProject={false} />}
          </TabsContent>
          <TabsContent value="notes"><ProjectNotes slug={slug} /></TabsContent>
          <TabsContent value="sessions"><ProjectSessions slug={slug} sharing={p.sessionSharing} onNew={() => setSession(true)} /></TabsContent>
          <TabsContent value="skills"><ProjectSkills slug={slug} /></TabsContent>
          <TabsContent value="builds"><BuildsTab slug={slug} isGithub={isGithub} /></TabsContent>
          <TabsContent value="commits"><Commits slug={slug} /></TabsContent>
          <TabsContent value="activity"><ProjectActivity slug={slug} /></TabsContent>
          <TabsContent value="team"><TeamTab slug={slug} /></TabsContent>
        </Tabs>
      </PageBody>
      <NewSession open={session} onClose={() => setSession(false)} initialProject={slug} />
      {canDeleteProject(me, p) && <DeleteProjectDialog project={p} open={deleting} onOpenChange={setDeleting} />}
    </>
  )
}

/** A titled part of a tab: the title with a quiet count, and what you can do there on the right. */
function Block({ title, count: n, action, className, children }: { title: string; count?: number; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.01em]">{title}{n ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{n}</span> : null}</h2>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/** Rows on one tone-stepped panel: the panel groups them, a step in tone under the pointer marks one; no lines. */
const Panel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <ul className={cn('flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5', className)}>{children}</ul>
)
const rowClass = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'
const Calm = ({ children }: { children: ReactNode }) => <p className="text-sm text-pretty text-muted-foreground">{children}</p>
/** A quiet link-like button that switches tabs, for "All sessions", "Board" and the like. */
const TabLink = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} className="-my-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-surface hover:text-foreground">{children}</button>
)

function ProjectNotes({ slug }: { slug: string }) {
  const notes = useQuery(notesQuery(slug))
  return (
    <Block title="Notes" count={notes.data?.notes.length}
      action={<Button size="sm" variant="outline" asChild><Link to="/notes/$id" params={{ id: 'new' }} search={{ project: slug }}><StickyNote />New note</Link></Button>}>
      <ErrorAlert error={notes.error} />
      {notes.isPending ? <Skeleton className="h-32 rounded-2xl bg-surface" />
        : notes.data && <NoteList notes={notes.data.notes} empty="No notes in this project yet. Pin decisions, setup steps and links here, for the team and its agents." />}
    </Block>
  )
}

const isActive = (s: Session) => s.status === 'working' || s.status === 'waiting'
const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')
// Working or waiting first, then the most recent.
const byUrgency = (a: Session, b: Session) => Number(isActive(b)) - Number(isActive(a)) || b.lastActivityAt - a.lastActivityAt
const firstName = (n: string) => n.split(' ')[0]!
const branch = (s: Session) => (s.worktree ? `dd/${s.worktree.split('/').pop()}` : null)
/** Each orb is a canvas: a list shows Claude's presence on its first few working sessions, a light on the rest. */
const ORBS = 3

/** Whose it is: you, a teammate, or a team role (which runs as a person, but people know it by the role). */
function Who({ s }: { s: ProjectSession }) {
  if (s.kind === 'proposal' && s.role) return <span className="flex min-w-0 items-center gap-1"><BadgeCheck className="size-3.5 shrink-0" /><span className="truncate">{s.role.name}'s approval</span></span>
  if (s.role) return <span className="flex min-w-0 items-center gap-1"><Bot className="size-3.5 shrink-0" /><span className="truncate">{s.role.name}</span></span>
  if (s.kind === 'mine') return <span className="flex items-center gap-1">{s.audience !== 'private' ? <Share2 className="size-3" aria-label="Shared" /> : <Lock className="size-3" aria-label="Private" />}You</span>
  return <span className="truncate">{firstName(s.owner.name)}</span>
}

function SessionRow({ s, nested, orb }: { s: ProjectSession; nested?: boolean; orb?: boolean }) {
  // Claude waiting on your answer is the one thing here that needs you.
  const needsYou = s.status === 'waiting' && s.kind === 'mine'
  const status = isActive(s) || s.status === 'error'
  return (
    <Link to="/sessions/$id" params={{ id: s.id }} className={cn(rowClass, nested && 'pl-11', needsYou && 'bg-attention-soft hover:bg-attention-soft/70')}>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {orb ? <Orb state="working" size={20} label="Working" /> : <StatusLight state={light(s)} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', !nested && 'font-medium')}>{s.title}</span>
        {/* On phones whose it is joins the second line, so the title keeps the width. */}
        {(status || !nested) && (
          <span className={cn('flex min-w-0 items-center text-xs', !status && 'sm:hidden')}>
            {status && (
              <span className={cn('truncate', needsYou ? 'text-attention-foreground' : s.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {s.status === 'working' && s.statusDetail ? s.statusDetail : needsYou ? `${agentName(s.harness)} is waiting for your answer`
                  : s.status === 'waiting' ? 'Waiting for an answer' : STATUS_LABEL[s.status]}
              </span>
            )}
            {!nested && <span className="flex min-w-0 shrink-0 items-center text-muted-foreground sm:hidden">{status && <span className="mr-1">,</span>}<Who s={s} /></span>}
          </span>
        )}
      </span>
      {s.worktree && <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground md:flex"><GitBranch className="size-3.5" />{branch(s)}</span>}
      <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
        {!nested && <span className="hidden items-center sm:flex"><Who s={s} />,</span>}{relativeTime(s.lastActivityAt)}
      </span>
    </Link>
  )
}

/** Many kindred sessions under one foldaway row, so dozens don't bury everything else: a role's shifts ("CEO, 14
 *  shifts"), or the sessions started off approved proposals ("From approvals, 3 sessions"). */
function SessionGroup({ icon, label, noun, sessions, open: forced }: { icon: ReactNode; label: string; noun: [string, string]; sessions: ProjectSession[]; open?: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open || !!forced
  const top = sessions[0]!
  const busy = sessions.some(isActive)
  return (
    <>
      <button onClick={() => setOpen(!shown)} aria-expanded={shown} className={cn(rowClass, 'w-full text-left')}>
        <span className="flex size-5 shrink-0 items-center justify-center"><StatusLight state={busy ? light(top) : 'idle'} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">{icon}<span className="truncate font-medium">{label}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{sessions.length} {sessions.length === 1 ? noun[0] : noun[1]}</span></span>
          {busy && <span className="block text-xs text-muted-foreground">{STATUS_LABEL[top.status]}</span>}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">last {relativeTime(top.lastActivityAt)}</span>
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-spring', shown && 'rotate-90')} />
      </button>
      {shown && <ul className="flex flex-col gap-0.5">{sessions.map((s) => <li key={s.id}><SessionRow s={s} nested /></li>)}</ul>}
    </>
  )
}

type Group = { icon: ReactNode; label: string; noun: [string, string]; sessions: ProjectSession[] }
type Row = { key: string; at: Session } & ({ s: ProjectSession } | { group: Group })
/** Sessions in order, with each role's shifts and all approval-born sessions folded into one row that sits where its
 *  latest member would. A fold of one is just that session's row. */
function rows(sessions: ProjectSession[]): Row[] {
  const sorted = [...sessions].sort(byUrgency)
  const shifts = new Map<number, { role: { id: number; name: string }; list: ProjectSession[] }>()
  const proposals: ProjectSession[] = []
  const out: Row[] = []
  const fold = (key: string, list: ProjectSession[], group: Omit<Group, 'sessions'>) =>
    out.push(list.length === 1 ? { key: list[0]!.id, at: list[0]!, s: list[0]! } : { key, at: list[0]!, group: { ...group, sessions: list } })
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
    fold(`shifts:${id}`, g.list, { icon: <Bot className="size-3.5 shrink-0 text-muted-foreground" />, label: g.role.name, noun: ['shift', 'shifts'] })
  }
  if (proposals.length) {
    fold('proposals', proposals, { icon: <BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" />, label: 'From approvals', noun: ['session', 'sessions'] })
  }
  return out.sort((a, b) => byUrgency(a.at, b.at))
}

function SessionList({ sessions, expand }: { sessions: ProjectSession[]; expand?: boolean }) {
  const list = rows(sessions)
  const orbs = new Set(list.flatMap((r) => ('s' in r && r.s.status === 'working' ? [r.key] : [])).slice(0, ORBS))
  return (
    <Panel>
      {list.map((r) => (
        <li key={r.key}>
          {'s' in r ? <SessionRow s={r.s} orb={orbs.has(r.key)} /> : <SessionGroup {...r.group} open={expand} />}
        </li>
      ))}
    </Panel>
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
    <p className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
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
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ToggleGroup type="single" spacing={1} size="sm" className={segmented} aria-label="Active or archived"
          value={archived ? 'archived' : 'active'} onValueChange={(v) => v && setArchived(v === 'archived')}>
          <ToggleGroupItem value="active" className={cn(segment, 'h-7')}>Active</ToggleGroupItem>
          <ToggleGroupItem value="archived" className={cn(segment, 'h-7')}>Archived</ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-1">
          <SharingDefault slug={slug} sharing={sharing} />
          <Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button>
        </div>
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 no-scrollbar md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Whose sessions">
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)} aria-pressed={filter === f.value}
            className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-[background-color,color,scale] duration-300 ease-spring active:scale-[0.96]',
              filter === f.value ? 'bg-primary text-primary-foreground' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground')}>
            {f.label}<span className="tabular-nums opacity-60">{found.filter(f.test).length}</span>
          </button>
        ))}
      </div>
      {(all.length > 8 || needle) && (
        <InputGroup>
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput aria-label="Search sessions" placeholder="Search titles, people, roles, branches" value={q} onChange={(e) => setQ(e.target.value)} />
        </InputGroup>
      )}
      <ErrorAlert error={list.error} />
      {list.isPending ? <Skeleton className="h-48 rounded-2xl bg-surface" />
        : sessions.length ? <SessionList sessions={sessions} expand={!!needle} />
        : (
          <Calm>
            {needle ? 'No sessions match that search.' : filter !== 'all' ? 'None of these yet.' : archived ? 'No archived sessions in this project.'
              : <>No sessions in this project yet. <button className="text-foreground underline underline-offset-4" onClick={onNew}>Start one</button></>}
          </Calm>
        )}
      {list.data && !needle && (filter === 'all' || filter === 'teammates') && <HiddenLine hidden={list.data.hidden} archived={archived} />}
    </div>
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
        <p className="font-medium">New sessions here are</p>
        <ToggleGroup type="single" spacing={1} size="sm" className={cn(segmented, 'mt-3 w-full')} value={sharing} disabled={save.isPending}
          onValueChange={(v) => v && v !== sharing && save.mutate(v as SessionSharing)}>
          {SHARING.map((o) => <ToggleGroupItem key={o.value} value={o.value} className={cn(segment, 'h-7 px-2')}>{o.label}</ToggleGroupItem>)}
        </ToggleGroup>
        <p className="mt-2 text-xs text-pretty text-muted-foreground">{current.hint} For everyone's new sessions in this project; whoever starts one can still change it then or later.</p>
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
          <span className="hidden lg:inline">Share permissions</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="font-medium">Share permissions</p>
        <p className="mt-1 text-xs text-pretty text-muted-foreground">In your sessions in this project, teammates’ requests can use these of yours without asking you.</p>
        <div className="mt-3 flex flex-col gap-0.5 rounded-xl bg-surface p-1">
          {CAPS.map((c) => (
            <label key={c.value} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 transition-colors duration-150 hover:bg-surface-2">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{c.label}</span>
                <span className="text-xs text-muted-foreground">{c.what}</span>
              </span>
              <Switch checked={caps.includes(c.value)} disabled={!q.data || save.isPending} aria-label={`Share ${c.label}`}
                onCheckedChange={(on) => save.mutate(on ? [...caps, c.value] : caps.filter((x) => x !== c.value))} />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-pretty text-muted-foreground">
          Off: the agent asks you. Yours only: everyone sets their own. A session’s Share dialog can still change it for that session.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The project at a glance, led by one line that says whether anything is going on here: Claude at work or waiting, a
 * change ready to ship. Then whose Claude is on it, where the tasks stand, what happened; instructions and the latest
 * commits on the side (below, on phones).
 */
function Overview({ p, readyCount, tasks, isGithub, onTab, onNew }: {
  p: Project; readyCount: number; tasks: Task[] | undefined; isGithub: boolean; onTab: (tab: string) => void; onNew: () => void
}) {
  const { slug, live } = p
  useLiveProjectSessions(slug)
  const active = (useQuery(projectSessionsQuery(slug, false)).data?.sessions ?? []).filter(isActive)
  // Private sessions of other people: counted by the server, never listed.
  const hidden = Math.max(0, live.working + live.waiting - active.length)
  const shown = new Set(active.map((s) => s.owner.name))
  const others = live.people.filter((n) => !shown.has(n)).map(firstName)
  const open = (tasks ?? []).filter((t) => t.status !== 'done')
  const moving = open.filter((t) => t.status === 'in_progress' || t.status === 'review')
  const commits = useQuery(commitsQuery(slug))
  const activity = useQuery(activityQuery(slug))
  const last = commits.data?.commits[0]

  const claude = live.working && live.waiting ? 'An agent is working here, and waiting for an answer'
    : live.working ? 'An agent is working here' : live.waiting ? 'Waiting for an answer here' : ''
  const ready = readyCount ? `${count(readyCount, 'change')} ${readyCount === 1 ? 'is' : 'are'} ready to review` : ''
  const busy = !!(claude || ready)
  const headline = claude && ready ? `${claude}. ${ready}.` : busy ? `${claude || ready}.` : 'Quiet right now.'

  return (
    <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-x-12">
      {/* On phones both columns melt into one list (display: contents) and `order` sets the reading order. */}
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-10">
        <header className="order-1 flex flex-col gap-2">
          <h2 className={cn('max-w-[26ch] text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.25rem]', !busy && 'text-muted-foreground')}>
            {headline}
          </h2>
          <p className="text-[15px] text-pretty text-muted-foreground">
            {tasks && <><Fact onClick={() => onTab('tasks')}>{open.length} open {open.length === 1 ? 'task' : 'tasks'}</Fact>{moving.length > 0 && `, ${moving.length} moving`}. </>}
            {last && <><Fact onClick={() => onTab('commits')}>Last commit {relativeTime(last.at)}</Fact>, by {firstName(last.author)}.</>}
          </p>
        </header>

        <ReadyToReview slug={slug} isGithub={isGithub} className="order-2" />

        <Block title="Sessions right now" count={active.length + hidden || undefined} className="order-3"
          action={<><Button size="sm" variant="ghost" onClick={onNew}><Plus />New session</Button><TabLink onClick={() => onTab('sessions')}>All sessions</TabLink></>}>
          {active.length > 0 && <SessionList sessions={active} expand />}
          {hidden > 0 && (
            <p className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
              <StatusLight state="live" />
              {hidden} private {hidden === 1 ? 'session' : 'sessions'} working here{others.length ? ` (${others.join(', ')})` : ''}
            </p>
          )}
          {!active.length && !hidden && (
            <Calm>No session is working in this project right now. <button className="text-foreground underline underline-offset-4" onClick={onNew}>Start a session</button></Calm>
          )}
        </Block>

        <Block title="Tasks" count={open.length || undefined} className="order-4" action={<TabLink onClick={() => onTab('tasks')}>Board</TabLink>}>
          {!tasks ? <Skeleton className="h-40 rounded-2xl bg-surface" /> : <>
            <div className="grid grid-cols-2 gap-0.5 rounded-2xl bg-surface p-1.5 sm:grid-cols-4">
              {STATUSES.filter((st) => st.value !== 'done').map((st) => (
                <button key={st.value} onClick={() => onTab('tasks')}
                  className="flex min-w-0 flex-col items-start gap-1 rounded-xl px-3 py-2.5 text-left transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.97]">
                  <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">{open.filter((t) => t.status === st.value).length}</span>
                  <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><StatusIcon status={st.value} className="size-3.5" /><span className="truncate">{st.label}</span></span>
                </button>
              ))}
            </div>
            {moving.length > 0
              ? <Panel>{moving.slice(0, 6).map((t) => <TaskLine key={t.id} t={t} />)}</Panel>
              : <Calm>Nothing in progress or in review.</Calm>}
          </>}
        </Block>

        <Block title="Activity" className="order-6" action={<TabLink onClick={() => onTab('activity')}>All activity</TabLink>}>
          {activity.data ? <ProjectLog items={activity.data.activity.slice(0, 8)} /> : <Skeleton className="h-32 rounded-2xl bg-surface" />}
        </Block>
      </div>

      <aside className="contents lg:sticky lg:top-20 lg:flex lg:flex-col lg:gap-10">
        <ProjectInstructions slug={slug} instructions={p.instructions} className="order-5" />
        <Block title="Latest commits" className="order-7" action={<TabLink onClick={() => onTab('commits')}>All commits</TabLink>}>
          {commits.isPending ? <Skeleton className="h-40 rounded-2xl bg-surface" /> : commits.error ? <ErrorAlert error={commits.error} />
            : !commits.data.commits.length ? <Calm>No commits yet.</Calm>
            : <Panel>{commits.data.commits.slice(0, 5).map((c) => <CommitRow key={c.sha} c={c} compact />)}</Panel>}
        </Block>
      </aside>
    </div>
  )
}

const Fact = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} className="underline decoration-muted-foreground/40 underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground">{children}</button>
)

function TaskLine({ t }: { t: Task }) {
  return (
    <li>
      <Link to="/tasks/$slug/$number" params={{ slug: t.project.slug, number: String(t.number) }} className={rowClass}>
        <span className="flex size-5 shrink-0 items-center justify-center"><StatusIcon status={t.status} /></span>
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        <PriorityIcon priority={t.priority} />
        <Due due={t.due} />
        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">#{t.number}</span>
        {t.assignee && <UserAvatar user={t.assignee} className="size-6" textClassName="text-[10px]" title={t.assignee.name} />}
      </Link>
    </li>
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
    <Block title="Instructions" className={className} action={!editing && <Button size="sm" variant="ghost" onClick={start}>{instructions ? 'Edit' : 'Add'}</Button>}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus rows={6} className="min-h-32 text-sm" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={'Rules every session in this project follows. e.g. "You are a gold analyst. Follow these rules…"'} />
          <span className="text-xs text-muted-foreground">Added to the system prompt of every session here.</span>
          <span className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setBody(instructions); setEditing(false) }}>Cancel</Button>
            <Button size="sm" disabled={save.isPending || body === instructions} onClick={() => save.mutate()}>Save</Button>
          </span>
        </div>
      ) : instructions ? (
        <p className="max-h-56 overflow-auto rounded-2xl bg-surface px-4 py-3 text-sm whitespace-pre-wrap text-muted-foreground">{instructions}</p>
      ) : (
        <Calm>No instructions yet. Add rules every session in this project should follow, set once like a Claude Project's instructions.</Calm>
      )}
    </Block>
  )
}

type Commit = { sha: string; subject: string; author: string; at: number }

function CommitRow({ c, compact }: { c: Commit; compact?: boolean }) {
  return (
    <li className="flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm">
      <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2">{c.subject}</span>
        <span className="text-xs text-muted-foreground">{compact ? firstName(c.author) : c.author}, {compact ? relativeTime(c.at) : clock(c.at)}</span>
      </span>
      {!compact && <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>}
    </li>
  )
}

/** "Today", "Yesterday", then the weekday and date: the headings commits and activity are grouped under. */
const dayOf = (at: number) => {
  const d = new Date(at * 1000)
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) })
}
const clock = (at: number) => new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** Newest-first items in runs of one day each, in order. */
function byDay<T extends { at: number }>(items: T[]) {
  const out: [string, T[]][] = []
  for (const x of items) {
    const day = dayOf(x.at)
    if (out.at(-1)?.[0] === day) out.at(-1)![1].push(x)
    else out.push([day, [x]])
  }
  return out
}

function Commits({ slug }: { slug: string }) {
  const q = useQuery(commitsQuery(slug))
  if (q.isPending) return <Skeleton className="h-64 rounded-2xl bg-surface" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.commits.length) return <Calm>No commits yet. They show here once someone, or an agent, commits to {slug}'s main branch.</Calm>
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {byDay(q.data.commits).map(([day, list]) => (
        <Block key={day} title={day} count={list.length}>
          <Panel>{list.map((c) => <CommitRow key={c.sha} c={c} />)}</Panel>
        </Block>
      ))}
      <p className="text-xs text-pretty text-muted-foreground">
        Task numbers here are DevDash's own: <code className="font-mono">fixes #N</code> in a commit refers to {slug}#N.
      </p>
    </div>
  )
}

/** What happened in the project, by the team, by Claude and by the team roles, newest first, a day at a time. */
function ProjectLog({ items }: { items: Activity[] }) {
  if (!items.length) return <Calm>Nothing has happened here yet. Work on the project, by the team or by its agents, shows up as it happens.</Calm>
  return (
    <div className="flex flex-col gap-4">
      {byDay(items).map(([day, list]) => (
        <section key={day} className="flex flex-col">
          <h3 className="pb-1 text-xs font-medium text-muted-foreground">{day}</h3>
          <ol className="flex flex-col">
            {list.map((a) => {
              const text = (
                <span className="flex items-start gap-3 py-2 text-sm">
                  <span className="w-[4.25rem] shrink-0 pt-px text-xs whitespace-nowrap text-muted-foreground tabular-nums">{clock(a.at)}</span>
                  <span className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', a.role || a.viaClaude ? 'bg-foreground/60' : 'bg-muted-foreground/35')} />
                  <span className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">
                    <span className="font-medium text-foreground">{authorName(a.user, a.role)}</span>
                    {a.role ? ' (AI team)' : a.viaClaude ? ' (via an agent)' : ''} {a.summary}
                  </span>
                </span>
              )
              return (
                <li key={a.id}>
                  {a.url ? <Link to={a.url} className="-mx-3 block rounded-xl px-3 transition-colors duration-200 hover:bg-surface">{text}</Link> : text}
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

function ProjectActivity({ slug }: { slug: string }) {
  const q = useQuery(activityQuery(slug))
  return <div className="max-w-3xl">{q.data ? <ProjectLog items={q.data.activity} /> : <Skeleton className="h-48 rounded-2xl bg-surface" />}</div>
}
