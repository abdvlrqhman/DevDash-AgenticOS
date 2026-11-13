import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, CalendarClock, Ellipsis, ExternalLink, History, Maximize2, Minimize2, Minus, Settings2, SlidersHorizontal, SquarePen, Trash2 } from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { modeLabel, profilesQuery, relativeTime, sessionQuery, STATUS_LABEL, type Session } from '../claude/data'
import { HARNESS, HARNESSES, harnessOf, type Harness } from '../claude/harness'
import { ModelMenu, SessionView, type Updater } from '../claude/SessionPage'
import { AgentGlyph, assistantQuery } from './AssistantDock'
import { AGENT_NAME, pageTag, panelCoversPage, setAssistantOpen, showingSession, toggleBig, useBig } from './store'

type State = Awaited<ReturnType<typeof assistantQuery.queryFn & {}>>
type Schedule = State['schedules'][number]
type View = 'chat' | 'schedules' | 'history' | 'settings'
type AgentInfo = { harness: string; installed: boolean; profiles: { name: string }[] }

/** The heading of the page the person is on (not the panel's own), for the agent's sense of "this". */
const pageHeading = () => [...document.querySelectorAll('h1')].find((h) => !h.closest('[data-assistant]'))?.textContent?.trim() || document.title
const closeOnPhones = () => { if (panelCoversPage()) setAssistantOpen(false) }

export function AssistantPanel() {
  const q = useQuery(assistantQuery)
  const [view, setView] = useState<View>('chat')
  const back = () => setView('chat')
  if (q.error) return <><Bar title={AGENT_NAME} /><div className="p-3"><ErrorAlert error={q.error} /></div></>
  if (!q.data) return <><Bar title={AGENT_NAME} /><div className="flex flex-col gap-3 p-3">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div></>
  const st = q.data
  if (!st.agent || view === 'settings') return <Setup st={st} onDone={back} onBack={st.agent ? back : undefined} />
  if (view === 'schedules') return <Schedules list={st.schedules} onBack={back} />
  if (view === 'history') return <Conversations current={st.sessionId} onBack={back} />
  return <Chat st={st} onView={setView} />
}

/** Expand (not on phones, where the chat is the whole screen already) and minimize, at the end of every top bar. */
function WindowButtons() {
  const big = useBig()
  return (
    <>
      <Button variant="ghost" size="icon" className="max-sm:hidden" aria-label={big ? 'Make smaller' : 'Expand'} title={big ? 'Make smaller' : 'Expand'} onClick={toggleBig}>
        {big ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button variant="ghost" size="icon" aria-label="Minimize" title="Minimize (Esc, ⌘I)" onClick={() => setAssistantOpen(false)}><Minus /></Button>
    </>
  )
}

/** The chat's top bar for its inner views: back, title, the window's buttons. */
function Bar({ title, onBack, children }: { title: ReactNode; onBack?: () => void; children?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-0.5 border-b px-2 pt-[env(safe-area-inset-top)]">
      {onBack && <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}><ArrowLeft /></Button>}
      <div className={cn('min-w-0 flex-1 truncate text-sm font-semibold', !onBack && 'pl-1')}>{title}</div>
      {children}
      <WindowButtons />
    </header>
  )
}

function Chat({ st, onView }: { st: State; onView: (v: View) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const id = st.sessionId
  useEffect(() => { showingSession(id); return () => showingSession(null) }, [id])
  const session = useQuery({ ...sessionQuery(id ?? ''), enabled: !!id }).data?.session
  const status = session?.status ?? null
  const set = (r: State) => qc.setQueryData(assistantQuery.queryKey, r)
  const fresh = useMutation({ mutationFn: () => unwrap(api.api.assistant.new.$post()), onSuccess: set, onError: (e) => toast.error(e.message) })
  const settings = useSettings()
  const agent = st.agent!
  const active = st.schedules.filter((s) => s.enabled).length

  const header = (
    <header className="flex min-h-12 shrink-0 items-center gap-0.5 border-b pt-[env(safe-area-inset-top)] pr-2 pl-3">
      <AgentGlyph status={status} className="mr-1.5" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold">{AGENT_NAME}</div>
        <div className="truncate text-xs text-muted-foreground">
          {status === 'working' || status === 'waiting' ? STATUS_LABEL[status] : describe(agent, session)}
        </div>
      </div>
      {/* Model, effort and permission level, one tap away; kept for new conversations too. */}
      {session && <ModelMenu s={session} disabled={false} isOwner compact onUpdate={settings} />}
      <Button variant="ghost" size="icon" aria-label="New conversation" title="New conversation" disabled={fresh.isPending} onClick={() => fresh.mutate()}><SquarePen /></Button>
      <Button variant="ghost" size="icon" aria-label={`Schedules${active ? ` (${active} on)` : ''}`} title="Schedules" className="relative" onClick={() => onView('schedules')}>
        <CalendarClock />
        {active > 0 && <span className="absolute top-1 right-1 min-w-3.5 rounded-full bg-muted px-0.5 text-[9px] leading-3.5 font-semibold text-foreground tabular-nums">{active}</span>}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More"><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={() => onView('history')}><History />Past conversations</DropdownMenuItem>
          {id && <DropdownMenuItem onSelect={() => { closeOnPhones(); void navigate({ to: '/sessions/$id', params: { id } }) }}><ExternalLink />Open as a full page</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onView('settings')}><Settings2 />Settings and access…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WindowButtons />
    </header>
  )
  if (!id) {
    return <>{header}<div className="p-4"><Button onClick={() => fresh.mutate()} disabled={fresh.isPending}>Start a conversation</Button></div></>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionView key={id} id={id} embedded={{
        header,
        name: AGENT_NAME,
        empty: (send) => <Starters send={send} />,
        prefix: () => pageTag(`${location.pathname}${location.search}`, pageHeading()),
      }} />
    </div>
  )
}

/** "Claude Code · Opus · Ask first": what it runs on and how, under its name. */
function describe(agent: NonNullable<State['agent']>, s: Session | undefined) {
  const model = (s?.model ?? agent.model)?.replace(/^.*\//, '')
  return [HARNESS[agent.harness].label, model, modeLabel(s?.permissionMode ?? agent.permissionMode)].filter(Boolean).join(' · ')
}

/** Changes Hamasa's settings: kept for new conversations, and the current one follows (the server applies both). */
function useSettings(): Updater {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (json: Parameters<typeof api.api.assistant.$patch>[0]['json']) => unwrap(api.api.assistant.$patch({ json })),
    onSuccess: (r) => qc.setQueryData(assistantQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  const sessionOnly = useMutation({
    mutationFn: ({ id, ...json }: { id: string; remoteControl?: boolean; advisorModel?: 'sonnet' | 'opus' | 'fable' | null }) => unwrap(api.api.claude.sessions[':id'].$patch({ param: { id }, json })),
    onError: (e) => toast.error(e.message),
  })
  const id = useQuery(assistantQuery).data?.sessionId
  return ({ model, effort, permissionMode, fastMode, reachTailnet, remoteControl, advisorModel }) => {
    // Remote Control and the advisor belong to this conversation only, not to Hamasa's settings.
    if (remoteControl !== undefined || advisorModel !== undefined) return void (id && sessionOnly.mutate({ id, remoteControl, advisorModel }))
    m.mutate({ model, effort, permissionMode, fastMode, reachTailnet })
  }
}

const STARTERS = [
  { label: 'What needs me today?', text: 'What needs my attention today? Check my tasks, sessions waiting on me, and anything failing.' },
  { label: 'Explain this page', text: 'What matters on this page right now?' },
  { label: 'Morning brief, every weekday', text: 'Every weekday at 9:00, brief me: my open tasks by priority, sessions waiting on me, and services that are down. Notify me only if something needs me.' },
  { label: 'What did my sessions do?', text: 'Summarize what my sessions did today and what each one is waiting for.' },
]

/** Before the first message: what the agent can do (in a sentence) and a few ways to start. */
function Starters({ send }: { send: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-4 py-6">
      <p className="text-sm text-pretty text-muted-foreground">
        {AGENT_NAME} is your own agent across every project you can see. It answers from tasks, notes, sessions and services, starts and steers sessions for you,
        and runs schedules. It asks before it changes anything.
      </p>
      <div className="flex flex-col gap-1.5">
        {STARTERS.map((s) => (
          <button key={s.label} type="button" onClick={() => send(s.text)}
            className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Picking the agent (Claude Code or OpenCode) and the account it runs on. */
function Setup({ st, onDone, onBack }: { st: State; onDone: () => void; onBack?: () => void }) {
  const current = st.agent
  const qc = useQueryClient()
  const setup = useQuery(profilesQuery)
  const agents = setup.data?.agents as AgentInfo[] | undefined
  const [harness, setHarness] = useState<Harness | null>(current?.harness ?? null)
  const [profile, setProfile] = useState(current?.profile ?? 'default')
  const picked = harness ?? harnessOf(setup.data?.defaults)
  useEffect(() => { if (!current && setup.data && harness === null) setProfile(setup.data.defaults.profile) }, [current, setup.data, harness])
  const installed = (h: Harness) => h === 'claude' || !!agents?.find((a) => a.harness === h)?.installed
  const profiles = picked === 'claude'
    ? ((setup.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? [])
    : (agents?.find((a) => a.harness === picked)?.profiles ?? []).map((p) => ({ name: p.name, loggedIn: true }))
  const chosen = profiles.find((p) => p.name === profile) ? profile : (profiles[0]?.name ?? 'default')
  const save = useMutation({
    mutationFn: () => unwrap(api.api.assistant.$put({ json: { harness: picked, profile: chosen, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } })),
    onSuccess: (r) => { qc.setQueryData(assistantQuery.queryKey, r); onDone() },
  })
  const restarts = !!current && (current.harness !== picked || current.profile !== chosen)
  return (
    <>
      <Bar title={current ? 'Settings and access' : `Meet ${AGENT_NAME}`} onBack={onBack} />
      <form className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        {!current && (
          <p className="text-sm text-pretty text-muted-foreground">
            {AGENT_NAME} is your own agent, beside every page. It works for you across every project you can see: it answers questions, manages your tasks,
            notes and schedules, starts sessions and keeps an eye on them, and asks before it changes anything. Pick what it runs on.
          </p>
        )}
        {setup.isPending ? <Skeleton className="h-28" /> : (
          <RadioGroup value={picked} onValueChange={(v) => setHarness(v as Harness)} className="gap-2">
            {HARNESSES.map((h) => (
              <label key={h} className={cn('flex items-start gap-3 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary', !installed(h) && 'opacity-60')}>
                <RadioGroupItem value={h} disabled={!installed(h)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-medium">{HARNESS[h].label}</span>
                  <span className="block text-muted-foreground">{installed(h) ? HARNESS[h].hint : 'Not installed on this server: an admin installs it on the Server page.'}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
        {profiles.length > 1 && (
          <Field>
            <FieldLabel htmlFor="agent-profile">Account</FieldLabel>
            <NativeSelect id="agent-profile" value={chosen} onChange={(e) => setProfile(e.target.value)}>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}{p.loggedIn ? '' : ' (not signed in)'}</option>)}
            </NativeSelect>
            <FieldDescription>Its sign-in and settings. Add accounts in <Link to="/sessions/setup" className="underline" onClick={closeOnPhones}>Agent setup</Link>.</FieldDescription>
          </Field>
        )}
        {profiles.find((p) => p.name === chosen)?.loggedIn === false && (
          <p className="text-sm text-attention-foreground">This account isn't signed in. Sign in under <Link to="/sessions/setup" className="underline" onClick={closeOnPhones}>Agent setup</Link> first.</p>
        )}
        {restarts && <p className="text-xs text-muted-foreground">This starts a new conversation; the current one stays under Past conversations.</p>}
        <ErrorAlert error={save.error} />
        {(!current || restarts) && <div><Button type="submit" disabled={save.isPending || setup.isPending}>{current ? 'Switch' : 'Start'}</Button></div>}
        {current && <Access st={st} />}
      </form>
    </>
  )
}

/**
 * What Hamasa reaches beyond DevDash. It runs as the member, so their files, GitHub sign-in and the agent's own
 * connectors are always there, behind the permission level; these two are set up for it only when switched on.
 */
function Access({ st }: { st: State }) {
  const qc = useQueryClient()
  const a = st.agent!
  const save = useMutation({
    mutationFn: (json: { reachTailnet?: boolean; drive?: boolean }) => unwrap(api.api.assistant.$patch({ json })),
    onSuccess: (r) => qc.setQueryData(assistantQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  const rows = [
    { key: 'reachTailnet' as const, label: 'Your tailnet', on: a.reachTailnet, connected: st.connected.tailnet, where: '/network', page: 'Network',
      hint: 'Your Tailscale devices: it can check them and connect to them (ssh, web pages, APIs).' },
    { key: 'drive' as const, label: 'Your Google Drive', on: a.drive && st.connected.drive, connected: st.connected.drive, where: '/storage', page: 'Storage',
      hint: 'Read and save files in your DevDash folder on Drive.' },
  ]
  return (
    <section className="flex flex-col gap-3 border-t pt-5">
      <div>
        <h2 className="text-sm font-semibold">Access</h2>
        <p className="mt-1 text-xs text-pretty text-muted-foreground">
          {AGENT_NAME} works as you: every project, task, note, session and service you can see, your files, and your GitHub sign-in. The permission
          level (<SlidersIcon />) decides what it does without asking.
        </p>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{r.label}</div>
            <div className="text-xs text-muted-foreground">
              {r.connected ? r.hint : <>Not connected. Connect it on the <Link to={r.where} className="underline" onClick={closeOnPhones}>{r.page}</Link> page first.</>}
            </div>
          </div>
          <Switch checked={r.on} disabled={!r.connected || save.isPending} aria-label={r.label} onCheckedChange={(v) => save.mutate({ [r.key]: v })} />
        </div>
      ))}
    </section>
  )
}
const SlidersIcon = () => <SlidersHorizontal className="inline size-3 align-[-1px]" aria-label="the sliders button" />

const fmt = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Goes on in an earlier conversation: the panel switches to it. */
function useResume(onDone: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.api.assistant.conversations[':id'].$post({ param: { id } })),
    onSuccess: (r) => { qc.setQueryData(assistantQuery.queryKey, r); onDone() },
    onError: (e) => toast.error(e.message),
  })
}

/**
 * What runs by itself: each schedule's prompt and time, paused or on, and when it runs next. The agent makes them. Each
 * runs in a conversation of its own, never the one being chatted in.
 */
function Schedules({ list, onBack }: { list: Schedule[]; onBack: () => void }) {
  const qc = useQueryClient()
  const resume = useResume(onBack)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['assistant'] })
  const toggle = useMutation({
    mutationFn: (s: Schedule) => unwrap(api.api.assistant.schedules[':id'].$patch({ param: { id: String(s.id) }, json: { enabled: !s.enabled } })),
    onSuccess: refresh, onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (s: Schedule) => unwrap(api.api.assistant.schedules[':id'].$delete({ param: { id: String(s.id) } })),
    onSuccess: refresh, onError: (e) => toast.error(e.message),
  })
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <>
      <Bar title="Schedules" onBack={onBack} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {!list.length && (
          <p className="p-1 text-sm text-pretty text-muted-foreground">
            Nothing scheduled. Ask {AGENT_NAME}, like “every weekday at 9, tell me what needs me” or “tomorrow at 3 pm, check the shop deploy”. It
            runs the prompt at that time in a conversation of its own, even when DevDash isn't open, and notifies you when something needs you.
          </p>
        )}
        {list.map((s) => (
          <div key={s.id} className={cn('flex flex-col gap-1.5 rounded-lg border p-3 text-sm', !s.enabled && 'text-muted-foreground')}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{s.title}</span>
              {(s.runAt == null || s.enabled) && (
                <Switch checked={s.enabled} onCheckedChange={() => toggle.mutate(s)} aria-label={s.enabled ? `Pause ${s.title}` : `Resume ${s.title}`} />
              )}
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.title}`} onClick={async () => {
                if (await confirmAction({ title: `Delete “${s.title}”?`, action: 'Delete', destructive: true })) remove.mutate(s)
              }}><Trash2 /></Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {s.when}{s.tz !== myTz && ` (${s.tz})`}
              {' · '}{s.next ? `next ${fmt(s.next)}` : s.runAt != null && s.lastRunAt ? `ran ${relativeTime(s.lastRunAt)}` : 'paused'}
            </div>
            <p className="line-clamp-2 text-xs">{s.prompt}</p>
            {s.conversation && (
              <Button variant="link" size="sm" className="h-auto self-start p-0 text-xs" disabled={resume.isPending} onClick={() => resume.mutate(s.conversation!)}>
                <History />Open its runs
              </Button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** Earlier conversations with the agent: pick one to carry on in it. */
function Conversations({ current, onBack }: { current: string | null; onBack: () => void }) {
  const q = useQuery({ queryKey: ['assistant', 'conversations'], queryFn: () => unwrap(api.api.assistant.conversations.$get()), staleTime: 0 })
  const resume = useResume(onBack)
  return (
    <>
      <Bar title="Past conversations" onBack={onBack} />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        <ErrorAlert error={q.error} />
        {q.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
        {q.data && !q.data.conversations.length && <p className="p-2 text-sm text-muted-foreground">No earlier conversations yet.</p>}
        {q.data?.conversations.map((c) => (
          <button key={c.id} type="button" disabled={resume.isPending} onClick={() => (c.id === current ? onBack() : resume.mutate(c.id))}
            className="flex flex-col rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="truncate font-medium">{c.title}</span>
            <span className="text-xs text-muted-foreground">
              {c.id === current ? 'Current · ' : ''}{relativeTime(c.lastActivityAt)} · {HARNESS[harnessOf(c)].label}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
