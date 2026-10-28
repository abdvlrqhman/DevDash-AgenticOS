import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpCircle, DatabaseBackup } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { describeMemory } from '../claude/memory'
import { bytes } from '../files/FilesPage'
import { Progress } from '../files/Progress'
import { Updates } from './Updates'

const duration = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`
}

/** How the server is doing: resources, versions, backups and the parts of DevDash running on it. */
export function ServerPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['status'], queryFn: () => unwrap(api.api.status.$get()), refetchInterval: 15_000 })
  const backup = useMutation({
    mutationFn: () => unwrap(api.api.status.backup.$post()),
    onSuccess: () => { toast.success('Backup started. It takes a few seconds.'); setTimeout(() => void qc.invalidateQueries({ queryKey: ['status'] }), 8000) },
    onError: (e) => toast.error(e.message),
  })
  const d = q.data
  return (
    <>
      <PageHeader title="Server" description="Health, versions and backups" />
      <PageBody>
        <ErrorAlert error={q.error} />
        {!d ? <Skeleton className="h-64" /> : (
          <div className="grid gap-4 md:grid-cols-2">
            <Updates />
            <Card title="Health">
              <Meter label="Memory" used={d.host.memory ? d.host.memory.total - d.host.memory.available : 0} total={d.host.memory?.total ?? 0} />
              <Meter label="Disk" used={d.host.disk ? d.host.disk.total - d.host.disk.free : 0} total={d.host.disk?.total ?? 0} />
              <Line label="Load" value={`${d.host.load.map((l) => l.toFixed(2)).join(', ')} on ${d.host.cpus} cores`} />
              <Line label="Up for" value={duration(d.host.uptime)} />
            </Card>

            <Card title="Backups" action={d.canAct && <Button size="sm" variant="outline" disabled={backup.isPending} onClick={() => backup.mutate()}><DatabaseBackup />Back up now</Button>}>
              {d.backup ? <>
                <Line label="Last backup" value={<span className="flex items-center gap-1.5"><StatusLight state={d.backup.ok ? 'live' : 'error'} />{relativeTime(d.backup.at)}, {bytes(d.backup.bytes)}</span>} />
                <Line label="Kept" value={d.backup.offsite ? 'On this server (14 days) and off-site' : 'On this server, 14 days'} />
                {!d.backup.ok && <p className="text-sm text-destructive">{d.backup.note}</p>}
                {d.backup.ok && !d.backup.offsite && <p className="text-xs text-muted-foreground">Add restic settings in /etc/devdash/backup.env to also keep copies off the server.</p>}
              </> : <p className="text-sm text-muted-foreground">No backup yet. One runs every night at 03:30 UTC.</p>}
            </Card>

            <Card title="Software" action={d.canAct && <UpdateButton sdk={d.software.claudeSdk} />}>
              <Line label="DevDash" value={<span className="font-mono">{d.software.devdash}{d.software.release ? ` (${d.software.release.id.slice(0, 7)})` : ''}</span>} />
              {d.software.release && <Line label="Deployed" value={relativeTime(d.software.release.since)} />}
              <Line label="Claude Code" value={<span className="font-mono">{d.software.claude ?? 'not found'}</span>} />
              <Line label="Updates" value={<UpdateState sdk={d.software.claudeSdk} />} />
              <Line label="Node.js" value={<span className="font-mono">{d.software.node}</span>} />
            </Card>

            <Card title="Running on it">
              <Line label="Services" value={<Link to="/services" className="hover:underline">{d.services.running} of {d.services.total} running</Link>} />
              {d.services.crashed.length > 0 && <Line label="Crashed" value={<span className="font-mono text-destructive">{d.services.crashed.join(', ')}</span>} />}
              <Line label="Team browser" value={<span className="flex items-center gap-1.5"><StatusLight state={d.browser.running ? 'live' : 'idle'} />{d.browser.running ? 'Running' : 'Stopped'}</span>} />
              {d.agents.map((a) => (
                <Line key={a.username} label={a.name} value={<span className="flex items-center gap-1.5"><StatusLight state={a.ok ? 'live' : 'error'} />{a.ok ? 'Server account ready' : 'Not responding'}</span>} />
              ))}
            </Card>

            <Card title="claude-mem">
              <p className="text-xs text-muted-foreground">Each member switches it on for their own Claude in Claude setup. Everyone has their own worker and memories.</p>
              {d.agents.map((a) => {
                const m = a.memory && describeMemory(a.memory)
                return (
                  <div key={a.username} className="flex items-start gap-2.5 text-sm">
                    <StatusLight state={m?.light ?? 'idle'} className="mt-1.5" />
                    <div className="min-w-0">
                      <div>{a.name}</div>
                      <div className="text-muted-foreground">{m?.text ?? 'Unknown: their server account is not responding'}</div>
                    </div>
                  </div>
                )
              })}
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}

const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// Claude Code comes from the Agent SDK package (deploy/claude-update.sh); admins update it for everyone from here.
type Sdk = { installed: string | null; latest: string | null; updating: boolean }
const updateAvailable = (sdk: Sdk) => !!sdk.latest && !!sdk.installed && newer(sdk.latest, sdk.installed)

function UpdateState({ sdk }: { sdk: Sdk }) {
  if (sdk.updating) return <span className="flex items-center gap-1.5"><Spinner />Updating…</span>
  if (updateAvailable(sdk)) return <span className="text-attention">{sdk.latest} available</span>
  return <span className="text-muted-foreground">{!sdk.installed ? 'Not installed' : sdk.latest ? `Up to date (SDK ${sdk.installed})` : 'Could not check'}</span>
}

function UpdateButton({ sdk }: { sdk: Sdk }) {
  const qc = useQueryClient()
  const update = useMutation({
    mutationFn: () => unwrap(api.api.status['claude-update'].$post()),
    onSuccess: () => {
      toast.success('Updating Claude Code. It takes a minute or two; running sessions keep their version until they restart.')
      void qc.invalidateQueries({ queryKey: ['status'] })
    },
    onError: (e) => toast.error(e.message),
  })
  if (!updateAvailable(sdk) || sdk.updating) return null
  return (
    <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate()}>
      {update.isPending ? <Spinner /> : <ArrowUpCircle />}Update Claude Code
    </Button>
  )
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex min-h-8 items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  )
}
const Line = ({ label, value }: { label: ReactNode; value: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 text-sm"><span className="text-muted-foreground">{label}</span><span className="min-w-0 truncate text-right">{value}</span></div>
)
function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total ? (used / total) * 100 : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{bytes(used)} of {bytes(total)}</span></div>
      <Progress value={pct} className={cn(pct > 90 && '[&>div]:bg-destructive', pct > 75 && pct <= 90 && '[&>div]:bg-attention')} />
    </div>
  )
}
