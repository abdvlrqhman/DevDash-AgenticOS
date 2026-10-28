import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LogIn, Plus, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, type PermissionMode } from './data'
import { describeMemory, memoryQuery } from './memory'

type Profile = { name: string; loggedIn: boolean; authMethod: string | null; email: string | null; plan: string | null; memory: boolean }
type Defaults = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

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
      <PageBody>
        <SettingsSection title="Profiles" description={<>
              A profile is its own Claude configuration: settings, skills, agents, plugins, memory and sign-in. The same Claude account can sign in to any number of profiles.
        </>}>
            <ErrorAlert error={q.error} />
            {q.isPending ? <Skeleton className="h-16" /> : (
              <ItemGroup className="rounded-lg border">
                {profiles.map((p) => (
                  <Item key={p.name} className="rounded-none border-0 border-b last:border-b-0">
                    <ItemMedia><StatusLight state={p.loggedIn ? 'live' : 'idle'} /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{p.name === 'default' ? 'Default' : p.name}</ItemTitle>
                      <ItemDescription>
                        {p.loggedIn ? [p.email, p.plan, p.authMethod === 'apiKey' ? 'API key' : null].filter(Boolean).join(', ') || 'Signed in' : 'Not signed in'}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button size="sm" variant={p.loggedIn ? 'outline' : 'default'} onClick={() => login(p.name)}><LogIn />{p.loggedIn ? 'Sign in again' : 'Sign in'}</Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name) create.mutate() }} className="flex items-end gap-2">
              <Field className="flex-1">
                <FieldLabel htmlFor="new-profile">New profile</FieldLabel>
                <Input id="new-profile" placeholder="work" value={name} maxLength={21} className="h-9"
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              </Field>
              <Button type="submit" variant="outline" disabled={!name || create.isPending}><Plus />Add</Button>
            </form>
            <ErrorAlert error={create.error} />
            <p className="text-sm text-muted-foreground">
              Signing in opens a terminal running Claude's own sign-in. Open the link it prints, approve, then paste the code back. DevDash never sees your Claude credentials.
            </p>
        </SettingsSection>
        {!q.isPending && profiles.length > 0 && <MemorySection profiles={profiles} />}
        {q.data && <DefaultsCard profiles={profiles} initial={q.data.defaults} />}
      </PageBody>
    </>
  )
}

/** Per profile: Claude Code's own memory (the default) or claude-mem on top of it. */
function MemorySection({ profiles }: { profiles: Profile[] }) {
  return (
    <SettingsSection title="Memory" description={<>
          Claude Code remembers through CLAUDE.md files and its own auto memory. claude-mem adds to that: it records what Claude does and brings the relevant parts back in later sessions, searchable across projects. It summarizes in the background with your Claude plan, and new sessions pick the change up.
    </>}>
        <ItemGroup className="rounded-lg border">
          {profiles.map((p) => <MemoryRow key={p.name} profile={p} />)}
        </ItemGroup>
        {profiles.some((p) => p.memory) && <MemoryHealthRow />}
    </SettingsSection>
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
  if (q.isPending) return <Skeleton className="h-12" />
  if (q.error) return <ErrorAlert error={q.error} />
  const h = q.data.health
  const d = describeMemory(h)
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <StatusLight state={d.light} />
        <div className="min-w-0 flex-1 text-sm">
          <div>{d.text}</div>
          {h.version && <div className="text-xs text-muted-foreground">claude-mem {h.version}</div>}
        </div>
        {h.state !== 'off' && <Button size="sm" variant="outline" disabled={restart.isPending} onClick={() => restart.mutate()}>
          {restart.isPending ? <Spinner /> : <RotateCw />}Restart
        </Button>}
      </div>
      {d.hint && <p className="text-xs text-muted-foreground">{d.hint}</p>}
      {h.problems?.map((m) => <p key={m} className="text-xs text-muted-foreground">{m}</p>)}
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
    <Item className="rounded-none border-0 border-b last:border-b-0">
      <ItemContent>
        <ItemTitle id={id}>{p.name === 'default' ? 'Default' : p.name}</ItemTitle>
        <ItemDescription>{busy ? 'Working on it…' : p.memory ? 'Claude Code memory and claude-mem' : 'Claude Code memory'}</ItemDescription>
        <ErrorAlert error={save.error} />
      </ItemContent>
      <ItemActions>
        <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby={id} disabled={busy} value={p.memory ? 'mem' : 'builtin'}
          onValueChange={(v) => v && v !== (p.memory ? 'mem' : 'builtin') && save.mutate(v === 'mem')}>
          <ToggleGroupItem value="builtin">Built-in</ToggleGroupItem>
          <ToggleGroupItem value="mem">claude-mem</ToggleGroupItem>
        </ToggleGroup>
      </ItemActions>
    </Item>
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
      <ToggleGroup type="single" variant="outline" aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onPick(v)} className="w-full flex-wrap">
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className="flex-1">{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
  return (
    <SettingsSection title="Defaults for new sessions" description="You can change any of these per session.">
        <FieldGroup>
          {profiles.length > 1 && <Row id="d-profile" label="Profile" value={d.profile} onPick={(v) => set({ profile: v })} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />}
          <Row id="d-model" label="Model" value={d.model ?? ''} onPick={(v) => set({ model: v || null })} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
          <Row id="d-perm" label="Permissions" value={d.permission_mode} onPick={(v) => set({ permission_mode: v })}
            options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label }))} description={PERMISSION_MODES.find((p) => p.value === d.permission_mode)?.hint} />
          <Row id="d-open" label="Open sessions in" value={d.open_in} onPick={(v) => set({ open_in: v as 'chat' | 'cli' })} options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]} />
          <ErrorAlert error={save.error} />
        </FieldGroup>
    </SettingsSection>
  )
}
