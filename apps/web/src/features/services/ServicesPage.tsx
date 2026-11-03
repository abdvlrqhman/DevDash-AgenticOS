import { useMemo, useRef, useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Plus, Sparkles } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { useArrivals } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { servicesQuery, stateOf, useLiveServices, type Service } from './data'

const ANY = '*'

/** "a and b are starting", or a count once names stop being readable. */
const are = (names: string[], what: string) => names.length > 2 ? `${names.length} are ${what}` : `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} ${what}`

/** The list at a glance: how many are up, and which ones aren't (by name while there are few). */
function summary(all: Service[]) {
  const named = (state: Service['state']) => all.filter((s) => s.state === state).map((s) => s.name)
  const up = named('running').length
  const [crashed, starting, stopped] = [named('crashed'), named('starting'), named('stopped')]
  const title = crashed.length === 1 ? `${crashed[0]} crashed.` : crashed.length ? `${crashed.length} services crashed.`
    : up === all.length ? 'All services are up.' : `${up} of ${all.length} ${all.length === 1 ? 'service is' : 'services are'} up.`
  const rest = [
    crashed.length ? `${up} of ${all.length} are up` : null,
    starting.length ? are(starting, 'starting') : null,
    stopped.length ? are(stopped, 'stopped') : null,
  ].filter(Boolean)
  return { title, detail: rest.length ? `${rest.join(', ')}.` : 'Each keeps running on its own port when everyone signs off.' }
}

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
  // A service someone (or Claude) adds while you look lands in the list; changing the filters isn't an arrival.
  const rows = useRef<HTMLUListElement>(null)
  useArrivals(rows, list.isSuccess ? all.map((s) => s.name) : undefined)
  const glance = summary(all)

  return (
    <>
      <PageHeader title="Services" description="Websites, APIs and containers that stay up"
        actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />New</Button>} />
      <PageBody className="gap-8 py-8 md:py-10">
        <ErrorAlert error={list.error} />
        {list.isPending && (
          <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-13 rounded-xl bg-surface-2" />)}</div>
        )}
        {list.isSuccess && !all.length && (
          <div className="flex flex-col items-start gap-5 rounded-2xl bg-surface p-6 md:p-8">
            <div className="flex max-w-prose flex-col gap-1.5">
              <h2 className="text-lg font-semibold tracking-[-0.015em]">Run something that stays up</h2>
              <p className="text-sm text-pretty text-muted-foreground">
                A website, an API or a container keeps running here when you close everything, each on its own port so nothing collides.
                Claude adds them too, with <code className="font-mono text-foreground">devdash service add</code>.
              </p>
            </div>
            <Button onClick={() => setAdding(true)}><Plus />New service</Button>
          </div>
        )}

        {all.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.25rem]">{glance.title}</h1>
            <p className="text-[15px] text-pretty text-muted-foreground">{glance.detail}</p>
          </div>
        )}

        {all.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
              <ToggleGroup type="single" size="sm" spacing={1} value={person} onValueChange={(v) => v && setPerson(v)} aria-label="Whose services"
                className="shrink-0 rounded-full bg-surface p-1 data-[size=sm]:rounded-full">
                <ToggleGroupItem value={ANY} className={segment}>Everyone</ToggleGroupItem>
                {people.map((p) => <ToggleGroupItem key={p.username} value={p.username} className={segment}>{p.id === me.id ? 'Mine' : p.name.split(' ')[0]}</ToggleGroupItem>)}
              </ToggleGroup>
              {sessions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 max-w-64 pointer-coarse:h-11">
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

            {!shown.length && <p className="px-1 py-2 text-sm text-muted-foreground">No service matches these filters.</p>}
            {shown.length > 0 && (
              <ul ref={rows} className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
                {shown.map((s) => <ServiceRow key={s.name} s={s} showOwner={s.owner.id !== me.id} />)}
              </ul>
            )}
          </div>
        )}

        <PortsInUse />
      </PageBody>
      <NewService open={adding} onOpenChange={setAdding} />
    </>
  )
}

/** One option of a segmented control: a pill on a surface track, the chosen one a tone darker. */
const segment = 'rounded-full px-3 hover:bg-surface-2'

function ServiceRow({ s, showOwner }: { s: Service; showOwner: boolean }) {
  const st = stateOf(s)
  return (
    <li data-key={s.name}>
      <Link to="/services/$name" params={{ name: s.name }}
        className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]">
        <span className="flex size-5 shrink-0 items-center justify-center"><StatusLight state={st.light} /></span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">{s.name}</span>
          <span className={cn('line-clamp-1 text-xs', s.state === 'crashed' ? 'text-destructive' : 'text-muted-foreground')}>
            {st.label}{s.session ? <>, from “{s.session.title}”</> : null}
          </span>
        </span>
        <code className="hidden max-w-[38%] truncate font-mono text-xs text-muted-foreground lg:block">{s.command}</code>
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{s.port}</span>
        <span className="flex size-6 shrink-0 items-center justify-center">
          {showOwner && <UserAvatar user={s.owner} className="size-6" textClassName="text-[10px]" title={s.owner.name} />}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  )
}

/** Everything listening on the server, so nobody (and no Claude) starts a second copy or fights over a port. */
function PortsInUse() {
  const [open, setOpen] = useState(false)
  const ports = useQuery({ queryKey: ['services', 'ports'], queryFn: () => unwrap(api.api.services.ports.$get()), enabled: open })
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <CollapsibleTrigger className="group -mx-2.5 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-surface hover:text-foreground data-[state=open]:text-foreground">
        <ChevronRight className="size-4 transition-transform duration-300 ease-spring group-data-[state=open]:rotate-90" />Ports in use on the server
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ErrorAlert error={ports.error} />
        {ports.data && (
          // A table keeps its hairlines: they line the columns up.
          <div className="overflow-x-auto rounded-2xl bg-surface px-1.5 py-1">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2 font-normal">Port</th><th className="px-3 py-2 font-normal">User</th><th className="px-3 py-2 font-normal">What</th></tr>
              </thead>
              <tbody>
                {ports.data.ports.map((p) => (
                  <tr key={p.port} className="border-t border-foreground/[0.06]">
                    <td className="px-3 py-2 tabular-nums">{p.port}</td>
                    <td className="px-3 py-2">{p.user}</td>
                    <td className="px-3 py-2">{p.service ? <Link to="/services/$name" params={{ name: p.service }} className="font-medium underline-offset-4 hover:underline">{p.service}</Link> : <span className="text-muted-foreground">Not a DevDash service</span>}</td>
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
            <Input id="svc-name" required autoFocus className="h-10" placeholder="shop-api" value={f.name}
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

