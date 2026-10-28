import { useEffect, useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Archive, ChevronRight, Plus, Settings2, Sparkles, ChevronDown } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { NativeSelect } from '@/components/app/native-select'
import { Switch } from '@/components/ui/switch'
import { projectsQuery, type SessionSharing } from '../work/data'
import { useArchiveSession } from './ArchiveSession'
import { ModelChoices } from './ModelChoices'
import { groupModels, isDefaultModel, modelLabel, type ModelInfo } from './models'
import { byFolder, commandsQuery, FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, relativeTime, sessionPlace, sessionsQuery, shortPath, type PermissionMode, type Session } from './data'

export function SessionsPage() {
  const me = useQuery(meQuery).data!
  const [archived, setArchived] = useState(false)
  const list = useQuery(sessionsQuery(archived))
  const [creating, setCreating] = useState(false)
  const archive = useArchiveSession()

  const sessions = list.data?.sessions ?? []
  const waiting = sessions.filter((s) => s.status === 'waiting')
  const groups = byFolder(archived ? sessions : sessions.filter((s) => s.status !== 'waiting'))

  return (
    <>
      <PageHeader title={archived ? 'Archived sessions' : 'Claude'}
        actions={<>
          <Button variant="ghost" size="icon" asChild aria-label="Claude setup"><Link to="/claude/setup"><Settings2 /></Link></Button>
          <Button size="sm" onClick={() => setCreating(true)}><Plus />New</Button>
        </>} />
      <PageBody>
        <ErrorAlert error={list.error} />
        {list.isPending && <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>}
        {!archived && waiting.length > 0 && (
          <Section title="Needs you">
            <ItemGroup className="gap-2">
              {waiting.map((s) => <SessionRow key={s.id} s={s} me={me.id} highlight onArchive={archive.ask} />)}
            </ItemGroup>
          </Section>
        )}
        {groups.map((g) => (
          <SessionList key={g.key} title={<span title={g.path}>{g.label}</span>} sessions={g.sessions} me={me.id} onArchive={archived ? undefined : archive.ask} />
        ))}
        {list.isSuccess && !sessions.length && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">{archived ? <Archive /> : <Sparkles />}</EmptyMedia>
              <EmptyTitle>{archived ? 'Nothing archived' : 'No sessions yet'}</EmptyTitle>
              <EmptyDescription>{archived ? 'Archived sessions show up here.' : 'Start a session and Claude works on the server as you, even after you close the app.'}</EmptyDescription>
            </EmptyHeader>
            {!archived && <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>}
          </Empty>
        )}
        <div>
          <Button variant="link" size="sm" className="h-auto p-0 text-muted-foreground" onClick={() => setArchived(!archived)}>
            {archived ? 'Back to active sessions' : 'Show archived sessions'}
          </Button>
        </div>
      </PageBody>
      {archive.dialog}
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')

function SessionRow({ s, me, highlight, onArchive }: { s: Session; me: number; highlight?: boolean; onArchive?: (s: Session) => void }) {
  return (
    <div className={cn('flex items-center', highlight ? '' : 'border-b last:border-b-0')}>
    <Item asChild className={cn('min-w-0 flex-1', highlight ? 'border-attention/40 bg-attention-soft' : 'rounded-none border-0')}>
      <Link to="/claude/$id" params={{ id: s.id }}>
        <ItemMedia><StatusLight state={light(s)} /></ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-1">{s.title}</ItemTitle>
          <ItemDescription className="line-clamp-1">
            {s.owner.id !== me && <span className="text-foreground">{s.owner.name.split(' ')[0]}, </span>}
            {s.status === 'working' ? 'Working' : s.status === 'waiting' ? 'Needs you' : relativeTime(s.lastActivityAt)}{highlight ? <>, {sessionPlace(s)}</> : null}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {s.mode === 'cli' && <Badge variant="outline">CLI</Badge>}
          {s.owner.id === me && s.audience !== 'private' && <Badge variant="secondary">{s.audience === 'people' ? `Shared with ${s.sharedWith}` : 'Shared'}</Badge>}
          {s.owner.id !== me && <UserAvatar user={s.owner} className="size-7" textClassName="text-[11px]" />}
          <ChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Link>
    </Item>
    {onArchive && s.owner.id === me && !s.archived && (
      <Button size="icon-sm" variant="ghost" className="mr-1.5 shrink-0 text-muted-foreground" aria-label={`Archive ${s.title}`} onClick={() => onArchive(s)}><Archive /></Button>
    )}
    </div>
  )
}

function SessionList({ title, sessions, me, onArchive }: { title?: React.ReactNode; sessions: Session[]; me: number; onArchive?: (s: Session) => void }) {
  return (
    <Section title={title}>
      <ItemGroup className="rounded-xl border">{sessions.map((s) => <SessionRow key={s.id} s={s} me={me} onArchive={onArchive} />)}</ItemGroup>
    </Section>
  )
}

function Choice({ id, label, value, options, onChange, description }: {
  id: string; label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; description?: string
}) {
  return (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup type="single" variant="outline" aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onChange(v)} className="w-full flex-wrap">
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className="flex-1">{o.label}</ToggleGroupItem>)}
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
    setProfile(d.profile)
    setModel(d.model ?? '')
    setPerm(d.permission_mode as PermissionMode)
    setOpenIn(d.open_in)
  }, [d])
  useEffect(() => { if (open) { setPrompt(initialPrompt); setCwd(initialCwd ?? sessionFolder()); setProject(initialProject ?? ''); setSharing(null) } }, [open, initialPrompt, initialCwd, initialProject])

  const profiles = (setup.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? []
  const chosen = profiles.find((p) => p.name === profile)
  // The models this Claude Code offers (with their versions in the description); a fixed list until it answers.
  const offered = useQuery({ ...commandsQuery(profile), enabled: open }).data?.models as ModelInfo[] | undefined
  const models: ModelInfo[] = offered?.length ? offered : FALLBACK_MODELS
  const pickedModel = customModel ? undefined : isDefaultModel(model) ? groupModels(models).def : models.find((m) => m.value === model)
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions.$post({
      json: {
        prompt, images: [], cwd, profile, model: model && model !== 'default' ? model.trim() : null, effort: null, permissionMode: perm, mode: openIn,
        project: project || undefined, worktree: project ? worktree : undefined,
        ...(sharingPick && { shared: sharingPick !== 'private', sharedCanSend: sharingPick === 'shared_can_send' }),
        cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))),
      },
    })),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] })
      onClose()
      navigate({ to: '/claude/$id', params: { id: session.id } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!create.isPending) create.mutate()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && onClose()} title="New session" description="Claude works in this folder as you, and keeps going when you close the app.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          {/* Only when started from something to hand over (a task); otherwise you write to Claude in the session. */}
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
          {profiles.length > 1 && (
            <Choice id="ns-profile" label="Claude profile" value={profile} onChange={setProfile} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />
          )}
          {chosen && !chosen.loggedIn && (
            <Alert variant="destructive">
              <AlertDescription>This profile isn't signed in to Claude. <Link to="/claude/setup" className="underline" onClick={onClose}>Sign in first</Link>.</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="ns-model">Model</FieldLabel>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button id="ns-model" type="button" variant="outline" className="h-10 w-full justify-between font-normal">
                  <span className="truncate">{customModel ? 'Another model' : modelLabel(models, model)}</span><ChevronDown className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-(--radix-dropdown-menu-trigger-width) max-w-none overflow-y-auto">
                <ModelChoices models={models} value={customModel ? null : model || null} onChange={(v) => { setCustomModel(false); setModel(v ?? '') }} />
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => { setCustomModel(true); setModel('') }}>Another model (enter its ID)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {customModel && (
              <Input aria-label="Model ID" className="h-10 font-mono" placeholder="claude-opus-4-1" value={model} onChange={(e) => setModel(e.target.value)}
                spellCheck={false} autoCapitalize="none" autoFocus />
            )}
            <FieldDescription>
              {customModel ? 'Any model ID Claude Code accepts, for a specific version.'
                : pickedModel?.description ? `${pickedModel.description}${pickedModel.value && !pickedModel.value.startsWith('claude-') && !isDefaultModel(pickedModel.value) ? '. Always its newest version.' : ''}`
                : 'Change it any time in the session.'}
            </FieldDescription>
          </Field>
          <Choice id="ns-perm" label="Permissions" value={perm} onChange={(v) => setPerm(v as PermissionMode)}
            options={PERMISSION_MODES.slice(0, 4).map((p) => ({ value: p.value, label: p.label }))}
            description={PERMISSION_MODES.find((p) => p.value === perm)?.hint} />
          <Choice id="ns-sharing" label="Sharing" value={sharing} onChange={(v) => setSharing(v as SessionSharing)}
            options={[{ value: 'private', label: 'Private' }, { value: 'shared', label: 'Shared' }, { value: 'shared_can_send', label: 'Anyone can send' }]}
            description={`${sharing === 'private' ? 'Only you see it.' : sharing === 'shared' ? 'Everyone can watch; you choose who else can send.' : 'Everyone can watch and send messages.'}${project && !sharingPick ? ' The project\'s default.' : ''} Change it any time in the session.`} />
          <Choice id="ns-open" label="Open in" value={openIn} onChange={(v) => setOpenIn(v as 'chat' | 'cli')}
            options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]}
            description={openIn === 'cli' ? 'The real Claude Code terminal. You can switch to Chat any time.' : 'A chat view of Claude Code. You can switch to the CLI any time.'} />
          <ErrorAlert error={create.error} />
          <Button type="submit" size="lg" className="h-10" disabled={create.isPending || (customModel && !model.trim())}>
            {create.isPending && <Spinner />}Start session
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
