import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, X } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { commandsQuery, FALLBACK_MODELS, profilesQuery } from '../claude/data'
import { HARNESS, harnessOf, type Harness } from '../claude/harness'
import { modelLabel, type ModelInfo } from '../claude/models'

type State = Awaited<ReturnType<typeof fetchState>>
export type Entry = Awaited<ReturnType<typeof fetchRecent>>['entries'][number]
type Settings = State['settings']

const fetchState = () => unwrap(api.api.autopilot.$get())
const fetchRecent = () => unwrap(api.api.autopilot.log.$get({ query: { who: 'autopilot', limit: 10 } }))
export const KEY = ['autopilot'] as const

/** Each tier's colour: a dot, never an emoji, so the log reads calm. */
export const TIER: Record<string, { label: string; dot: string }> = {
  green: { label: 'Green', dot: 'bg-emerald-500' },
  yellow: { label: 'Yellow', dot: 'bg-amber-500' },
  red: { label: 'Needs you', dot: 'bg-red-500' },
  action: { label: 'Autopilot', dot: 'bg-sky-500' },
  system: { label: 'Setting', dot: 'bg-muted-foreground/50' },
}
const INBOX_KIND: Record<string, string> = { red: 'Your decision', stuck: 'Stuck', permission: 'Approval', thread: 'AI team' }

export const time = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const day = (s: number) => {
  const d = new Date(s * 1000)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

export function AutopilotPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: fetchState })
  // Here only what autopilot itself did, the last 10; everything is on the Activity page.
  const log = useQuery({ queryKey: [...KEY, 'log', 'recent'], queryFn: fetchRecent })
  useTopic('autopilot', () => void qc.invalidateQueries({ queryKey: KEY }))
  // Opening the page counts yellow decisions as seen (the morning ping only mentions newer ones); how many were new
  // stays shown until the page is left.
  const [unseen, setUnseen] = useState<number | null>(null)
  useEffect(() => {
    if (!q.data || unseen !== null) return
    setUnseen(q.data.unseenYellow)
    void unwrap(api.api.autopilot.seen.$post()).then((s) => qc.setQueryData(KEY, s)).catch(() => {})
  }, [q.data, unseen, qc])

  const set = (s: State) => qc.setQueryData(KEY, s)
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.api.autopilot.enabled.$put({ json: { enabled } })),
    onSuccess: (s) => {
      set(s)
      void qc.invalidateQueries({ queryKey: [...KEY, 'log'] })
    },
  })
  const s = q.data
  const entries = log.data?.entries ?? []

  return (
    <>
      <PageHeader title="Autopilot" description="Your sessions decide routine things for you" />
      <PageBody className="gap-8">
        <ErrorAlert error={q.error ?? toggle.error} />
        <section className="flex items-start gap-4 rounded-2xl bg-surface p-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="ap-on" className="text-base font-semibold">Autopilot is {s?.enabled ? 'on' : 'off'}</label>
            <p className="mt-1 text-sm text-muted-foreground">
              {s?.enabled
                ? 'Your sessions decide green and yellow things by your rules and log them here. Red always waits for you. Stalled sessions get a nudge when nobody is in them.'
                : 'Your sessions ask you as usual. Turn it on to let them decide routine things by your rules.'}
            </p>
            {s?.enabled && s.pausedUntil && (
              <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">The supervisor is paused until {day(s.pausedUntil)}, {time(s.pausedUntil)}.</p>
            )}
            {s?.enabled && <p className="mt-2 text-xs text-muted-foreground">{s.sentTonight} of {s.settings.nightCap} supervisor messages used since the last morning.</p>}
          </div>
          <Switch id="ap-on" className="mt-1" disabled={!s || toggle.isPending} checked={!!s?.enabled} onCheckedChange={(v) => toggle.mutate(v)} />
        </section>

        {s && s.inbox.length > 0 && <NeedsYou items={s.inbox} onChange={set} />}

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">What autopilot did</h2>
            <Link to="/autopilot/activity" className="text-sm font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">Show all</Link>
          </div>
          <ErrorAlert error={log.error} />
          {log.isSuccess && !entries.length && <p className="text-sm text-muted-foreground">Nothing yet. What autopilot approves, declines, answers or nudges shows up here.</p>}
          <Log entries={entries} />
          {!!unseen && (
            <Link to="/autopilot/activity" search={{ tier: 'yellow' }} className="text-sm text-amber-700 underline decoration-amber-500/40 underline-offset-4 dark:text-amber-400">
              {unseen} yellow decision{unseen === 1 ? '' : 's'} by your sessions since you last looked
            </Link>
          )}
          {log.data && log.data.total > entries.length && (
            <div><Button variant="outline" size="sm" asChild><Link to="/autopilot/activity">Show all {log.data.total}</Link></Button></div>
          )}
        </section>

        {s?.team && s.team.length > 0 && <TeamForm projects={s.team} onSaved={set} />}
        {s && <SupervisorForm supervisor={s.supervisor} onSaved={set} />}
        {s && <SettingsForm settings={s.settings} onSaved={set} />}
        {s && <RulesForm rules={s.rules} custom={s.customRules} onSaved={set} />}
      </PageBody>
    </>
  )
}

function NeedsYou({ items, onChange }: { items: State['inbox']; onChange: (s: State) => void }) {
  const dismiss = useMutation({
    mutationFn: (id: number) => unwrap(api.api.autopilot.inbox[':id'].dismiss.$post({ param: { id: String(id) } })),
    onSuccess: onChange,
  })
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Needs you <span className="text-muted-foreground">· {items.length}</span></h2>
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-3">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-red-500" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-red-700 dark:text-red-400">{INBOX_KIND[i.kind] ?? i.kind} · {day(i.createdAt)}, {time(i.createdAt)}</div>
              <div className="mt-0.5 text-sm font-medium">{i.title}</div>
              {i.detail && <div className="mt-0.5 text-sm text-muted-foreground">{i.detail}</div>}
              {i.session && (
                <Link to="/sessions/$id" params={{ id: i.session.id }} className="mt-1.5 inline-block text-sm font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
                  Open the session: {i.session.title}
                </Link>
              )}
              {!i.session && i.url && (
                <Link to={i.url} className="mt-1.5 inline-block text-sm font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
                  Open it
                </Link>
              )}
            </div>
            <Button variant="ghost" size="icon" aria-label="Dismiss" disabled={dismiss.isPending} onClick={() => dismiss.mutate(i.id)}><X /></Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Log({ entries }: { entries: Entry[] }) {
  const days: { day: string; entries: Entry[] }[] = []
  for (const e of entries) {
    const d = day(e.at)
    if (days.at(-1)?.day !== d) days.push({ day: d, entries: [] })
    days.at(-1)!.entries.push(e)
  }
  return (
    <div className="flex flex-col gap-5">
      {days.map((g) => (
        <div key={g.day} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.day}</h3>
          <ul className="divide-y rounded-2xl bg-surface">
            {g.entries.map((e) => <LogEntry key={e.id} e={e} />)}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function LogEntry({ e, withDay }: { e: Entry; withDay?: boolean }) {
  const t = TIER[e.tier] ?? TIER.system!
  return (
    <li className="flex gap-3 px-3 py-2.5">
      <span title={t.label} className={cn('mt-1.5 size-2 shrink-0 rounded-full', t.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{withDay ? `${day(e.at)}, ` : ''}{time(e.at)}</span>
          <span>{t.label}</span>
          {e.project && <span className="font-medium text-foreground/80">{e.project}</span>}
        </div>
        <div className="mt-0.5 text-sm break-words">{e.what}</div>
        {e.why && <div className="mt-0.5 text-sm text-muted-foreground italic break-words">{e.why}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {e.session && (
            <Link to="/sessions/$id" params={{ id: e.session.id }} className="text-xs font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
              {e.session.title ?? 'Session'}
            </Link>
          )}
          {e.message && (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                {/^(Approved|Declined)/.test(e.what) ? 'The request' : /^Answered/.test(e.what) ? 'The answer' : /^Continued|^Passed/.test(e.what) ? 'Message sent' : 'Details'}<ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-1 rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">{e.message}</p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  )
}

type Supervisor = State['supervisor']

function SupervisorForm({ supervisor, onSaved }: { supervisor: Supervisor; onSaved: (s: State) => void }) {
  const [v, setV] = useState(supervisor)
  useEffect(() => setV(supervisor), [supervisor])
  const save = useMutation({
    mutationFn: (p: Partial<Settings>) => unwrap(api.api.autopilot.settings.$patch({ json: p })),
    onSuccess: (s) => {
      onSaved(s)
      toast.success('Saved.')
    },
  })
  const dirty = JSON.stringify({ harness: v.harness, profile: v.profile, model: v.model, dailyCap: v.dailyCap })
    !== JSON.stringify({ harness: supervisor.harness, profile: supervisor.profile, model: supervisor.model, dailyCap: supervisor.dailyCap })

  const profiles = useQuery(profilesQuery)
  const agents = (profiles.data?.agents as { harness: string; installed: boolean; profiles: { name: string }[] }[] | undefined) ?? []
  const claudeProfiles = (profiles.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? []
  const installed = agents.filter((a) => a.installed).map((a) => a.harness)
  const availableAgents: Harness[] = (['claude' as const, ...installed.filter((h) => h !== 'claude')]).filter(
    (h, i, arr) => arr.indexOf(h) === i,
  ) as Harness[]

  const agentProfiles = v.harness === 'claude'
    ? claudeProfiles.map((p) => p.name)
    : (agents.find((a) => a.harness === v.harness)?.profiles ?? []).map((p) => p.name)

  const models = useQuery({ ...commandsQuery(v.profile, harnessOf({ harness: v.harness })), enabled: agentProfiles.includes(v.profile) })
  const offered = models.data?.models as ModelInfo[] | undefined
  const modelList: ModelInfo[] = offered?.length ? offered : v.harness === 'claude' ? FALLBACK_MODELS : [{ value: '', displayName: 'Default' }]

  const changeAgent = (h: string) => setV({ ...v, harness: h, profile: 'default', model: h === 'claude' ? 'sonnet' : '' })

  return (
    <SettingsSection title="Supervisor" description="Which agent, account and model the supervisor runs on. Stronger models judge better but use more of your plan; it runs every 10 minutes.">
      <FieldGroup>
        <ErrorAlert error={save.error} />
        <Row id="sv-agent" label="Agent" description="Only agents installed on this server.">
          <NativeSelect id="sv-agent" className="w-44" value={v.harness} onChange={(e) => changeAgent(e.target.value)}>
            {availableAgents.map((h) => <option key={h} value={h}>{HARNESS[h].label}</option>)}
          </NativeSelect>
        </Row>
        {agentProfiles.length > 1 && (
          <Row id="sv-profile" label="Account" description="Which of your profiles pays for supervisor calls.">
            <NativeSelect id="sv-profile" className="w-44" value={v.profile} onChange={(e) => setV({ ...v, profile: e.target.value, model: v.harness === 'claude' ? 'sonnet' : '' })}>
              {agentProfiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect>
          </Row>
        )}
        <Row id="sv-model" label="Model" description="The model the supervisor uses to read sessions and decide.">
          <NativeSelect id="sv-model" className="w-44" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })}>
            {modelList.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
          </NativeSelect>
        </Row>
        {v.harness !== 'claude' && (
          <Row id="sv-cap" label="Daily model-call cap" description="OpenCode plan usage can't be read, so the supervisor stops after this many model calls per day.">
            <Input id="sv-cap" type="number" inputMode="numeric" min={1} max={10000} className="w-24" value={v.dailyCap}
              onChange={(e) => setV({ ...v, dailyCap: Number(e.target.value) })} />
          </Row>
        )}
        <p className="text-xs text-muted-foreground">
          {supervisor.modelCallsToday} model call{supervisor.modelCallsToday === 1 ? '' : 's'} today
          {v.harness !== 'claude' && ` of ${supervisor.dailyCap}`}.
        </p>
        <div><Button disabled={!dirty || save.isPending} onClick={() => save.mutate({
          svHarness: v.harness, svProfile: v.profile, svModel: v.model, svDailyCap: v.dailyCap,
        })}>Save supervisor</Button></div>
      </FieldGroup>
    </SettingsSection>
  )
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: (s: State) => void }) {
  const [v, setV] = useState(settings)
  useEffect(() => setV(settings), [settings])
  const save = useMutation({
    mutationFn: (p: Partial<Settings>) => unwrap(api.api.autopilot.settings.$patch({ json: p })),
    onSuccess: (s) => {
      onSaved(s)
      toast.success('Saved.')
    },
  })
  const dirty = JSON.stringify(v) !== JSON.stringify(settings)
  const num = (k: 'quietMin' | 'nightCap' | 'maxNudges' | 'promptWaitMin') => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) })
  return (
    <SettingsSection title="Settings" description="When the supervisor may act, and how much.">
      <FieldGroup>
        <ErrorAlert error={save.error} />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="ap-approvals">Autopilot handles approvals</FieldLabel>
            <FieldDescription>
              Permission prompts and plans in your own sessions: green and yellow are approved, red is declined and lands in Needs you.
              A teammate's request that uses your access, and DevDash deploys, always wait for you.
            </FieldDescription>
          </FieldContent>
          <Switch id="ap-approvals" checked={settings.approvals} disabled={save.isPending} onCheckedChange={(on) => save.mutate({ approvals: on })} />
        </Field>
        <Row id="ap-wait" label="Wait before answering (minutes)" description="When a session asks something, you get this long to answer it yourself first. 1 to 5.">
          <Input id="ap-wait" type="number" inputMode="numeric" min={1} max={5} className="w-24" value={v.promptWaitMin} onChange={num('promptWaitMin')} />
        </Row>
        <Row id="ap-ping" label="Morning ping" description={`Only when something needs you or a yellow decision is new. Time zone: ${v.tz}.`}>
          <Input id="ap-ping" type="time" className="w-36" value={v.pingAt} onChange={(e) => setV({ ...v, pingAt: e.target.value })} />
        </Row>
        <Row id="ap-quiet" label="Quiet gap (minutes)" description="No nudge until a session has been quiet this long.">
          <Input id="ap-quiet" type="number" inputMode="numeric" min={5} className="w-24" value={v.quietMin} onChange={num('quietMin')} />
        </Row>
        <Row id="ap-cap" label="Nightly cap" description="Supervisor messages from one morning ping to the next.">
          <Input id="ap-cap" type="number" inputMode="numeric" min={0} className="w-24" value={v.nightCap} onChange={num('nightCap')} />
        </Row>
        <Row id="ap-nudges" label="Nudges per goal" description="Then the session goes to Needs you.">
          <Input id="ap-nudges" type="number" inputMode="numeric" min={1} max={10} className="w-24" value={v.maxNudges} onChange={num('maxNudges')} />
        </Row>
        <div><Button disabled={!dirty || save.isPending} onClick={() => save.mutate(v)}>Save settings</Button></div>
      </FieldGroup>
    </SettingsSection>
  )
}

function Row({ id, label, description, children }: { id: string; label: string; description: string; children: React.ReactNode }) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      {children}
    </Field>
  )
}

function RulesForm({ rules, custom, onSaved }: { rules: string; custom: boolean; onSaved: (s: State) => void }) {
  const [text, setText] = useState(rules)
  useEffect(() => setText(rules), [rules])
  const save = useMutation({
    mutationFn: (r: string | null) => unwrap(api.api.autopilot.rules.$put({ json: { rules: r } })),
    onSuccess: (s) => {
      onSaved(s)
      toast.success('Rules saved. Sessions get them with your next message.')
    },
  })
  return (
    <SettingsSection title="Your rules" description="Green: decide and carry on. Yellow: decide and log it for you. Red: always ask you. Sessions and the supervisor follow these.">
      <Collapsible className="flex flex-col gap-3">
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="group self-start">
            {custom ? 'Your own rules' : 'Default rules'}<ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          <ErrorAlert error={save.error} />
          <Textarea aria-label="Autopilot rules" className="h-[28rem] [field-sizing:fixed] overflow-y-auto font-mono text-xs leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={text === rules || save.isPending} onClick={() => save.mutate(text)}>Save rules</Button>
            {custom && <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>Reset to default</Button>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SettingsSection>
  )
}

/** Per project with an AI team: whether autopilot answers its role agents' asks (proposals, questions) for the member. */
function TeamForm({ projects, onSaved }: { projects: NonNullable<State['team']>; onSaved: (s: State) => void }) {
  const save = useMutation({
    mutationFn: (p: { id: number; on: boolean }) => unwrap(api.api.autopilot.team[':projectId'].$put({ param: { projectId: String(p.id) }, json: { on: p.on } })),
    onSuccess: onSaved,
  })
  return (
    <SettingsSection title="AI team" description="Proposals and questions from a project's role agents (like its CEO). After 30 minutes without a teammate answering, autopilot approves or answers green and yellow ones for you. It never declines; the rest lands in Needs you.">
      <FieldGroup>
        <ErrorAlert error={save.error} />
        {projects.map((p) => (
          <Field key={p.id} orientation="horizontal">
            <FieldContent><FieldLabel htmlFor={`ap-team-${p.id}`}>{p.name}</FieldLabel></FieldContent>
            <Switch id={`ap-team-${p.id}`} checked={p.on} disabled={save.isPending} onCheckedChange={(on) => save.mutate({ id: p.id, on })} />
          </Field>
        ))}
      </FieldGroup>
    </SettingsSection>
  )
}
