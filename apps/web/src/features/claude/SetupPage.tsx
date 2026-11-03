import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LogIn, Plus, RotateCw } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, type PermissionMode } from './data'
import { describeMemory, memoryQuery } from './memory'

type Profile = { name: string; loggedIn: boolean; authMethod: string | null; email: string | null; plan: string | null; memory: boolean }
type Defaults = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

const profileName = (p: Profile) => (p.name === 'default' ? 'Default' : p.name)

export function SetupPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(profilesQuery)
  const profiles = (q.data?.profiles as Profile[] | undefined) ?? []
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.profiles.$post({ json: { name } })),
    onSuccess: () => {
      toast.success(`Profile ${name} added`)
      setName('')
      void qc.invalidateQueries({ queryKey: profilesQuery.queryKey })
    },
  })
  const login = (p: string) => navigate({ to: '/terminal', search: { open: `login-${p}` } })

  return (
    <>
      <PageHeader title="Claude setup" back="/claude" />
      <PageBody className="gap-12 py-8 md:py-12">
        <Group title="Profiles" description="A profile is its own Claude configuration: settings, skills, agents, plugins, memory and sign-in. The same Claude account can sign in to any number of profiles.">
          <ErrorAlert error={q.error} />
          {/* Whether Claude can work at all: each profile's sign-in, the boldest thing on the page. */}
          {q.isPending ? <Skeleton className="h-[4.5rem] rounded-2xl" /> : (
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {profiles.map((p) => (
                <li key={p.name} className="flex items-center gap-3 rounded-xl px-3 py-3">
                  <span className="flex size-5 shrink-0 items-center justify-center"><StatusLight state={p.loggedIn ? 'live' : 'idle'} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{profileName(p)}</span>
                    <span className="block text-sm text-pretty text-muted-foreground">
                      {p.loggedIn ? [p.email, p.plan, p.authMethod === 'apiKey' ? 'API key' : null].filter(Boolean).join(', ') || 'Signed in' : 'Not signed in. Sessions can’t start with it yet.'}
                    </span>
                  </span>
                  {p.loggedIn
                    ? <Button size="sm" variant="ghost" className="hover:bg-surface-2 dark:hover:bg-surface-2" onClick={() => login(p.name)}><LogIn />Sign in again</Button>
                    : <Button size="sm" onClick={() => login(p.name)}><LogIn />Sign in</Button>}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name) create.mutate() }} className="flex items-end gap-2">
            <Field className="flex-1">
              <FieldLabel htmlFor="new-profile">New profile</FieldLabel>
              <Input id="new-profile" placeholder="work" value={name} maxLength={21} className="h-9"
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
            </Field>
            <Button type="submit" variant="outline" className="h-9" disabled={!name || create.isPending}><Plus />Add</Button>
          </form>
          <ErrorAlert error={create.error} />
          <p className="text-sm text-pretty text-muted-foreground">
            Signing in opens a terminal running Claude's own sign-in. Open the link it prints, approve, then paste the code back. DevDash never sees your Claude credentials.
          </p>
        </Group>
        {!q.isPending && profiles.length > 0 && <MemorySection profiles={profiles} />}
        {q.data && <DefaultsCard profiles={profiles} initial={q.data.defaults} />}
      </PageBody>
    </>
  )
}

/** A settings group: what it is on the left (wide screens), its controls on the right; stacked on phones. No rules between. */
function Group({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-12">
      <div className="min-w-0 lg:pt-1">
        <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
        {description && <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  )
}

/** A segmented choice: pills on a track one tone off whatever it sits on (here, a surface panel). */
const track = 'rounded-2xl bg-background p-1 data-[size=sm]:rounded-2xl'
const pill = 'rounded-xl'

/** Per profile: Claude Code's own memory (the default) or claude-mem on top of it. */
function MemorySection({ profiles }: { profiles: Profile[] }) {
  return (
    <Group title="Memory" description="Claude Code remembers through CLAUDE.md files and its own auto memory. claude-mem adds to that: it records what Claude does and brings the relevant parts back in later sessions, searchable across projects. It summarizes in the background with your Claude plan, and new sessions pick the change up.">
      <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
        {profiles.map((p) => <MemoryRow key={p.name} profile={p} />)}
      </ul>
      {profiles.some((p) => p.memory) && <MemoryHealthRow />}
    </Group>
  )
}

/** The member's claude-mem worker (one per person, shared by their profiles). */
function MemoryHealthRow() {
  const qc = useQueryClient()
  const q = useQuery(memoryQuery)
  const restart = useMutation({
    mutationFn: () => unwrap(api.api.claude.memory.restart.$post()),
    onSuccess: () => { toast.success('claude-mem restarted.'); void qc.invalidateQueries({ queryKey: memoryQuery.queryKey }) },
  })
  if (q.isPending) return <Skeleton className="h-14 rounded-2xl" />
  if (q.error) return <ErrorAlert error={q.error} />
  const h = q.data.health
  const d = describeMemory(h)
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-surface px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center"><StatusLight state={d.light} /></span>
        <div className="min-w-0 flex-1 text-sm">
          <div className={d.light === 'error' ? 'text-destructive' : undefined}>{d.text}</div>
          {h.version && <div className="text-xs text-muted-foreground">claude-mem <span className="tabular-nums">{h.version}</span></div>}
        </div>
        {h.state !== 'off' && <Button size="sm" variant="ghost" className="hover:bg-surface-2 dark:hover:bg-surface-2" disabled={restart.isPending} onClick={() => restart.mutate()}>
          {restart.isPending ? <Spinner /> : <RotateCw />}Restart
        </Button>}
      </div>
      {d.hint && <p className="pl-8 text-xs text-pretty text-muted-foreground">{d.hint}</p>}
      {h.problems?.map((m) => <p key={m} className="pl-8 text-xs text-pretty text-muted-foreground">{m}</p>)}
      <ErrorAlert error={restart.error} />
    </div>
  )
}

function MemoryRow({ profile: p }: { profile: Profile }) {
  const qc = useQueryClient()
  // A first install can outlast the request; the profile list is polled until it reports claude-mem on.
  const [waiting, setWaiting] = useState(false)
  const save = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.api.claude.profiles[':name'].memory.$put({ param: { name: p.name }, json: { enabled } })),
    onSuccess: (r, enabled) => {
      if (r.pending) {
        setWaiting(true)
        toast.info('Installing claude-mem. This takes a few minutes the first time; you will get a notification if it fails.')
      } else {
        toast.success(enabled ? `claude-mem is on for ${p.name}. New sessions use it.` : `claude-mem is off for ${p.name}.`)
      }
      void qc.invalidateQueries({ queryKey: profilesQuery.queryKey })
      void qc.invalidateQueries({ queryKey: memoryQuery.queryKey })
    },
  })
  useEffect(() => {
    if (!waiting) return
    if (p.memory) return setWaiting(false)
    const poll = setInterval(() => void qc.invalidateQueries({ queryKey: profilesQuery.queryKey }), 5_000)
    const giveUp = setTimeout(() => setWaiting(false), 5 * 60_000)
    return () => { clearInterval(poll); clearTimeout(giveUp) }
  }, [waiting, p.memory, qc])
  const busy = save.isPending || waiting
  const id = `memory-${p.name}`
  return (
    <li className="flex flex-col gap-3 rounded-xl px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div id={id} className="font-medium">{profileName(p)}</div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">{busy && <Spinner className="size-3.5" />}{busy ? 'Working on it…' : p.memory ? 'Claude Code memory and claude-mem' : 'Claude Code memory'}</div>
        <ErrorAlert error={save.error} />
      </div>
      <ToggleGroup type="single" size="sm" spacing={1} aria-labelledby={id} disabled={busy} value={p.memory ? 'mem' : 'builtin'}
        onValueChange={(v) => v && v !== (p.memory ? 'mem' : 'builtin') && save.mutate(v === 'mem')} className={`shrink-0 ${track}`}>
        <ToggleGroupItem value="builtin" className={`px-3 ${pill}`}>Built-in</ToggleGroupItem>
        <ToggleGroupItem value="mem" className={`px-3 ${pill}`}>claude-mem</ToggleGroupItem>
      </ToggleGroup>
    </li>
  )
}

function DefaultsCard({ profiles, initial }: { profiles: Profile[]; initial: Defaults }) {
  const qc = useQueryClient()
  const [d, setD] = useState(initial)
  useEffect(() => setD(initial), [initial])
  const save = useMutation({
    mutationFn: (next: Defaults) => unwrap(api.api.claude.defaults.$put({ json: { ...next, effort: null, permission_mode: next.permission_mode as PermissionMode } })),
    onSuccess: () => {
      toast.success('Defaults saved')
      void qc.invalidateQueries({ queryKey: profilesQuery.queryKey })
    },
  })
  const set = (patch: Partial<Defaults>) => {
    const next = { ...d, ...patch }
    setD(next)
    save.mutate(next)
  }
  const Row = ({ id, label, value, options, onPick, description }: { id: string; label: string; value: string; options: { value: string; label: string }[]; onPick: (v: string) => void; description?: string }) => (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup type="single" spacing={1} aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onPick(v)} className={`w-full flex-wrap ${track}`}>
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className={`min-w-fit flex-1 ${pill}`}>{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
  return (
    <Group title="Defaults for new sessions" description="You can change any of these per session.">
      <div className="rounded-2xl bg-surface p-4 md:p-5">
        <FieldGroup>
          {profiles.length > 1 && <Row id="d-profile" label="Profile" value={d.profile} onPick={(v) => set({ profile: v })} options={profiles.map((p) => ({ value: p.name, label: profileName(p) }))} />}
          <Row id="d-model" label="Model" value={d.model ?? ''} onPick={(v) => set({ model: v || null })} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
          <Row id="d-perm" label="Permissions" value={d.permission_mode} onPick={(v) => set({ permission_mode: v })}
            options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label }))} description={PERMISSION_MODES.find((p) => p.value === d.permission_mode)?.hint} />
          <Row id="d-open" label="Open sessions in" value={d.open_in} onPick={(v) => set({ open_in: v as 'chat' | 'cli' })} options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]} />
          <ErrorAlert error={save.error} />
        </FieldGroup>
      </div>
    </Group>
  )
}
