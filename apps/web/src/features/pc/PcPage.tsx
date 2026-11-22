import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AppWindow,
  Camera,
  Check,
  Download,
  Keyboard,
  Laptop,
  Monitor,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Star,
  Terminal,
  Trash2,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'

type DevicePlatform = 'windows' | 'android'
type TailnetDevice = { name: string; dnsName: string; os: string; ip: string | null; online: boolean; lastSeen: string | null }
type McpProvider = { id: string; label: string; installed: boolean; enabled: boolean }
type AuditItem = { id: number; deviceId: number | null; deviceName: string | null; source: string; action: string; summary: string; ok: boolean; durationMs: number; createdAt: number }

type PairedDevice = {
  id: number
  name: string
  platform: DevicePlatform
  tailscaleIp: string
  port: number
  enabled: boolean
  allowShell: boolean
  isDefault: boolean
  createdAt: number
  updatedAt: number
  lastSeenAt: number | null
  peer: { name: string; os: string; ip: string | null; online: boolean; lastSeen: string | null } | null
  agent: {
    ok?: boolean
    platform?: string
    hostname?: string
    user?: string
    os?: string
    tailscaleIp?: string
    adbReady?: boolean
    battery?: number | null
    paused?: boolean
    allowShell?: boolean
    monitors?: { index: number; width: number; height: number; primary: boolean }[]
    version?: string
  } | null
  agentError: string | null
}

type PcStatus = {
  tailnet: { connected: boolean; backendState: string; vpsIp: string | null; vpsName: string | null; devices: TailnetDevice[] }
  devices: PairedDevice[]
  mcpProviders: McpProvider[]
  audit: AuditItem[]
}

type ScreenshotState = {
  screenshotBase64: string
  mimeType?: string
  originX: number
  originY: number
  screenWidth: number
  screenHeight: number
  imageWidth: number
  imageHeight: number
  scaleX: number
  scaleY: number
  cursorX: number
  cursorY: number
}

type WindowItem = { hwnd: string; pid?: number; process: string; title: string; focused: boolean; minimized: boolean }

const statusQuery = {
  queryKey: ['pc', 'status'] as const,
  queryFn: () => unwrap(api.api.pc.status.$get()) as Promise<PcStatus>,
  refetchInterval: 6_000,
}

export function PcPage() {
  const q = useQuery(statusQuery)
  const s = q.data
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [showSetup, setShowSetup] = useState(false)

  const devices = s?.devices ?? []
  const active = devices.find((d) => d.id === selectedId) ?? devices[0] ?? null

  const settings = useMutation({
    mutationFn: (patch: { deviceId: number; enabled?: boolean; allowShell?: boolean; rotateToken?: boolean; setDefault?: boolean }) =>
      unwrap(api.api.pc.settings.$patch({ json: patch })) as Promise<PcStatus>,
    onSuccess: (next, vars) => {
      qc.setQueryData(['pc', 'status'], next)
      if (vars.rotateToken) toast.success('Secret token rotated — re-run the installer on that device')
      else if (vars.setDefault) toast.success('Updated default device for AI agents')
      else if (vars.enabled !== undefined) toast.success(vars.enabled ? 'Device control enabled' : 'Device control paused')
      else if (vars.allowShell !== undefined) toast.success(vars.allowShell ? 'Shell access enabled' : 'Shell access turned off')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const unpair = useMutation({
    mutationFn: (deviceId: number) => unwrap(api.api.pc.device.$delete({ query: { deviceId: String(deviceId) } })),
    onSuccess: () => {
      setSelectedId(null)
      void qc.invalidateQueries({ queryKey: ['pc', 'status'] })
      toast.success('Device unpaired')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const installMcp = useMutation({
    mutationFn: (sources?: string[]) =>
      unwrap(api.api.pc.mcp.install.$post({ json: sources ? { sources } : {} })) as Promise<{
        results: { id: string; label: string; ok: boolean; error?: string }[]
        status: PcStatus
      }>,
    onSuccess: (res) => {
      qc.setQueryData(['pc', 'status'], res.status)
      const okCount = res.results.filter((r) => r.ok).length
      const failCount = res.results.length - okCount
      if (failCount === 0) toast.success(`Connected my-pc Computer Use MCP to ${okCount} provider${okCount === 1 ? '' : 's'}`)
      else toast.error(`Connected ${okCount}, ${failCount} failed`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const ready = Boolean(active?.enabled && s?.tailnet.connected && active.peer?.online && active.agent?.ok && !active.agent.paused)
  const isAndroid = active?.platform === 'android'

  return (
    <>
      <PageHeader
        title="My Devices"
        description="Codex-grade computer use for your Windows PC & Android phone — locked strictly to Tailscale"
        actions={
          <div className="flex items-center gap-1.5">
            {devices.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
                <Plus className="size-4" />{adding ? 'Cancel' : 'Add device'}
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void q.refetch()}>
              <RefreshCw className={q.isFetching ? 'animate-spin' : ''} />
            </Button>
          </div>
        }
      />
      <PageBody className="gap-8 md:py-10">
        {!s ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : !s.tailnet.connected ? (
          <section className="flex max-w-2xl flex-col gap-4 rounded-2xl bg-surface p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusLight state="idle" />Tailscale node is offline
            </div>
            <p className="text-sm text-muted-foreground">
              Computer Use works strictly over your private Tailscale network and refuses all connections whenever Tailscale is off. Connect your node in Network first.
            </p>
            <div>
              <Button asChild><Link to="/network">Open Network</Link></Button>
            </div>
          </section>
        ) : devices.length === 0 || adding ? (
          <PairSection
            s={s}
            onPaired={(next, newlyPairedIp) => {
              qc.setQueryData(['pc', 'status'], next)
              const matched = next.devices.find((d) => d.tailscaleIp === newlyPairedIp)
              if (matched) setSelectedId(matched.id)
              setAdding(false)
              setShowSetup(true)
            }}
          />
        ) : active && (
          <div className="flex flex-col gap-8">
            {/* Device Switcher Tabs */}
            <div className="flex flex-wrap items-center gap-2">
              {devices.map((d) => {
                const dReady = Boolean(d.enabled && d.peer?.online && d.agent?.ok && !d.agent.paused)
                const selected = d.id === active.id
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => { setSelectedId(d.id); setShowSetup(false) }}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors',
                      selected ? 'bg-surface ring-1 ring-primary/50 text-foreground' : 'bg-surface/50 text-muted-foreground hover:bg-surface hover:text-foreground',
                    )}
                  >
                    {d.platform === 'android' ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}
                    <span>{d.name}</span>
                    <StatusLight state={dReady ? 'live' : 'idle'} />
                    {d.isDefault && <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">Default</span>}
                  </button>
                )
              })}
            </div>

            {/* Hero Status + Kill-Switch */}
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl bg-background', ready ? 'text-foreground' : 'text-muted-foreground')}>
                      {isAndroid ? <Smartphone className="size-5" /> : <Monitor className="size-5" />}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold tracking-[-0.02em]">{active.name}</h2>
                        <span className="rounded-md bg-background px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">{active.platform}</span>
                        <StatusLight state={ready ? 'live' : 'idle'} />
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Tailscale {active.tailscaleIp}:{active.port}
                        {s.tailnet.vpsIp ? ` ← VPS ${s.tailnet.vpsIp}` : ''}
                        {isAndroid && typeof active.agent?.battery === 'number' ? ` · Battery ${active.agent.battery}%` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!active.isDefault && (
                      <Button variant="ghost" size="sm" disabled={settings.isPending} onClick={() => settings.mutate({ deviceId: active.id, setDefault: true })}>
                        <Star className="size-4" />Make default
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => setShowSetup((v) => !v)}>
                      <Download className="size-4" />{showSetup ? 'Hide setup' : isAndroid ? 'Android installer' : 'Windows installer'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Unpair ${active.name}?`)) unpair.mutate(active.id) }}>
                      <Trash2 className="size-4" />Unpair
                    </Button>
                  </div>
                </div>

                {/* Live Gate Breakdown */}
                <div className="grid gap-2 sm:grid-cols-3">
                  <GatePill
                    label="Tailscale Gate"
                    ok={Boolean(active.peer?.online)}
                    detail={active.peer?.online ? 'Online on tailnet' : active.peer?.lastSeen ? `Offline (${formatAgo(active.peer.lastSeen)})` : 'Offline — blocked'}
                  />
                  <GatePill
                    label={isAndroid ? 'Termux & ADB Agent' : 'Windows Agent'}
                    ok={Boolean(active.agent?.ok && !active.agent?.paused && (!isAndroid || active.agent?.adbReady))}
                    detail={
                      active.agent?.paused ? 'Paused on device'
                        : active.agent?.ok
                          ? (isAndroid ? (active.agent.adbReady ? `Ready (${active.agent.os ?? 'Android'})` : 'Agent up — run pair-adb.sh') : `Ready (${active.agent.monitors?.length ?? 1} display)`)
                          : active.peer?.online ? 'Not running on device' : 'Waiting for Tailscale'
                    }
                  />
                  <GatePill
                    label="Kill-Switch"
                    ok={active.enabled}
                    detail={active.enabled ? (active.allowShell ? (isAndroid ? 'Active + Shell' : 'Active + PowerShell') : 'Active (GUI only)') : 'Paused in DevDash'}
                  />
                </div>

                {active.agentError && active.peer?.online && active.enabled && (
                  <p className="rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
                    {active.agentError} — Download and run the {isAndroid ? 'Termux Android' : 'Windows'} installer below while Tailscale is connected.
                  </p>
                )}
              </div>

              {/* Safety Controls */}
              <div className="flex flex-col justify-between gap-4 rounded-2xl bg-surface p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Allow {isAndroid ? 'phone' : 'PC'} control</div>
                    <p className="text-xs text-muted-foreground">Instant kill-switch across all AI agents and UI.</p>
                  </div>
                  <Switch checked={active.enabled} disabled={settings.isPending} onCheckedChange={(enabled) => settings.mutate({ deviceId: active.id, enabled })} />
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
                  <div>
                    <div className="text-sm font-medium">{isAndroid ? 'Termux & ADB shell access' : 'Full PowerShell access'}</div>
                    <p className="text-xs text-muted-foreground">Let AI run shell commands in addition to screen/touch/input.</p>
                  </div>
                  <Switch checked={active.allowShell} disabled={settings.isPending} onCheckedChange={(allowShell) => settings.mutate({ deviceId: active.id, allowShell })} />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="size-3.5" />Tailscale-only + token locked
                  </span>
                  <Button variant="ghost" size="sm" disabled={settings.isPending} onClick={() => { if (confirm('Rotate secret token? You will need to re-run the installer on this device once.')) settings.mutate({ deviceId: active.id, rotateToken: true }) }}>
                    <RotateCcw className="size-3.5" />Rotate token
                  </Button>
                </div>
              </div>
            </section>

            {/* Platform-Specific Installer Drawer */}
            {(showSetup || !active.agent?.ok) && (
              isAndroid ? (
                <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold tracking-[-0.01em]">Install on {active.name} (Android — No Root Needed)</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Runs in Termux using Android Wireless Debugging (`adb`), binds strictly to {active.tailscaleIp}:{active.port}, accepts ONLY VPS {s.tailnet.vpsIp}, and auto-stops the instant Tailscale disconnects.
                      </p>
                    </div>
                    <Button asChild>
                      <a href={`/api/pc/installer?deviceId=${active.id}`} download>
                        <Download className="size-4" />Download Termux installer (.sh)
                      </a>
                    </Button>
                  </div>
                  <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
                    <li>Install <strong>Termux</strong> (from F-Droid / GitHub) and make sure <strong>Tailscale</strong> is connected on your phone.</li>
                    <li>Download the <code className="text-foreground">.sh</code> installer above on your phone, then run in Termux:</li>
                  </ol>
                  <pre className="overflow-x-auto rounded-xl bg-background p-3 font-mono text-xs text-foreground">
                    {`termux-setup-storage\nbash ~/storage/downloads/install-devdash-android-${active.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.sh`}
                  </pre>
                  <ol start={3} className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
                    <li>Enable <strong>Developer options → Wireless debugging</strong> on your phone (split-screen with Termux) and run <code className="text-foreground">~/.devdash-android/pair-adb.sh</code> once to grant screen capture, UI tree, and touch control.</li>
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    Turning off Tailscale on Android — or running <code className="text-foreground">~/.devdash-android/stop.sh</code> — cuts off AI access immediately.
                  </p>
                </section>
              ) : (
                <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold tracking-[-0.01em]">Install on {active.name} (Windows 10/11)</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Zero dependencies — built-in Windows Win32 + UI Automation, binds strictly to {active.tailscaleIp}, locks Windows Firewall to VPS {s.tailnet.vpsIp}, and adds a System Tray kill-switch.
                      </p>
                    </div>
                    <Button asChild>
                      <a href={`/api/pc/installer?deviceId=${active.id}`} download>
                        <Download className="size-4" />Download installer (.ps1)
                      </a>
                    </Button>
                  </div>
                  <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
                    <li>Make sure <strong>Tailscale</strong> is connected on your Windows PC.</li>
                    <li>Download the installer above, then open <strong>PowerShell as Administrator</strong> (so Windows Firewall locks port <code className="text-foreground">{active.port}</code> strictly to <code className="text-foreground">{s.tailnet.vpsIp}</code>) and run:</li>
                  </ol>
                  <pre className="overflow-x-auto rounded-xl bg-background p-3 font-mono text-xs text-foreground">
                    {`powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\install-devdash-pc-${active.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.ps1"`}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Turning off Tailscale on your PC — or clicking <strong>Pause</strong> in the Windows System Tray shield icon — cuts off AI access immediately.
                  </p>
                </section>
              )
            )}

            {/* Connect AI Harnesses (Codex / Claude / OpenCode / Antigravity) */}
            <section className="flex flex-col gap-3 rounded-2xl bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold tracking-[-0.01em]">AI Computer Use MCP (<code className="font-mono text-sm">my-pc</code>)</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Exposes 21 Codex-style tools across both your Windows PC and Android phone (`pc_list_devices`, UI Automation / Android UI tree + screenshots, tap/click, drag/swipe, typing, keys, apps, clipboard, filesystem, and shell).
                  </p>
                </div>
                <Button size="sm" disabled={installMcp.isPending || s.mcpProviders.length === 0} onClick={() => installMcp.mutate(undefined)}>
                  {installMcp.isPending ? <Spinner /> : <PlugZap className="size-4" />}Connect all AI agents
                </Button>
              </div>
              {s.mcpProviders.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {s.mcpProviders.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => installMcp.mutate([p.id])}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                        p.installed && p.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-background text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {p.installed && p.enabled && <Check className="size-3" />}
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Live Interactive Screen & Remote Control */}
            {ready && (
              <LiveControl
                key={active.id}
                deviceId={active.id}
                platform={active.platform}
                allowShell={active.allowShell && active.agent?.allowShell !== false}
              />
            )}

            {/* Recent AI / Remote Activity */}
            <section className="flex flex-col gap-3">
              <h3 className="text-base font-semibold tracking-[-0.01em]">Recent activity</h3>
              {s.audit.length === 0 ? (
                <p className="rounded-2xl bg-surface p-4 text-sm text-muted-foreground">No actions yet. Ask Codex, Claude, OpenCode, or Hamasa to inspect or control your PC or Android phone once connected.</p>
              ) : (
                <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
                  {s.audit.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase', a.ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-destructive/15 text-destructive')}>
                          {a.source}
                        </span>
                        {a.deviceName && <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.deviceName}</span>}
                        <span className="truncate font-medium text-foreground">{a.summary}</span>
                      </div>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {a.durationMs}ms · {new Date(a.createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </PageBody>
    </>
  )
}

function GatePill({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-xl bg-background px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <StatusLight state={ok ? 'live' : 'idle'} />{label}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function detectPlatform(os: string): DevicePlatform {
  return /android/i.test(os) ? 'android' : 'windows'
}

function PairSection({ s, onPaired }: { s: PcStatus; onPaired: (next: PcStatus, ip: string) => void }) {
  const pairedIps = new Set(s.devices.map((d) => d.tailscaleIp))
  const candidates = s.tailnet.devices.filter((d) => d.ip)
  const defaultDev = candidates.find((d) => !pairedIps.has(d.ip!)) ?? candidates[0] ?? null
  const initialPlatform = defaultDev ? detectPlatform(defaultDev.os) : 'windows'

  const [name, setName] = useState(defaultDev?.name ?? 'my-device')
  const [platform, setPlatform] = useState<DevicePlatform>(initialPlatform)
  const [tailscaleIp, setTailscaleIp] = useState(defaultDev?.ip ?? '')
  const [port, setPort] = useState(initialPlatform === 'android' ? '47822' : '47821')
  const [allowShell, setAllowShell] = useState(true)

  const pair = useMutation({
    mutationFn: () =>
      unwrap(api.api.pc.pair.$post({
        json: {
          name: name.trim(),
          platform,
          tailscaleIp: tailscaleIp.trim(),
          port: Number(port) || (platform === 'android' ? 47822 : 47821),
          allowShell,
        },
      })) as Promise<PcStatus>,
    onSuccess: (next) => {
      toast.success(`Paired ${name.trim()} — download and run the ${platform === 'android' ? 'Termux' : 'Windows'} installer`)
      onPaired(next, tailscaleIp.trim())
    },
  })

  return (
    <div className="grid max-w-4xl gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); pair.mutate() }} className="flex flex-col gap-5 rounded-2xl bg-surface p-5">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Pair a Windows PC or Android Phone</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick any device from your Tailscale tailnet. You can pair both your Windows PC and your Android phone and switch between them anytime.
          </p>
        </div>

        {candidates.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Devices on your tailnet</span>
            <div className="flex flex-col gap-1">
              {candidates.map((d) => {
                const plat = detectPlatform(d.os)
                const already = pairedIps.has(d.ip!)
                return (
                  <button
                    key={d.dnsName || d.name}
                    type="button"
                    onClick={() => {
                      setName(d.name)
                      setPlatform(plat)
                      setTailscaleIp(d.ip ?? '')
                      setPort(plat === 'android' ? '47822' : '47821')
                    }}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                      tailscaleIp === d.ip ? 'bg-primary/15 ring-1 ring-primary/40' : 'bg-background hover:bg-surface-2',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      {plat === 'android' ? <Smartphone className="size-4 shrink-0 text-muted-foreground" /> : <Laptop className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">
                          <span className="truncate">{d.name}</span>
                          {already && <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">Paired</span>}
                        </span>
                        <span className="block text-xs text-muted-foreground tabular-nums">{d.os || plat} · {d.ip}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusLight state={d.online ? 'live' : 'idle'} />{d.online ? 'Online' : 'Offline'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => { setPlatform('windows'); if (port === '47822') setPort('47821') }}
            className={cn('flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-colors', platform === 'windows' ? 'bg-primary/15 text-foreground ring-1 ring-primary/40' : 'bg-background text-muted-foreground')}
          >
            <Monitor className="size-4" />Windows PC
          </button>
          <button
            type="button"
            onClick={() => { setPlatform('android'); if (port === '47821') setPort('47822') }}
            className={cn('flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-colors', platform === 'android' ? 'bg-primary/15 text-foreground ring-1 ring-primary/40' : 'bg-background text-muted-foreground')}
          >
            <Smartphone className="size-4" />Android Phone
          </button>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pc-name">Device name</FieldLabel>
            <Input id="pc-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field>
              <FieldLabel htmlFor="pc-ip">Tailscale IPv4</FieldLabel>
              <Input id="pc-ip" value={tailscaleIp} onChange={(e) => setTailscaleIp(e.target.value)} placeholder="100.93.73.0" className="font-mono" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="pc-port">Port</FieldLabel>
              <Input id="pc-port" value={port} onChange={(e) => setPort(e.target.value)} className="font-mono" required />
            </Field>
          </div>
        </FieldGroup>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-background px-3 py-2.5">
          <div>
            <div className="text-sm font-medium">{platform === 'android' ? 'Allow Termux & ADB shell access' : 'Allow full PowerShell access'}</div>
            <p className="text-xs text-muted-foreground">Gives AI full shell + filesystem control in addition to screen & input.</p>
          </div>
          <Switch checked={allowShell} onCheckedChange={setAllowShell} />
        </div>

        <ErrorAlert error={pair.error} />
        <div>
          <Button type="submit" disabled={pair.isPending || !name.trim() || !tailscaleIp.trim()}>
            {pair.isPending ? <Spinner /> : `Pair ${platform === 'android' ? 'Android phone' : 'Windows PC'} & generate installer`}
          </Button>
        </div>
      </form>

      <aside className="flex flex-col gap-3 rounded-2xl bg-surface p-5 text-xs text-muted-foreground">
        <h3 className="text-sm font-semibold text-foreground">Tailscale-only security (PC & Android)</h3>
        <p>1. Both agents bind strictly to their Tailscale IP (<code className="text-foreground">100.x.y.z</code>) — never public internet or LAN.</p>
        <p>2. Every request requires a sealed 256-bit Bearer token AND must originate from your DevDash VPS (<code className="text-foreground">{s.tailnet.vpsIp ?? '100.x.y.z'}</code>).</p>
        <p>3. DevDash checks live Tailscale peer status before every action. Turn off Tailscale on your PC or phone and access stops immediately.</p>
      </aside>
    </div>
  )
}

function LiveControl({ deviceId, platform, allowShell }: { deviceId: number; platform: DevicePlatform; allowShell: boolean }) {
  const qc = useQueryClient()
  const imgRef = useRef<HTMLImageElement>(null)
  const [shot, setShot] = useState<ScreenshotState | null>(null)
  const [windows, setWindows] = useState<WindowItem[]>([])
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [typeText, setTypeText] = useState('')
  const [psCmd, setPsCmd] = useState('')
  const [psOut, setPsOut] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null)
  const isAndroid = platform === 'android'

  const runAction = useMutation({
    mutationFn: ({ tool, args }: { tool: string; args?: Record<string, unknown> }) =>
      unwrap(api.api.pc.action.$post({ json: { deviceId, tool, args: args ?? {} } })) as Promise<Record<string, unknown>>,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pc', 'status'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  const capture = async () => {
    const res = await runAction.mutateAsync({ tool: 'pc_screenshot', args: { maxWidth: 1280, quality: 70 } })
    if (typeof res.screenshotBase64 === 'string') setShot(res as unknown as ScreenshotState)
  }

  const refreshWindows = async () => {
    const res = await runAction.mutateAsync({ tool: 'pc_list_windows', args: {} })
    if (Array.isArray(res.windows)) setWindows(res.windows as WindowItem[])
  }

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => { void capture() }, 3000)
    return () => clearInterval(id)
  }, [autoRefresh, deviceId])

  const onScreenClick = async (e: MouseEvent<HTMLImageElement>) => {
    if (!shot || !imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const rx = (e.clientX - rect.left) / rect.width
    const ry = (e.clientY - rect.top) / rect.height
    const x = Math.round(shot.originX + rx * shot.screenWidth)
    const y = Math.round(shot.originY + ry * shot.screenHeight)
    await runAction.mutateAsync({ tool: 'pc_click', args: { x, y, button: 'left', clicks: 1 } })
    setTimeout(() => { void capture() }, 350)
  }

  const quickKeys = isAndroid
    ? ['Back', 'Home', 'Recents', 'Notifications', 'QuickSettings', 'Wake', 'Enter', 'Backspace']
    : ['Win', 'Alt+Tab', 'Enter', 'Escape', 'Backspace', 'Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+Esc']

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold tracking-[-0.01em]">Live Screen & Remote Control</h3>
          {runAction.isPending && <Spinner />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void capture()} disabled={runAction.isPending}>
            <Camera className="size-4" />{shot ? 'Refresh screen' : 'Capture screen'}
          </Button>
          <Button size="sm" variant={autoRefresh ? 'default' : 'secondary'} onClick={() => setAutoRefresh((v) => !v)}>
            {autoRefresh ? 'Auto 3s: ON' : 'Auto 3s: OFF'}
          </Button>
          {!isAndroid && (
            <Button size="sm" variant="secondary" onClick={() => void refreshWindows()} disabled={runAction.isPending}>
              <AppWindow className="size-4" />Windows
            </Button>
          )}
        </div>
      </div>

      {shot && (
        <div className={cn('overflow-hidden rounded-xl border border-border/60 bg-black', isAndroid && 'mx-auto max-w-sm')}>
          <img
            ref={imgRef}
            src={`data:${shot.mimeType || 'image/jpeg'};base64,${shot.screenshotBase64}`}
            alt={isAndroid ? 'Live Android phone screen' : 'Live Windows PC screen'}
            onClick={(e) => void onScreenClick(e)}
            className="w-full cursor-crosshair select-none object-contain"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 bg-background/80 px-3 py-1.5 text-[11px] text-muted-foreground tabular-nums">
            <span>Tap anywhere on screen to {isAndroid ? 'tap' : 'click'} · {shot.screenWidth}×{shot.screenHeight}</span>
            {!isAndroid && <span>Cursor ({shot.cursorX}, {shot.cursorY})</span>}
          </div>
        </div>
      )}

      {/* Quick keys & scroll/swipe */}
      <div className="flex flex-wrap gap-1.5">
        {quickKeys.map((k) => (
          <Button key={k} size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
            await runAction.mutateAsync({ tool: 'pc_press_key', args: { key: k } })
            if (shot) setTimeout(() => { void capture() }, 350)
          }}>{k}</Button>
        ))}
        <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
          await runAction.mutateAsync({ tool: 'pc_scroll', args: { deltaY: 4 } })
          if (shot) setTimeout(() => { void capture() }, 350)
        }}>{isAndroid ? 'Swipe Down' : 'Scroll Up'}</Button>
        <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
          await runAction.mutateAsync({ tool: 'pc_scroll', args: { deltaY: -4 } })
          if (shot) setTimeout(() => { void capture() }, 350)
        }}>{isAndroid ? 'Swipe Up' : 'Scroll Down'}</Button>
      </div>

      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!typeText) return
          await runAction.mutateAsync({ tool: 'pc_type_text', args: { text: typeText, enter: true } })
          setTypeText('')
          if (shot) setTimeout(() => { void capture() }, 350)
        }}
      >
        <Input value={typeText} onChange={(e) => setTypeText(e.target.value)} placeholder={`Type text to send to ${isAndroid ? 'phone' : 'PC'} (+ Enter)…`} className="flex-1" />
        <Button type="submit" size="sm" disabled={!typeText || runAction.isPending}><Keyboard className="size-4" />Send</Button>
      </form>

      {windows.length > 0 && !isAndroid && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Open windows (tap to focus)</span>
          <div className="flex flex-wrap gap-1.5">
            {windows.slice(0, 14).map((w) => (
              <Button
                key={w.hwnd}
                size="sm"
                variant={w.focused ? 'default' : 'secondary'}
                className="h-7 max-w-[16rem] truncate text-xs"
                onClick={async () => {
                  await runAction.mutateAsync({ tool: 'pc_window_action', args: { hwnd: w.hwnd, action: 'focus' } })
                  setTimeout(() => { void capture() }, 300)
                }}
              >
                {w.title}
              </Button>
            ))}
          </div>
        </div>
      )}

      {allowShell && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!psCmd.trim()) return
              const res = await runAction.mutateAsync({ tool: 'pc_run_powershell', args: { command: psCmd } })
              setPsOut({
                stdout: typeof res.stdout === 'string' ? res.stdout : '',
                stderr: typeof res.stderr === 'string' ? res.stderr : '',
                exitCode: typeof res.exitCode === 'number' ? res.exitCode : 0,
              })
            }}
          >
            <Input
              value={psCmd}
              onChange={(e) => setPsCmd(e.target.value)}
              placeholder={isAndroid ? 'Run Termux shell (or prefix with "adb:" e.g. adb:dumpsys battery)' : 'Run PowerShell on PC (e.g. Get-Process | Select -First 5)'}
              className="flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!psCmd.trim() || runAction.isPending}><Terminal className="size-4" />Run</Button>
          </form>
          {psOut && (
            <pre className="max-h-56 overflow-auto rounded-xl bg-background p-3 font-mono text-xs text-foreground whitespace-pre-wrap">
              {[psOut.stdout, psOut.stderr].filter(Boolean).join('\n') || `(exit ${psOut.exitCode ?? 0})`}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}

function formatAgo(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}
