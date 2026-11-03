import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryOptions } from '@tanstack/react-query'
import { Laptop, RefreshCw, Smartphone, Server as ServerIcon } from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap } from '@/lib/api'
import { useArrivals } from '@/lib/motion'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'

type Device = { name: string; dnsName: string; os: string; ip: string | null; online: boolean; lastSeen: string | null }
export type TailnetStatus = {
  backendState: string; self: { hostName: string | null; tailscaleIPs: string[] }
  socksPort: number | null; httpPort: number | null; running: boolean; devices: Device[]
  hasKey: boolean; connected: boolean
}

const KEYS_URL = 'https://login.tailscale.com/admin/settings/keys'

// Status is live-ish: poll every few seconds so online dots and newly-seen devices show without a manual refresh.
// Exported so the Claude session's "Reach my tailnet" setting can reuse it to know whether a node is connected.
export const tailnetStatusQuery = queryOptions({
  queryKey: ['tailnet', 'status'],
  queryFn: () => unwrap(api.api.tailnet.status.$get()) as Promise<TailnetStatus>,
  refetchInterval: 5000,
})
const statusQuery = tailnetStatusQuery

export function NetworkPage() {
  const q = useQuery(statusQuery)
  const s = q.data
  return (
    <>
      <PageHeader
        title="Network"
        description="Reach your own devices over your private Tailscale tailnet"
        actions={<Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void q.refetch()}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} /></Button>}
      />
      <PageBody className="md:py-10">
        {!s ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : s.hasKey ? (
          <Connected s={s} />
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            <Headline title="Connect your tailnet" lead="DevDash runs a personal Tailscale node for you, in userspace inside your own server account, isolated to you. Paste a reusable, non-expiry auth key and DevDash brings your node online so Claude and your sessions can reach your devices." />
            <div className="rounded-2xl bg-surface p-4 md:p-5"><ConnectForm reconnect={false} /></div>
          </div>
        )}
      </PageBody>
    </>
  )
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
/** "Three of five devices are online": in words up to ten, so it reads as a sentence, not a counter. */
const word = (n: number) => WORDS[n] ?? String(n)

function Headline({ title, context, lead }: { title: ReactNode; context?: ReactNode; lead?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      {context && <p className="flex items-center gap-2 text-sm text-muted-foreground">{context}</p>}
      <h2 className="text-[2rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance md:text-[2.75rem]">{title}</h2>
      {lead && <p className="text-[15px] text-pretty text-muted-foreground">{lead}</p>}
    </header>
  )
}

/**
 * The page answers one question, big: which of my devices can I reach right now. Each device's light is the loud part;
 * the node that reaches them sits to the side. A device seen for the first time lands in the list.
 */
function Connected({ s }: { s: TailnetStatus }) {
  const up = s.running && s.backendState === 'Running'
  const online = s.devices.filter((d) => d.online).length
  const list = useRef<HTMLUListElement>(null)
  useArrivals(list, s.devices.map((d) => d.dnsName || d.name))
  const title = !s.running ? 'Your node is offline.'
    : !s.devices.length ? 'No devices yet.'
    : online === s.devices.length ? `${s.devices.length === 1 ? 'Your device is' : `All ${word(s.devices.length).toLowerCase()} devices are`} online.`
    : `${word(online)} of ${word(s.devices.length).toLowerCase()} devices ${online === 1 ? 'is' : 'are'} online.`
  return (
    <div className="flex flex-col gap-12 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-x-14">
      <div className="flex min-w-0 flex-col gap-10">
        <Headline context={<><StatusLight state={up ? 'live' : 'idle'} />{up ? 'Your node is on your tailnet' : 'Your node is not running'}</>} title={title} />
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Devices{s.devices.length > 0 && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{s.devices.length}</span>}</h2>
          {s.devices.length === 0 ? (
            <p className="text-sm text-pretty text-muted-foreground">{s.running ? 'Nothing else is on your tailnet yet. Sign in to the Tailscale app on a laptop or phone and it shows up here.' : 'Your node is offline. Reconnect to see your devices.'}</p>
          ) : (
            <ul ref={list} className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {s.devices.map((d) => (
                <li key={d.dnsName || d.name} data-key={d.dnsName || d.name} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm">
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl bg-background', d.online ? 'text-foreground' : 'text-muted-foreground')}><DeviceIcon os={d.os} /></span>
                  <div className="min-w-0 flex-1">
                    <div className={cn('truncate font-medium', !d.online && 'text-muted-foreground')}>{d.name}</div>
                    <div className="truncate text-xs text-muted-foreground tabular-nums">{osName(d.os)}{d.ip ? `, ${d.ip}` : ''}</div>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <StatusLight state={d.online ? 'live' : 'idle'} label={d.online ? 'Online' : 'Offline'} />
                    {d.online ? <span className="font-medium">Online</span> : <span className="text-muted-foreground">{lastSeen(d.lastSeen)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.devices.length > 0 && <p className="text-xs text-pretty text-muted-foreground">Everything on your tailnet, live. A green light means Claude and your sessions can reach it right now.</p>}
        </section>
        {!s.running && (
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.01em]">Reconnect</h2>
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">Your node is not online. Paste a fresh auth key to bring it back up.</p>
            </div>
            <div className="rounded-2xl bg-surface p-4 md:p-5"><ConnectForm reconnect /></div>
          </section>
        )}
      </div>

      <aside className="flex flex-col gap-3 lg:sticky lg:top-20">
        <h2 className="text-base font-semibold tracking-[-0.01em]">Your node</h2>
        <dl className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5 text-sm">
          <Fact label="Status"><span className="flex items-center gap-2"><StatusLight state={up ? 'live' : 'idle'} />{s.running ? s.backendState : 'Stopped'}</span></Fact>
          <Fact label="Name">{s.self.hostName ?? 'Not set yet'}</Fact>
          <Fact label="Tailnet address"><span className="tabular-nums">{s.self.tailscaleIPs[0] ?? 'None yet'}</span></Fact>
        </dl>
        <DisconnectButton />
      </aside>
    </div>
  )
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5">
    <dt className="shrink-0 text-muted-foreground">{label}</dt>
    <dd className="min-w-0 truncate text-right">{children}</dd>
  </div>
)

function ConnectForm({ reconnect }: { reconnect: boolean }) {
  const qc = useQueryClient()
  const [authKey, setAuthKey] = useState('')
  const connect = useMutation({
    mutationFn: () => unwrap(api.api.tailnet.connect.$post({ json: { authKey } })) as Promise<TailnetStatus & { warning: string | null }>,
    onSuccess: (r) => {
      setAuthKey('')
      qc.setQueryData(statusQuery.queryKey, r)
      if (r.warning) toast.warning(r.warning)
      else toast.success('Your tailnet is connected.')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (authKey.trim()) connect.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ts-key">Tailscale auth key</FieldLabel>
          <Input id="ts-key" type="password" autoComplete="off" placeholder="tskey-auth-…" className="h-10 border-transparent bg-background font-mono dark:bg-background" value={authKey} onChange={(e) => setAuthKey(e.target.value)} />
        </Field>
        <ErrorAlert error={connect.error} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" disabled={!authKey.trim() || connect.isPending}>{connect.isPending ? 'Connecting…' : reconnect ? 'Reconnect' : 'Connect'}</Button>
          <button type="button" className="text-left text-sm text-muted-foreground underline underline-offset-4 transition-colors duration-150 hover:text-foreground" onClick={() => openExternal(KEYS_URL)}>
            Generate a key (Tailscale admin → Settings → Keys)
          </button>
        </div>
        <p className="text-xs text-pretty text-muted-foreground">Make it reusable and non-expiry so you paste it once. Your key is sealed on the server and never shown again.</p>
      </FieldGroup>
    </form>
  )
}

function DisconnectButton() {
  const qc = useQueryClient()
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.api.tailnet.disconnect.$post()) as Promise<TailnetStatus>,
    onSuccess: (r) => {
      qc.setQueryData(statusQuery.queryKey, r)
      toast.success('Disconnected from your tailnet.')
    },
  })
  return (
    <div className="flex flex-col items-start gap-2 pt-1">
      <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
        {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
      </Button>
      <p className="text-xs text-pretty text-muted-foreground">Logs out of your tailnet, stops your node and forgets your key.</p>
    </div>
  )
}

function DeviceIcon({ os }: { os: string }) {
  const o = os.toLowerCase()
  const Icon = o.includes('ios') || o.includes('android') ? Smartphone : o.includes('linux') && !o.includes('mac') ? ServerIcon : Laptop
  return <Icon className="size-4 shrink-0" />
}

/** Tailscale reports some systems in lower case ("linux"); show them the way people write them. */
const osName = (os: string) => ({ linux: 'Linux', windows: 'Windows', android: 'Android', freebsd: 'FreeBSD', openbsd: 'OpenBSD' } as Record<string, string>)[os] ?? (os || 'Device')

function lastSeen(iso: string | null) {
  if (!iso) return 'Offline'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t) || t <= 0) return 'Offline'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'Seen just now'
  if (mins < 60) return `Seen ${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `Seen ${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hrs / 24)
  return `Seen ${days} ${days === 1 ? 'day' : 'days'} ago`
}
