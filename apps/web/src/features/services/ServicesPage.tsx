import { useMemo, useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Plus, Server, Sparkles } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { servicesQuery, stateOf, useLiveServices, type Service } from './data'

const ANY = '*'

export function ServicesPage() {
  useLiveServices()
  const list = useQuery(servicesQuery)
  const me = useQuery(meQuery).data!
  const [adding, setAdding] = useState(false)
  const [person, setPerson] = useState(ANY)
  const [session, setSession] = useState(ANY)
  const all = list.data?.services ?? []

  const people = useMemo(() => [...new Map(all.map((s) => [s.owner.username, s.owner])).values()].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id)), [all, me.id])
  const sessions = useMemo(() => [...new Map(all.filter((s) => s.session).map((s) => [s.session!.id, s.session!])).values()], [all])
  const shown = all.filter((s) => (person === ANY || s.owner.username === person) && (session === ANY || s.session?.id === session))

  return (
    <>
      <PageHeader title="Services" description="Websites, APIs and containers that stay up"
        actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />New</Button>} />
      <PageBody>
        <ErrorAlert error={list.error} />
        {list.isPending && <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {list.isSuccess && !all.length && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Server /></EmptyMedia>
              <EmptyTitle>No services yet</EmptyTitle>
              <EmptyDescription>
                Run a website, an API or a container here and it keeps running when you close everything. Each one gets its own port, so nothing collides.
                Claude adds them too, with <code className="font-mono text-foreground">devdash service add</code>.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button onClick={() => setAdding(true)}><Plus />New service</Button></EmptyContent>
          </Empty>
        )}

        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={person} onValueChange={(v) => v && setPerson(v)} aria-label="Whose services">
              <ToggleGroupItem value={ANY}>Everyone</ToggleGroupItem>
              {people.map((p) => <ToggleGroupItem key={p.username} value={p.username}>{p.id === me.id ? 'Mine' : p.name.split(' ')[0]}</ToggleGroupItem>)}
            </ToggleGroup>
            {sessions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="max-w-64">
                    <Sparkles /><span className="truncate">{session === ANY ? 'Any session' : sessions.find((x) => x.id === session)?.title}</span><ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup value={session} onValueChange={setSession}>
                    <DropdownMenuRadioItem value={ANY}>Any session</DropdownMenuRadioItem>
                    {sessions.map((x) => <DropdownMenuRadioItem key={x.id} value={x.id}><span className="truncate">{x.title}</span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {all.length > 0 && !shown.length && <p className="text-sm text-muted-foreground">No service matches these filters.</p>}
        {shown.length > 0 && (
          <ItemGroup className="rounded-xl border">
            {shown.map((s) => <ServiceRow key={s.name} s={s} showOwner={s.owner.id !== me.id} />)}
          </ItemGroup>
        )}

        <PortsInUse />
      </PageBody>
      <NewService open={adding} onOpenChange={setAdding} />
    </>
  )
}

function ServiceRow({ s, showOwner }: { s: Service; showOwner: boolean }) {
  const st = stateOf(s)
  return (
    <Item asChild className="rounded-none border-0 border-b last:border-b-0">
      <Link to="/services/$name" params={{ name: s.name }}>
        <ItemMedia><StatusLight state={st.light} /></ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="font-mono">{s.name}</ItemTitle>
          <ItemDescription className="truncate">
            {st.label}, port {s.port}{s.session ? <>, from “{s.session.title}”</> : null}
          </ItemDescription>
        </ItemContent>
        {showOwner && (
          <ItemActions>
            <UserAvatar user={s.owner} className="size-7" textClassName="text-[11px]" title={s.owner.name} />
          </ItemActions>
        )}
      </Link>
    </Item>
  )
}

/** Everything listening on the server, so nobody (and no Claude) starts a second copy or fights over a port. */
function PortsInUse() {
  const [open, setOpen] = useState(false)
  const ports = useQuery({ queryKey: ['services', 'ports'], queryFn: () => unwrap(api.api.services.ports.$get()), enabled: open })
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />Ports in use on the server
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <ErrorAlert error={ports.error} />
        {ports.data && (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">Port</th><th className="px-3 py-2 font-medium">User</th><th className="px-3 py-2 font-medium">What</th></tr>
              </thead>
              <tbody>
                {ports.data.ports.map((p) => (
                  <tr key={p.port} className="border-t">
                    <td className="px-3 py-1.5 font-mono tabular-nums">{p.port}</td>
                    <td className="px-3 py-1.5 font-mono">{p.user}</td>
                    <td className="px-3 py-1.5">{p.service ? <Link to="/services/$name" params={{ name: p.service }} className="font-mono underline-offset-4 hover:underline">{p.service}</Link> : <span className="text-muted-foreground">Not a DevDash service</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Start on boot, restart on crash, environment: shared by the new and edit forms. */
export function ServiceOptions({ autostart, restart, env, onChange }: {
  autostart: boolean; restart: boolean; env: string; onChange: (v: { autostart?: boolean; restart?: boolean; env?: string }) => void
}) {
  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="svc-autostart">Start when the server starts</FieldLabel>
          <FieldDescription>After a reboot or an update it comes back by itself.</FieldDescription>
        </FieldContent>
        <Switch id="svc-autostart" checked={autostart} onCheckedChange={(v) => onChange({ autostart: v })} />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="svc-restart">Restart if it crashes</FieldLabel>
          <FieldDescription>Gives up after 5 crashes in 10 minutes and tells you.</FieldDescription>
        </FieldContent>
        <Switch id="svc-restart" checked={restart} onCheckedChange={(v) => onChange({ restart: v })} />
      </Field>
      <Field>
        <FieldLabel htmlFor="svc-env">Environment variables</FieldLabel>
        <Textarea id="svc-env" rows={3} className="font-mono text-sm" placeholder={'NODE_ENV=production\nAPI_URL=http://127.0.0.1:20001'} value={env} onChange={(e) => onChange({ env: e.target.value })} />
        <FieldDescription>One KEY=value per line. Only you and admins can see them. PORT is set for you.</FieldDescription>
      </Field>
    </>
  )
}

function NewService({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const blank = { name: '', cwd: '~', command: '', autostart: true, restart: true, env: '' }
  const [f, setF] = useState(blank)
  const set = (v: Partial<typeof blank>) => setF((o) => ({ ...o, ...v }))
  const create = useMutation({
    mutationFn: () => unwrap(api.api.services.$post({ json: f })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['services'] })
      close(false)
      void navigate({ to: '/services/$name', params: { name: r.service.name } })
    },
  })
  const close = (v: boolean) => {
    onOpenChange(v)
    if (!v) { setF(blank); create.reset() }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={close} title="New service" description="It starts right away on its own port.">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="svc-name">Name</FieldLabel>
            <Input id="svc-name" required autoFocus className="h-10 font-mono" placeholder="shop-api" value={f.name}
              onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="svc-cwd">Folder</FieldLabel>
            <Input id="svc-cwd" required className="h-10 font-mono" value={f.cwd} onChange={(e) => set({ cwd: e.target.value })} />
            <FieldDescription>On the server, in your account. ~ is your home folder.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="svc-cmd">Command</FieldLabel>
            <Input id="svc-cmd" required className="h-10 font-mono" placeholder="npm run dev -- --port $PORT --host 127.0.0.1" value={f.command} onChange={(e) => set({ command: e.target.value })} />
            <FieldDescription>It must listen on <code className="font-mono">$PORT</code>. DevDash picks a free one for it.</FieldDescription>
          </Field>
          <ServiceOptions autostart={f.autostart} restart={f.restart} env={f.env} onChange={set} />
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!f.name || !f.command || create.isPending}>Start service</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

