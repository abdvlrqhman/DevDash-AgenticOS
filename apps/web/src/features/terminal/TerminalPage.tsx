import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { Plus, ShieldAlert, SquareTerminal, X } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageHeader, pageCol } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { api, meQuery, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CodeInput, ErrorAlert } from '../auth/LoginPage'
import { KeyBar } from './KeyBar'
import { TerminalView, type Mods, type Status, type TerminalHandle } from './TerminalView'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const ADMIN = 'admin'
const STATUS_TEXT: Record<Status, string> = { connecting: 'Connecting', live: 'Connected', reconnecting: 'Reconnecting', ended: 'Shell exited' }

export function TerminalPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const { open: requested } = useSearch({ from: '/app/terminal' })
  const list = useQuery({ queryKey: ['terminals'], queryFn: () => unwrap(api.api.terminals.$get()) })
  const [opened, setOpened] = useState<string[]>(() => (requested && NAME_RE.test(requested) ? [requested] : []))
  // Nothing connects until a terminal is picked (a link may pick one, e.g. Claude sign-in).
  const [active, setActive] = useState<string | null>(() => (requested && NAME_RE.test(requested) ? requested : null))
  const [epoch, setEpoch] = useState(0)
  const [status, setStatus] = useState<Status>('connecting')
  const [mods, setMods] = useState<Mods>({ ctrl: false, alt: false })
  const [adding, setAdding] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const term = useRef<TerminalHandle>(null)

  const names = [...new Set(['main', ...(list.data?.terminals ?? []).map((t) => t.name).filter((n) => n !== ADMIN), ...opened])]
  const isAdmin = active === ADMIN
  const onStatus = useCallback((s: Status) => setStatus(s), [])
  // A Claude sign-in tab finished: refresh the sign-in status shown on Claude setup.
  useEffect(() => {
    if (status === 'ended' && active?.startsWith('login-')) void qc.invalidateQueries({ queryKey: ['claude', 'profiles'] })
    if (status === 'ended' && active === 'github-login') void qc.invalidateQueries({ queryKey: ['github'] })
  }, [status, active, qc])

  const kill = useMutation({
    mutationFn: (name: string) => unwrap(api.api.terminals[':name'].$delete({ param: { name } })),
    onSuccess: (_r, name) => {
      setOpened((o) => o.filter((n) => n !== name))
      if (active === name) setActive(null)
      setEpoch((e) => e + 1)
      setClosing(null)
      void qc.invalidateQueries({ queryKey: ['terminals'] })
    },
  })
  const open = (name: string) => {
    setActive(name)
    setStatus('connecting')
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Terminal" description={<span className="font-mono">{me.username}@server</span>}
        actions={active &&
          <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusLight state={status === 'live' ? 'live' : status === 'ended' ? 'idle' : 'waiting'} />
            <span className="hidden sm:inline">{STATUS_TEXT[status]}</span>
          </span>
        } />

      <div style={pageCol()} className="page-col canvas flex min-h-0 flex-1 flex-col">
      {isAdmin ? (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
          <ShieldAlert className="size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium text-destructive">Admin shell</div>
            <div className="text-muted-foreground">Root on the whole server. Closes after 15 minutes without typing.</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setActive(null)}>Leave</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 overflow-x-auto border-b" role="tablist" aria-label="Terminals">
          {names.map((n) => (
            <div key={n} className={cn('flex shrink-0 items-center border-b-2 font-mono text-[13px]', n === active ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground')}>
              <button role="tab" aria-selected={n === active} className="h-10 px-2.5 hover:text-foreground" onClick={() => open(n)}>{n}</button>
              {n === active && (
                <Button size="icon-xs" variant="ghost" aria-label={`Close ${n}`} onClick={() => setClosing(n)}><X /></Button>
              )}
            </div>
          ))}
          {adding
            ? <NewTabInput taken={names} onCancel={() => setAdding(false)} onCreate={(n) => { setOpened((o) => [...o, n]); setAdding(false); open(n) }} />
            : <Button size="icon-sm" variant="outline" aria-label="New terminal" title="New terminal" onClick={() => setAdding(true)}><Plus /></Button>}
          <span className="flex-1" />
          {me.role === 'admin' && (
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => setUnlocking(true)}>
              <ShieldAlert />Admin shell
            </Button>
          )}
        </div>
      )}

      {list.error && <div className="mt-2"><ErrorAlert error={list.error} /></div>}
      {!active ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><SquareTerminal /></EmptyMedia>
            <EmptyTitle>Open a terminal</EmptyTitle>
            <EmptyDescription>Shells run on the server as {me.username} and keep running when you leave, so you can pick up where you were from any device.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center gap-2">
            {names.map((n) => {
              const running = list.data?.terminals.some((t) => t.name === n)
              return (
                <Button key={n} variant={n === 'main' ? 'default' : 'outline'} onClick={() => open(n)}>
                  {running && <StatusLight state="live" />}Open <span className="font-mono">{n}</span>
                </Button>
              )
            })}
            <Button variant="outline" onClick={() => setAdding(true)}><Plus />New terminal</Button>
          </EmptyContent>
        </Empty>
      ) : <>
      <div className={cn('relative my-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-term-bg p-2 md:my-4', isAdmin && 'ring-2 ring-destructive')}>
        <TerminalView key={`${active}:${epoch}`} ref={term} path={`/api/terminals/${active}/ws`} onStatus={onStatus} onMods={setMods} />
        {status === 'ended' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-term-bg/95 px-6 text-center text-term-fg">
            <p>The shell in <span className="font-mono">{active}</span> exited.</p>
            <Button variant="secondary" onClick={() => (isAdmin ? setUnlocking(true) : setEpoch((e) => e + 1))}>Start a new shell</Button>
          </div>
        )}
      </div>

      <KeyBar term={term} mods={mods} />
      </>}

      <ResponsiveDialog open={closing !== null} onOpenChange={(v) => !v && setClosing(null)} title={`Close ${closing}?`} description="Anything still running in it stops.">
        <div className="flex flex-col gap-3">
          <ErrorAlert error={kill.error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setClosing(null)}>Keep it</Button>
            <Button variant="destructive" disabled={kill.isPending} onClick={() => kill.mutate(closing!)}>Close terminal</Button>
          </div>
        </div>
      </ResponsiveDialog>

      <AdminUnlock open={unlocking} onOpenChange={setUnlocking} onUnlocked={() => { setUnlocking(false); setEpoch((e) => e + 1); open(ADMIN) }} />
      </div>
    </div>
  )
}

function NewTabInput({ taken, onCreate, onCancel }: { taken: string[]; onCreate: (n: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(() => {
    let i = 2
    while (taken.includes(`shell-${i}`)) i++
    return `shell-${i}`
  })
  const valid = NAME_RE.test(value) && !taken.includes(value) && value !== ADMIN
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) onCreate(value)
  }
  return (
    <form onSubmit={submit} className="shrink-0 py-1">
      <input autoFocus aria-label="New terminal name" value={value} onBlur={onCancel} onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        className={cn('h-8 w-32 rounded-md border bg-background px-2 font-mono text-[13px] outline-none focus-visible:ring-[3px]', valid ? 'focus-visible:ring-ring/50' : 'border-destructive focus-visible:ring-destructive/30')} />
    </form>
  )
}

function AdminUnlock({ open, onOpenChange, onUnlocked }: { open: boolean; onOpenChange: (v: boolean) => void; onUnlocked: () => void }) {
  const [code, setCode] = useState('')
  const unlock = useMutation({
    mutationFn: () => unwrap(api.api.terminals.admin.unlock.$post({ json: { code } })),
    onSuccess: () => { setCode(''); onUnlocked() },
    onError: () => setCode(''),
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setCode(''); unlock.reset() } }}
      title="Confirm it's you" description="The admin shell has root on the whole server. Enter a fresh code from your authenticator. sudo then asks for your server password (set it under Account).">
      <form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) unlock.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-otp">Authenticator code</FieldLabel>
            <CodeInput id="admin-otp" value={code} onChange={setCode} autoFocus />
            <FieldDescription>Opening it is recorded in the audit log.</FieldDescription>
          </Field>
          <ErrorAlert error={unlock.error} />
          <Button type="submit" variant="destructive" className="h-10" disabled={code.length !== 6 || unlock.isPending}>Open admin shell</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
