import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ExternalLink, Eye, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, pageCol } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { openExternal } from '@/lib/shell'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PinButton } from '../pins/pins'
import { ErrorAlert } from '../auth/LoginPage'
import { TerminalView, type Status } from '../terminal/TerminalView'
import { servicesQuery, stateOf, useLiveServices, type Service } from './data'
import { ServiceOptions } from './ServicesPage'

/** Keyed by the URL, so moving to another one starts from a clean slate. */
export function ServicePage() {
  const p = useParams({ from: '/app/services/$name' })
  return <ServicePageView key={p.name} />
}

function ServicePageView() {
  useLiveServices()
  const { name } = useParams({ from: '/app/services/$name' })
  const qc = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery(servicesQuery)
  const [removing, setRemoving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [, setLogStatus] = useState<Status>('connecting')
  const s = list.data?.services.find((x) => x.name === name)

  const act = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') => unwrap(api.api.services[':name'][what].$post({ param: { name } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services'] }),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.services[':name'].$delete({ param: { name } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services'] })
      void navigate({ to: '/services' })
    },
  })

  if (list.isSuccess && !s) {
    return (
      <><PageHeader title={name} back="/services" />
        <PageBody className="items-start gap-4 py-8">
          <p className="text-sm text-pretty text-muted-foreground"><span className="font-medium text-foreground">There's no service called {name}.</span> Someone may have removed it, or the link has a typo.</p>
          <Button variant="outline" size="sm" asChild><Link to="/services">All services</Link></Button>
        </PageBody>
      </>
    )
  }
  if (!s) return <><PageHeader title={name} back="/services" /><PageBody className="py-8"><Skeleton className="h-24 w-72 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></PageBody></>

  const st = stateOf(s)
  const hasOutput = s.state !== 'stopped' && s.state !== 'unknown'
  return (
    // Below xl the page scrolls (state, then the log at a fixed height, then the details); from xl it fits the screen.
    <div className="flex min-h-full flex-col xl:h-full">
      <PageHeader back="/services" title={s.name}
        actions={<>
          <PinButton kind="service" id={s.name} />
          {s.previewUrl && <Button size="sm" variant="outline" asChild><Link to="/services/$name/view" params={{ name: s.name }}><Eye /><span className="hidden sm:inline">View</span></Link></Button>}
          {s.previewUrl && <Button size="sm" variant="outline" onClick={() => openExternal(s.previewUrl!)}><ExternalLink /><span className="hidden sm:inline">Open</span></Button>}
          {s.canControl && <>
            <Button size="icon-sm" variant="ghost" aria-label="Edit service" onClick={() => setEditing(true)}><Pencil /></Button>
            <Button size="icon-sm" variant="ghost" aria-label="Remove service" onClick={() => setRemoving(true)}><Trash2 /></Button>
          </>}
        </>} />

      <div style={pageCol()} className="page-col flex min-h-0 flex-1 flex-col gap-6 py-6 md:py-8 xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-x-8">
        {/* The page's one loud thing: what state it's in, and the buttons that change it. */}
        <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between xl:col-span-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className={cn('flex items-start gap-3 text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.25rem]', s.state === 'crashed' && 'text-destructive')}>
              <StatusLight state={st.light} className="mt-[0.3em] size-3.5 rounded-[4px] md:size-4" />{st.label}
            </h2>
            <p className="max-w-[60ch] text-[15px] text-pretty text-muted-foreground">{stateDetail(s)}</p>
            {s.error && <p className="max-w-[60ch] text-sm text-pretty text-destructive">{s.error}</p>}
          </div>
          {s.canControl && (
            <div className="flex shrink-0 gap-2">
              {s.desired === 'stopped'
                ? <Button disabled={act.isPending} onClick={() => act.mutate('start')}><Play />Start</Button>
                : <>
                    <Button variant="outline" disabled={act.isPending} onClick={() => act.mutate('restart')}><RotateCw />Restart</Button>
                    <Button variant="outline" disabled={act.isPending} onClick={() => act.mutate('stop')}><Square />Stop</Button>
                  </>}
            </div>
          )}
        </section>

        <div aria-label="Output" className="relative -mx-2 h-[62svh] min-h-80 overflow-hidden rounded-2xl bg-term-bg p-2.5 md:mx-0 xl:h-auto xl:min-h-0">
          {hasOutput
            ? <TerminalView key={`${s.name}:${s.state === 'crashed'}`} path={`/api/services/${s.name}/logs`} onStatus={setLogStatus} />
            : <p className="flex h-full items-center justify-center px-6 text-center text-sm text-term-fg/70">Stopped. Its output shows here while it runs.</p>}
        </div>

        <dl className="grid content-start gap-0.5 rounded-2xl bg-surface p-1.5 text-sm sm:grid-cols-2 xl:max-h-full xl:grid-cols-1 xl:self-start xl:overflow-y-auto">
          <Fact label="Port"><span className="tabular-nums">{s.port}</span><span className="text-muted-foreground">, {s.listening ? 'listening on 127.0.0.1' : 'not listening'}</span></Fact>
          {s.previewUrl && (
            <Fact label="Address">
              <button className="max-w-full text-left break-all underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground" onClick={() => openExternal(s.previewUrl!)}>
                {s.previewUrl.replace(/^https:\/\//, '').replace(/\/$/, '')}
              </button>
              <span className="block text-xs text-muted-foreground">{s.public ? 'Anyone with the link can open it' : 'Members only'}</span>
            </Fact>
          )}
          <Fact label="Command" wide><code className="font-mono text-[13px] break-all">{s.command}</code></Fact>
          <Fact label="Folder" wide><code className="font-mono text-[13px] break-all">{s.cwd}</code></Fact>
          <Fact label="Owner">{s.owner.name}</Fact>
          {s.session && <Fact label="Started by"><Link to="/claude/$id" params={{ id: s.session.id }} className="underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground">Claude in {s.session.title}</Link></Fact>}
          <Fact label="Options" wide>
            {[s.autostart ? 'Starts with the server' : 'Manual start', s.restart ? 'restarts on crash' : 'no restart on crash', envCount(s.env) ? `${envCount(s.env)} environment variable${envCount(s.env) === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')}
          </Fact>
          {s.state === 'crashed' && <Fact label="Exit code"><span className="tabular-nums">{s.exitCode ?? 'unknown'}</span></Fact>}
        </dl>
      </div>

      {editing && <EditService s={s} onClose={() => setEditing(false)} />}

      <ResponsiveDialog open={removing} onOpenChange={setRemoving} title={`Remove ${s.name}?`} description="It stops, and its port goes back to the pool. The folder and its files stay.">
        <div className="flex flex-col gap-3">
          <ErrorAlert error={remove.error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRemoving(false)}>Keep it</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove service</Button>
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  )
}

function EditService({ s, onClose }: { s: Service; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ command: s.command, cwd: s.cwd, autostart: s.autostart, restart: s.restart, env: s.env ?? '', public: s.public })
  const set = (v: Partial<typeof f>) => setF((o) => ({ ...o, ...v }))
  const save = useMutation({
    mutationFn: () => unwrap(api.api.services[':name'].$patch({ param: { name: s.name }, json: f })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services'] })
      toast.success(s.desired === 'running' ? `Saved. ${s.name} restarted with the changes.` : 'Saved.')
      onClose()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title={`Edit ${s.name}`} description={s.desired === 'running' ? 'Saving restarts it.' : undefined}>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="svc-e-cmd">Command</FieldLabel>
            <Input id="svc-e-cmd" required className="h-10 font-mono" value={f.command} onChange={(e) => set({ command: e.target.value })} />
            <FieldDescription>Port {s.port} stays the same: <code className="font-mono">$PORT</code>.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="svc-e-cwd">Folder</FieldLabel>
            <Input id="svc-e-cwd" required className="h-10 font-mono" value={f.cwd} onChange={(e) => set({ cwd: e.target.value })} />
          </Field>
          <ServiceOptions autostart={f.autostart} restart={f.restart} env={f.env} onChange={set} />
          {s.previewUrl && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="svc-public">Anyone with the link can open it</FieldLabel>
                <FieldDescription>For testers without a DevDash account. Off: only signed-in members.</FieldDescription>
              </FieldContent>
              <Switch id="svc-public" checked={f.public} onCheckedChange={(v) => set({ public: v })} />
            </Field>
          )}
          <ErrorAlert error={save.error} />
          <Button type="submit" className="h-10" disabled={!f.command || !f.cwd || save.isPending}>Save changes</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

/** What the state means for this service, and what to do about it. */
function stateDetail(s: Service): ReactNode {
  switch (s.state) {
    case 'running':
      return s.listening ? `Answering on port ${s.port}.` : <>Port {s.port} isn't answering yet. It needs to listen on <code className="font-mono text-[13px]">$PORT</code>.</>
    case 'starting':
      return `Coming up on port ${s.port}.`
    case 'crashed':
      return s.restart ? 'It crashed 5 times in 10 minutes, so it isn\'t restarted any more. Its output says why; start it again once it\'s fixed.'
        : 'It exited and isn\'t set to restart. Its output says why.'
    case 'stopped':
      return `Port ${s.port} stays reserved for it.`
    default:
      return 'Checking on it…'
  }
}

/** One detail of the service: a quiet label over its value. `wide` spans both columns where there are two. */
const Fact = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl px-3 py-2.5', wide && 'sm:col-span-2 xl:col-span-1')}>
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
)

const envCount = (env: string | null) => (env ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
