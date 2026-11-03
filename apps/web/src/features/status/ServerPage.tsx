import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpCircle, ChevronRight, DatabaseBackup } from 'lucide-react'
import { toast } from '@/lib/toast'
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
import { Updates } from './Updates'

const duration = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`
}

type Status = Awaited<ReturnType<typeof fetchStatus>>
const fetchStatus = () => unwrap(api.api.status.$get())

/** How the server is doing: resources, versions, backups and the parts of DevDash running on it. */
export function ServerPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['status'], queryFn: fetchStatus, refetchInterval: 15_000 })
  const backup = useMutation({
    mutationFn: () => unwrap(api.api.status.backup.$post()),
    onSuccess: () => { toast.success('Backup started. It takes a few seconds.'); setTimeout(() => void qc.invalidateQueries({ queryKey: ['status'] }), 8000) },
    onError: (e) => toast.error(e.message),
  })
  const d = q.data
  return (
    <>
      <PageHeader title="Server" description="Health, versions and backups" />
      <PageBody className="gap-12 py-8 md:py-12">
        <ErrorAlert error={q.error} />
        {!d ? (
          <div className="flex flex-col gap-6">
            <Skeleton className="h-12 w-80 max-w-full rounded-xl" />
            <div className="grid gap-2 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}</div>
          </div>
        ) : <>
          <Health d={d} />

          <div className="grid gap-12 lg:grid-cols-2 lg:gap-x-10">
            <Updates />

            <Block title="Backups" action={d.canAct && <Button size="sm" variant="outline" disabled={backup.isPending} onClick={() => backup.mutate()}><DatabaseBackup />Back up now</Button>}>
              {d.backup ? <>
                <Panel>
                  <Line label="Last backup" value={<Lit on={d.backup.ok ? 'live' : 'error'}><span>{relativeTime(d.backup.at)}, <span className="tabular-nums">{bytes(d.backup.bytes)}</span></span></Lit>} />
                  <Line label="Kept" value={d.backup.offsite ? 'Here for 14 days, and off-site' : 'Here for 14 days'} />
                </Panel>
                {!d.backup.ok && <p className="text-sm text-pretty text-destructive">{d.backup.note}</p>}
                {d.backup.ok && !d.backup.offsite && <p className="text-xs text-pretty text-muted-foreground">Add restic settings in <code className="font-mono">/etc/devdash/backup.env</code> to also keep copies off the server.</p>}
              </> : <Calm>No backup yet. One runs every night at 03:30 UTC.</Calm>}
            </Block>

            <Block title="Software" action={d.canAct && <UpdateButton sdk={d.software.claudeSdk} />}>
              <Panel>
                <Line label="DevDash" value={<><span className="tabular-nums">{d.software.devdash}</span>{d.software.release && <span className="text-muted-foreground">, <span className="font-mono text-[13px]">{d.software.release.id.slice(0, 7)}</span></span>}</>} />
                {d.software.release && <Line label="Deployed" value={relativeTime(d.software.release.since)} />}
                <Line label="Claude Code" value={<span className="tabular-nums">{d.software.claude ?? 'Not found'}</span>} />
                <Line label="Updates" value={<UpdateState sdk={d.software.claudeSdk} />} />
                <Line label="Node.js" value={<span className="tabular-nums">{d.software.node}</span>} />
              </Panel>
            </Block>

            <Block title="Running on it">
              <Panel>
                <Link to="/services" className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]">
                  <span className="text-muted-foreground">Services</span>
                  <span className="flex items-center gap-1.5"><span><span className="tabular-nums">{d.services.running} of {d.services.total}</span> running</span><ChevronRight className="size-4 text-muted-foreground" /></span>
                </Link>
                {d.services.crashed.length > 0 && <Line label="Crashed" value={<span className="text-destructive">{d.services.crashed.join(', ')}</span>} />}
                <Line label="Team browser" value={<Lit on={d.browser.running ? 'live' : 'idle'}>{d.browser.running ? 'Running' : 'Stopped'}</Lit>} />
                {d.agents.map((a) => (
                  <Line key={a.username} label={a.name} value={<Lit on={a.ok ? 'live' : 'error'}>{a.ok ? 'Server account ready' : 'Not responding'}</Lit>} />
                ))}
              </Panel>
            </Block>

            <Block title="claude-mem">
              <p className="-mt-1 text-sm text-pretty text-muted-foreground">Each member switches it on for their own Claude in Claude setup. Everyone has their own worker and memories.</p>
              <Panel>
                {d.agents.map((a) => {
                  const m = a.memory && describeMemory(a.memory)
                  return (
                    <div key={a.username} className="flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm">
                      <span className="flex h-5 w-2.5 shrink-0 items-center"><StatusLight state={m?.light ?? 'idle'} /></span>
                      <div className="min-w-0">
                        <div className="font-medium">{a.name}</div>
                        <div className="text-pretty text-muted-foreground">{m?.text ?? 'Unknown: their server account is not responding'}</div>
                      </div>
                    </div>
                  )
                })}
              </Panel>
            </Block>
          </div>
        </>}
      </PageBody>
    </>
  )
}

/**
 * The page's headline: how the server is doing in one sentence (the first thing that's wrong, or that nothing is),
 * over memory, disk and load as big numbers. The only loud part of the page.
 */
function Health({ d }: { d: Status }) {
  const mem = d.host.memory ? (d.host.memory.total - d.host.memory.available) / d.host.memory.total : null
  const disk = d.host.disk ? (d.host.disk.total - d.host.disk.free) / d.host.disk.total : null
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const trouble = [
    disk !== null && disk >= 0.9 && `The disk is ${pct(disk)} full.`,
    mem !== null && mem >= 0.9 && `Memory is ${pct(mem)} used.`,
    d.backup && !d.backup.ok && 'The last backup failed.',
    ...d.agents.filter((a) => !a.ok).map((a) => `${a.name}'s server account isn't responding.`),
    d.services.crashed.length === 1 ? `${d.services.crashed[0]} crashed.` : d.services.crashed.length > 1 && `${d.services.crashed.length} services crashed.`,
  ].filter((t): t is string => !!t)
  return (
    <section className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Up for {duration(d.host.uptime)}, on {d.host.cpus} cores.</p>
        <h1 className="flex items-start gap-3.5 text-[2rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance md:text-[2.75rem]">
          <StatusLight state={trouble.length ? 'error' : 'live'} className="mt-[0.33em] size-3.5 rounded-[4px] md:size-4" />
          {trouble[0] ?? 'The server is healthy.'}
        </h1>
        <p className="text-[15px] text-pretty text-muted-foreground">
          {trouble.length > 1 ? trouble.slice(1).join(' ') : trouble.length ? 'The rest is fine.' : 'Memory, disk, backups and every server account are fine.'}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Gauge label="Memory" share={mem} value={mem === null ? 'Unknown' : pct(mem)}
          detail={d.host.memory && `${bytes(d.host.memory.total - d.host.memory.available)} of ${bytes(d.host.memory.total)}`} />
        <Gauge label="Disk" share={disk} value={disk === null ? 'Unknown' : pct(disk)}
          detail={d.host.disk && `${bytes(d.host.disk.total - d.host.disk.free)} of ${bytes(d.host.disk.total)}`} />
        {/* Load is how many cores' worth of work is waiting; against the core count it reads like the others. */}
        <Gauge label="Load" share={Math.min(1, d.host.load[0]! / d.host.cpus)} value={d.host.load[0]!.toFixed(2)}
          detail={`${d.host.load[1]!.toFixed(2)} and ${d.host.load[2]!.toFixed(2)} over 5 and 15 min`} />
      </div>
    </section>
  )
}

/** One resource: a big number, a bar that turns amber past 75% and red past 90%. */
function Gauge({ label, value, share, detail }: { label: string; value: string; share: number | null; detail?: string | null }) {
  const level = share === null ? 'none' : share > 0.9 ? 'full' : share > 0.75 ? 'high' : 'ok'
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface p-4 md:p-5">
      <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:gap-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn('text-[1.75rem] leading-none font-semibold tracking-[-0.03em] tabular-nums md:text-[2rem]', level === 'full' && 'text-destructive')}>{value}</span>
      </div>
      <div role="meter" aria-label={label} aria-valuenow={Math.round((share ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', level === 'full' ? 'bg-destructive' : level === 'high' ? 'bg-attention' : 'bg-foreground/80')}
          style={{ width: `${(share ?? 0) * 100}%` }} />
      </div>
      {detail && <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>}
    </div>
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
  if (updateAvailable(sdk)) return <span className="text-attention-foreground">{sdk.latest} available</span>
  return <span className="text-muted-foreground">{!sdk.installed ? 'Not installed' : sdk.latest ? `Up to date, SDK ${sdk.installed}` : 'Could not check'}</span>
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

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3"><h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>{action}</div>
      {children}
    </section>
  )
}
/** Facts on one tone-stepped panel, no lines between them. */
const Panel = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">{children}</div>
const Line = ({ label, value }: { label: ReactNode; value: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 rounded-xl px-3 py-2.5 text-sm"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 truncate text-right">{value}</span></div>
)
const Lit = ({ on, children }: { on: 'live' | 'idle' | 'error'; children: ReactNode }) => <span className="inline-flex items-center gap-2"><StatusLight state={on} />{children}</span>
const Calm = ({ children }: { children: ReactNode }) => <p className="text-sm text-pretty text-muted-foreground">{children}</p>
