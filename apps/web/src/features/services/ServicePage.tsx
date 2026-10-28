import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ExternalLink, Eye, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageHeader, pageCol } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { openExternal } from '@/lib/shell'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
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
    return <><PageHeader title={name} back="/services" /><div className="p-4"><ErrorAlert error={new Error(`There is no service called ${name}.`)} /></div></>
  }
  if (!s) return <><PageHeader title={name} back="/services" /><div className="p-4"><Skeleton className="h-40" /></div></>

  const st = stateOf(s)
  const hasOutput = s.state !== 'stopped' && s.state !== 'unknown'
  return (
    <div className="flex h-full flex-col">
      <PageHeader back="/services" title={<span className="font-mono">{s.name}</span>}
        description={<span className="flex items-center gap-1.5"><StatusLight state={st.light} />{st.label}</span>}
        actions={<>
          <PinButton kind="service" id={s.name} />
          {s.previewUrl && <Button size="sm" variant="outline" asChild><Link to="/services/$name/view" params={{ name: s.name }}><Eye /><span className="hidden sm:inline">View</span></Link></Button>}
          {s.previewUrl && <Button size="sm" variant="outline" onClick={() => openExternal(s.previewUrl!)}><ExternalLink /><span className="hidden sm:inline">Open</span></Button>}
          {s.canControl && <>
          {s.desired === 'stopped'
            ? <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('start')}><Play />Start</Button>
            : <>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('restart')}><RotateCw /><span className="hidden sm:inline">Restart</span></Button>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('stop')}><Square /><span className="hidden sm:inline">Stop</span></Button>
              </>}
          <Button size="icon-sm" variant="ghost" aria-label="Edit service" onClick={() => setEditing(true)}><Pencil /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Remove service" onClick={() => setRemoving(true)}><Trash2 /></Button>
          </>}
        </>} />

      <dl style={pageCol()} className="page-col grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-b py-3 text-sm">
        <dt className="text-muted-foreground">Port</dt>
        <dd className="font-mono">{s.port} <span className="font-sans text-muted-foreground">{s.listening ? 'listening on 127.0.0.1' : 'not listening'}</span></dd>
        {s.previewUrl && <><dt className="text-muted-foreground">Address</dt><dd className="flex items-center gap-2"><button className="truncate font-mono text-left underline-offset-4 hover:underline" onClick={() => openExternal(s.previewUrl!)}>{s.previewUrl.replace(/^https:\/\//, '').replace(/\/$/, '')}</button><span className="shrink-0 text-xs text-muted-foreground">{s.public ? 'anyone with the link' : 'members only'}</span></dd></>}
        <dt className="text-muted-foreground">Command</dt><dd className="font-mono break-all">{s.command}</dd>
        <dt className="text-muted-foreground">Folder</dt><dd className="font-mono break-all">{s.cwd}</dd>
        <dt className="text-muted-foreground">Owner</dt><dd>{s.owner.name}</dd>
        {s.session && <><dt className="text-muted-foreground">Started by</dt><dd><Link to="/claude/$id" params={{ id: s.session.id }} className="underline underline-offset-4">Claude in {s.session.title}</Link></dd></>}
        <dt className="text-muted-foreground">Options</dt>
        <dd>{[s.autostart ? 'starts with the server' : 'manual start', s.restart ? 'restarts on crash' : 'no restart on crash', envCount(s.env) ? `${envCount(s.env)} environment variable${envCount(s.env) === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')}</dd>
        {s.error && <><dt className="text-muted-foreground">Problem</dt><dd className="text-destructive">{s.error}</dd></>}
        {s.state === 'crashed' && <><dt className="text-muted-foreground">Exit code</dt><dd className="font-mono">{s.exitCode ?? 'unknown'}</dd></>}
      </dl>

      <div style={pageCol()} className="page-col canvas flex min-h-0 flex-1 flex-col"><div className="relative my-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-term-bg p-2 md:my-4">
        {hasOutput
          ? <TerminalView key={`${s.name}:${s.state === 'crashed'}`} path={`/api/services/${s.name}/logs`} onStatus={setLogStatus} />
          : <p className="flex h-full items-center justify-center px-6 text-center text-sm text-term-fg/70">Stopped. Its output shows here while it runs.</p>}
      </div></div>

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

const envCount = (env: string | null) => (env ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
