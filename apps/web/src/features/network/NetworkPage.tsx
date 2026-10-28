import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryOptions } from '@tanstack/react-query'
import { Laptop, RefreshCw, Smartphone, Server as ServerIcon } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
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
      <PageBody>
        {!s ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : s.hasKey ? (
          <Connected s={s} />
        ) : (
          <SettingsSection title="Connect your tailnet" description="DevDash runs a personal Tailscale node for you, in userspace inside your own server account — isolated to you. Paste a reusable, non-expiry auth key and DevDash brings your node online so Claude and your sessions can reach your devices.">
            <ConnectForm reconnect={false} />
          </SettingsSection>
        )}
      </PageBody>
    </>
  )
}

function Connected({ s }: { s: TailnetStatus }) {
  return (
    <>
      <SettingsSection title="Your node" description={`devdash node on your tailnet. State: ${s.backendState}.`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex items-center gap-2"><Dot on={s.running && s.backendState === 'Running'} />{s.running ? s.backendState : 'Stopped'}</dd>
          <dt className="text-muted-foreground">Hostname</dt><dd className="font-mono break-all">{s.self.hostName ?? '—'}</dd>
          <dt className="text-muted-foreground">Tailnet IP</dt><dd className="font-mono">{s.self.tailscaleIPs[0] ?? '—'}</dd>
        </dl>
        <DisconnectButton />
      </SettingsSection>
      <SettingsSection title="Devices" description="Everything on your tailnet, with live online status. A green dot means it's reachable right now.">
        {s.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{s.running ? 'No other devices on your tailnet yet. Add some in the Tailscale app.' : 'Your node is offline. Reconnect to see your devices.'}</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {s.devices.map((d) => (
              <li key={d.dnsName || d.name} className="flex items-center gap-3 px-3 py-2.5">
                <Dot on={d.online} />
                <DeviceIcon os={d.os} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{d.os || 'device'}{d.ip ? ` · ${d.ip}` : ''}</div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{d.online ? 'Online' : lastSeen(d.lastSeen)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {!s.running && (
        <SettingsSection title="Reconnect" description="Your node is not online. Paste a fresh auth key to bring it back up.">
          <ConnectForm reconnect />
        </SettingsSection>
      )}
    </>
  )
}

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
          <Input id="ts-key" type="password" autoComplete="off" placeholder="tskey-auth-…" className="h-10 font-mono" value={authKey} onChange={(e) => setAuthKey(e.target.value)} />
        </Field>
        <ErrorAlert error={connect.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!authKey.trim() || connect.isPending}>{connect.isPending ? 'Connecting…' : reconnect ? 'Reconnect' : 'Connect'}</Button>
          <button type="button" className="text-sm text-muted-foreground underline underline-offset-4" onClick={() => openExternal(KEYS_URL)}>
            Generate a key (Tailscale admin → Settings → Keys)
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Make it reusable and non-expiry so you paste it once. Your key is sealed on the server and never shown again.</p>
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
    <div>
      <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
        {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">Logs out of your tailnet, stops your node and forgets your key.</p>
    </div>
  )
}

function Dot({ on }: { on: boolean }) {
  return <span className={`inline-block size-2.5 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-label={on ? 'online' : 'offline'} />
}

function DeviceIcon({ os }: { os: string }) {
  const o = os.toLowerCase()
  const Icon = o.includes('ios') || o.includes('android') ? Smartphone : o.includes('linux') && !o.includes('mac') ? ServerIcon : Laptop
  return <Icon className="size-4 shrink-0 text-muted-foreground" />
}

function lastSeen(iso: string | null) {
  if (!iso) return 'Offline'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t) || t <= 0) return 'Offline'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
