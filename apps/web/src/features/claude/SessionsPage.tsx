import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Archive, ArrowLeft, ChevronRight, Plus, Settings2 } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { Orb } from '@/components/app/orb'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { useArrivals } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { NativeSelect } from '@/components/app/native-select'
import { Switch } from '@/components/ui/switch'
import { projectsQuery, type SessionSharing } from '../work/data'
import { useArchiveSession } from './ArchiveSession'
import { ModelField } from './ModelChoices'
import type { ModelInfo } from './models'
import { byFolder, commandsQuery, FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, relativeTime, sessionPlace, sessionsQuery, type PermissionMode, type Session } from './data'
import { HARNESS, HARNESSES, harnessOf, type Harness } from './harness'

export function SessionsPage() {
  const me = useQuery(meQuery).data!
  const [archived, setArchived] = useState(false)
  const list = useQuery(sessionsQuery(archived))
  const [creating, setCreating] = useState(false)
  const archive = useArchiveSession()

  const sessions = list.data?.sessions ?? []
  const waiting = sessions.filter((s) => s.status === 'waiting')
  const groups = byFolder(archived ? sessions : sessions.filter((s) => s.status !== 'waiting'))
  // Claude's orb marks the sessions it's working in; each is a canvas, so only the first few get one.
  const orbs = new Set(sessions.filter((s) => s.status === 'working').slice(0, 3).map((s) => s.id))
  // A session that starts waiting for an answer while you look lands in "Needs you".
  const needs = useRef<HTMLUListElement>(null)
  useArrivals(needs, list.isSuccess && !archived ? waiting.map((s) => s.id) : undefined)

  return (
    <>
      <PageHeader title={archived ? 'Archived sessions' : 'Sessions'}
        actions={<>
          <Button variant="ghost" size="icon" asChild aria-label="Agent setup"><Link to="/sessions/setup"><Settings2 /></Link></Button>
          <Button size="sm" onClick={() => setCreating(true)}><Plus />New</Button>
        </>} />
      <PageBody className="gap-10 py-6 md:py-8">
        <ErrorAlert error={list.error} />
        {list.isPending && (
          <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-13 rounded-xl bg-surface-2" />)}</div>
        )}
        {!archived && waiting.length > 0 && (
          <Block title="Needs you" count={waiting.length}>
            <ul ref={needs} className="flex flex-col gap-1.5">
              {waiting.map((s) => <SessionRow key={s.id} s={s} me={me.id} highlight onArchive={archive.ask} />)}
            </ul>
          </Block>
        )}
        {groups.map((g) => (
          <Block key={g.key} title={<span title={g.path}>{g.label}</span>} count={g.sessions.length}>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {g.sessions.map((s) => <SessionRow key={s.id} s={s} me={me.id} orb={orbs.has(s.id)} onArchive={archived ? undefined : archive.ask} />)}
            </ul>
          </Block>
        ))}
        {list.isSuccess && !sessions.length && (
          <div className="flex flex-col items-start gap-5 rounded-2xl bg-surface p-6 md:p-8">
            <div className="flex max-w-prose flex-col gap-1.5">
              <h2 className="text-lg font-semibold tracking-[-0.015em]">{archived ? 'Nothing archived' : 'Hand an agent something to do'}</h2>
              <p className="text-sm text-pretty text-muted-foreground">
                {archived ? 'Sessions you archive wait here, out of the way, until you need them again.'
                  : 'Start a session and a coding agent works on the server as you, in a folder or a project, and keeps going after you close the app.'}
              </p>
            </div>
            {!archived && <Button onClick={() => setCreating(true)}><Plus />New session</Button>}
          </div>
        )}
        <div className="-mt-4">
          <Button variant="ghost" size="sm" className="-ml-3 text-muted-foreground" onClick={() => setArchived(!archived)}>
            {archived ? <ArrowLeft /> : <Archive />}{archived ? 'Back to active sessions' : 'Show archived sessions'}
          </Button>
        </div>
      </PageBody>
      {archive.dialog}
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')

function Block({ title, count, children }: { title: ReactNode; count: number; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="truncate text-base font-semibold tracking-[-0.01em]">{title}<span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span></h2>
      {children}
    </section>
  )
}

/**
 * One session on its panel. Waiting ones stand alone, amber: they're the ones asking for you. The archive button sits
 * beside the link, inside the same row, so the row still reads as one thing under the pointer.
 */
function SessionRow({ s, me, highlight, orb, onArchive }: { s: Session; me: number; highlight?: boolean; orb?: boolean; onArchive?: (s: Session) => void }) {
  const mine = s.owner.id === me
  const what = s.status === 'working' ? (s.statusDetail || 'Working') : s.status === 'waiting' ? 'Waiting for an answer' : relativeTime(s.lastActivityAt)
  return (
    <li data-key={s.id} className={cn('flex items-center rounded-xl transition-[background-color,scale] duration-300 ease-spring has-[a:active]:scale-[0.99]',
      highlight ? 'rounded-2xl bg-attention-soft hover:bg-attention-soft/70' : 'hover:bg-surface-2')}>
      <Link to="/sessions/$id" params={{ id: s.id }} className={cn('flex min-w-0 flex-1 items-center gap-3 px-3 text-sm', highlight ? 'py-3' : 'py-2.5')}>
        <span className="flex size-5 shrink-0 items-center justify-center">
          {orb ? <Orb state="working" size={20} label="Working" /> : <StatusLight state={light(s)} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">{s.title}</span>
          <span className={cn('line-clamp-1 text-xs', highlight ? 'text-attention-foreground' : 'text-muted-foreground')}>
            {!mine && <span className={highlight ? undefined : 'text-foreground/80'}>{s.owner.name.split(' ')[0]}, </span>}
            {mine ? what : what[0]!.toLowerCase() + what.slice(1)}{highlight ? <>, in {sessionPlace(s)}</> : null}
            {/* Phones have no room for the tags on the right: the agent goes here. */}
            <span className="sm:hidden"> · {HARNESS[harnessOf(s)].name}</span>
          </span>
        </span>
        {/* Which agent runs it, for every session alike: a team can use several. */}
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {[HARNESS[harnessOf(s)].label, s.mode === 'cli' && 'CLI', mine && s.audience !== 'private' && (s.audience === 'people' ? `Shared with ${s.sharedWith}` : 'Shared')].filter(Boolean).join(', ')}
        </span>
        {!mine && <UserAvatar user={s.owner} className="size-6" textClassName="text-[10px]" title={s.owner.name} />}
        {!(onArchive && mine && !s.archived) && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
      </Link>
      {onArchive && mine && !s.archived && (
        <Button size="icon-sm" variant="ghost" className="mr-1.5 shrink-0 text-muted-foreground hover:bg-foreground/5 dark:hover:bg-foreground/5" aria-label={`Archive ${s.title}`} title="Archive" onClick={() => onArchive(s)}><Archive /></Button>
      )}
    </li>
  )
}

function Choice({ id, label, value, options, onChange, description }: {
  id: string; label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; description?: string
}) {
  return (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup type="single" spacing={1} aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onChange(v)} className="w-full flex-wrap rounded-2xl bg-surface p-1">
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className="min-w-fit flex-1 rounded-xl hover:bg-surface-2">{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}

/** A folder name for a session that isn't in a project: two words, easy to recognise in Files. */
const WORDS = [['quiet', 'amber', 'swift', 'bright', 'calm', 'bold', 'lucky', 'misty', 'brave', 'cosmic', 'gentle', 'rapid'],
  ['river', 'falcon', 'maple', 'harbor', 'comet', 'meadow', 'otter', 'canyon', 'cedar', 'lantern', 'summit', 'willow']]
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)]!
export const sessionFolder = () => `~/projects/${pick(WORDS[0]!)}-${pick(WORDS[1]!)}`

export function NewSession({ open, onClose, initialPrompt = '', initialCwd, initialProject }: {
  open: boolean; onClose: () => void; initialPrompt?: string; initialCwd?: string; initialProject?: string
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setup = useQuery({ ...profilesQuery, enabled: open })
  const d = setup.data?.defaults
  const [prompt, setPrompt] = useState(initialPrompt)
  const [cwd, setCwd] = useState(initialCwd ?? sessionFolder)
  const [customModel, setCustomModel] = useState(false)
  const [harness, setHarness] = useState<Harness>('claude')
  const [profile, setProfile] = useState('default')
  const [model, setModel] = useState('')
  const [perm, setPerm] = useState<PermissionMode>('bypassPermissions')
  const [openIn, setOpenIn] = useState<'chat' | 'cli'>('chat')
  const projects = useQuery({ ...projectsQuery, enabled: open }).data?.projects ?? []
  const [project, setProject] = useState(initialProject ?? '')
  const [worktree, setWorktree] = useState(true)
  // Untouched, it follows the project's default for new sessions (the server applies the same one).
  const [sharingPick, setSharing] = useState<SessionSharing | null>(null)
  const sharing = sharingPick ?? projects.find((p) => p.slug === project)?.sessionSharing ?? 'private'
  useEffect(() => {
    if (!d) return
    setHarness(harnessOf(d))
    setProfile(d.profile)
    setModel(d.model ?? '')
    setPerm(d.permission_mode as PermissionMode)
    setOpenIn(d.open_in)
  }, [d])
  useEffect(() => { if (open) { setPrompt(initialPrompt); setCwd(initialCwd ?? sessionFolder()); setProject(initialProject ?? ''); setSharing(null) } }, [open, initialPrompt, initialCwd, initialProject])

  const agent = HARNESS[harness]
  const other = (setup.data?.agents as { harness: string; installed: boolean; profiles: { name: string }[] }[] | undefined)?.find((a) => a.harness === harness)
  // Claude profiles say whether they're signed in; OpenCode's always work (its free models need no sign-in).
  const profiles = harness === 'claude' ? (setup.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? []
    : (other?.profiles ?? []).map((p) => ({ name: p.name, loggedIn: true }))
  const chosen = profiles.find((p) => p.name === profile)
  const missing = harness !== 'claude' && other && !other.installed ? other : undefined
  // The models this agent offers (Claude Code's with their versions; OpenCode's from every provider you connected).
  const listed = useQuery({ ...commandsQuery(profile, harness), enabled: open && !missing && (!profiles.length || !!chosen) })
  const offered = listed.data?.models as ModelInfo[] | undefined
  const models: ModelInfo[] = offered?.length ? offered : harness === 'claude' ? FALLBACK_MODELS : [{ value: '', displayName: 'Default' }]
  const modes = PERMISSION_MODES.slice(0, 4).filter((p) => agent.modes.includes(p.value))
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions.$post({
      json: {
        prompt, images: [], cwd, harness, profile: chosen ? profile : 'default', model: model && model !== 'default' ? model.trim() : null, effort: null, permissionMode: perm, mode: openIn,
        project: project || undefined, worktree: project ? worktree : undefined,
        ...(sharingPick && { shared: sharingPick !== 'private', sharedCanSend: sharingPick === 'shared_can_send' }),
        cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))),
      },
    })),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] })
      onClose()
      navigate({ to: '/sessions/$id', params: { id: session.id } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!create.isPending) create.mutate()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && onClose()} title="New session" description="The agent works in this folder as you, and keeps going when you close the app.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          {/* Only when started from something to hand over (a task); otherwise you write to the agent in the session. */}
          {openIn === 'chat' && initialPrompt && (
            <Field>
              <FieldLabel htmlFor="ns-prompt">First message</FieldLabel>
              <Textarea id="ns-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} className="min-h-24 text-base md:text-sm" />
            </Field>
          )}
          {projects.length > 0 && (
            <Field>
              <FieldLabel htmlFor="ns-project">Project</FieldLabel>
              <NativeSelect id="ns-project" value={project} onChange={(e) => { setProject(e.target.value); setSharing(null) }}>
                <option value="">None, its own folder</option>
                {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </NativeSelect>
            </Field>
          )}
          {project ? (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="ns-wt">Work on a separate branch</FieldLabel>
                <FieldDescription>A worktree of its own, so several sessions can work in this project at once without colliding.</FieldDescription>
              </FieldContent>
              <Switch id="ns-wt" checked={worktree} onCheckedChange={setWorktree} />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="ns-cwd">Folder</FieldLabel>
              <Input id="ns-cwd" className="h-10 font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} autoCapitalize="none" />
              <FieldDescription>A new folder of its own in your projects folder (~/projects). Rename it, or pick an existing folder to work there.</FieldDescription>
            </Field>
          )}
          <Choice id="ns-agent" label="Agent" value={harness} onChange={(v) => { setHarness(v as Harness); setProfile('default'); setModel(''); setCustomModel(false) }}
            options={HARNESSES.map((h) => ({ value: h, label: HARNESS[h].label }))} description={agent.hint} />
          {missing && (
            <Alert variant="destructive">
              <AlertDescription>{agent.label} isn't installed on this server yet. An admin can install it from the <Link to="/server" className="underline" onClick={onClose}>Server page</Link>.</AlertDescription>
            </Alert>
          )}
          {harness === 'opencode' && !missing && listed.isSuccess && !offered?.length && (
            <Alert>
              <AlertDescription>OpenCode has no model provider connected yet. <Link to="/sessions/setup" className="underline" onClick={onClose}>Connect one</Link> first.</AlertDescription>
            </Alert>
          )}
          {profiles.length > 1 && (
            <Choice id="ns-profile" label={`${agent.label} profile`} value={profile} onChange={setProfile} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />
          )}
          {chosen && !chosen.loggedIn && (
            <Alert variant="destructive">
              <AlertDescription>This profile isn't signed in to Claude. <Link to="/sessions/setup" className="underline" onClick={onClose}>Sign in first</Link>.</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="ns-model">Model</FieldLabel>
            <ModelField id="ns-model" harness={harness} models={models} value={model} onChange={setModel} custom={customModel} onCustom={setCustomModel}
              note="Change it any time in the session." />
          </Field>
          <Choice id="ns-perm" label="Permissions" value={perm} onChange={(v) => setPerm(v as PermissionMode)}
            options={modes.map((p) => ({ value: p.value, label: p.label }))}
            description={PERMISSION_MODES.find((p) => p.value === perm)?.hint} />
          <Choice id="ns-sharing" label="Sharing" value={sharing} onChange={(v) => setSharing(v as SessionSharing)}
            options={[{ value: 'private', label: 'Private' }, { value: 'shared', label: 'Shared' }, { value: 'shared_can_send', label: 'Anyone can send' }]}
            description={`${sharing === 'private' ? 'Only you see it.' : sharing === 'shared' ? 'Everyone can watch; you choose who else can send.' : 'Everyone can watch and send messages.'}${project && !sharingPick ? ' The project\'s default.' : ''} Change it any time in the session.`} />
          <Choice id="ns-open" label="Open in" value={openIn} onChange={(v) => setOpenIn(v as 'chat' | 'cli')}
            options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]}
            description={openIn === 'cli' ? `${agent.cli}. You can switch to Chat any time.` : `A chat view of ${agent.label}. You can switch to the CLI any time.`} />
          <ErrorAlert error={create.error} />
          <Button type="submit" size="lg" className="h-10" disabled={create.isPending || !!missing || (customModel && !model.trim())}>
            {create.isPending && <Spinner />}Start session
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
