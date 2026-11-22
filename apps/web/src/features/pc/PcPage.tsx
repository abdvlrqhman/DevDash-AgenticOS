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
  RefreshCw,
  RotateCcw,
  ShieldCheck,
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

type TailnetDevice = { name: string; dnsName: string; os: string; ip: string | null; online: boolean; lastSeen: string | null }
type McpProvider = { id: string; label: string; installed: boolean; enabled: boolean }
type AuditItem = { id: number; source: string; action: string; summary: string; ok: boolean; durationMs: number; createdAt: number }
type PcStatus = {
  tailnet: { connected: boolean; backendState: string; vpsIp: string | null; vpsName: string | null; devices: TailnetDevice[] }
  device: { id: number; name: string; tailscaleIp: string; port: number; enabled: boolean; allowShell: boolean; createdAt: number; updatedAt: number; lastSeenAt: number | null } | null
  peer: { name: string; os: string; ip: string | null; online: boolean; lastSeen: string | null } | null
  agent: {
    ok?: boolean
    hostname?: string
    user?: string
    os?: string
    tailscaleIp?: string
    paused?: boolean
    allowShell?: boolean
    monitors?: { index: number; width: number; height: number; primary: boolean }[]
    version?: string
  } | null
  agentError: string | null
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

type WindowItem = { hwnd: string; pid: number; process: string; title: string; focused: boolean; minimized: boolean }

const statusQuery = {
  queryKey: ['pc', 'status'] as const,
  queryFn: () => unwrap(api.api.pc.status.$get()) as Promise<PcStatus>,
  refetchInterval: 6_000,
}

export function PcPage() {
  const q = useQuery(statusQuery)
  const s = q.data
  const qc = useQueryClient()
  const [showSetup, setShowSetup] = useState(false)

  const settings = useMutation({
    mutationFn: (patch: { enabled?: boolean; allowShell?: boolean; rotateToken?: boolean }) =>
      unwrap(api.api.pc.settings.$patch({ json: patch })) as Promise<PcStatus>,
    onSuccess: (next, vars) => {
      qc.setQueryData(['pc', 'status'], next)
      if (vars.rotateToken) toast.success('Secret token rotated — re-run the Windows installer to apply it')
      else if (vars.enabled !== undefined) toast.success(vars.enabled ? 'PC Computer Use enabled' : 'PC Computer Use paused')
      else if (vars.allowShell !== undefined) toast.success(vars.allowShell ? 'PowerShell access enabled' : 'PowerShell access turned off')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const unpair = useMutation({
    mutationFn: () => unwrap(api.api.pc.device.$delete()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pc', 'status'] })
      toast.success('PC unpaired')
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

  const ready = Boolean(s?.device?.enabled && s.tailnet.connected && s.peer?.online && s.agent?.ok && !s.agent.paused)

  return (
    <>
      <PageHeader
        title="My PC"
        description="Codex-grade full computer use on your Windows PC — locked strictly to Tailscale"
        actions={
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void q.refetch()}>
            <RefreshCw className={q.isFetching ? 'animate-spin' : ''} />
          </Button>
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
              PC Computer Use works strictly over your private Tailscale network and refuses all connections whenever Tailscale is off. Connect your node in Network first.
            </p>
            <div>
              <Button asChild><Link to="/network">Open Network</Link></Button>
            </div>
          </section>
        ) : !s.device ? (
          <PairSection s={s} onPaired={(next) => { qc.setQueryData(['pc', 'status'], next); setShowSetup(true) }} />
        ) : (
          <div className="flex flex-col gap-8">
            {/* Hero Status + Kill-Switch */}
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl bg-background', ready ? 'text-foreground' : 'text-muted-foreground')}>
                      <Monitor className="size-5" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-semibold tracking-[-0.02em]">{s.device.name}</h2>
                        <StatusLight state={ready ? 'live' : 'idle'} />
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Tailscale {s.device.tailscaleIp}:{s.device.port}
                        {s.tailnet.vpsIp ? ` ← VPS ${s.tailnet.vpsIp}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setShowSetup((v) => !v)}>
                      <Download className="size-4" />{showSetup ? 'Hide installer' : 'Windows installer'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Unpair ${s.device?.name}?`)) unpair.mutate() }}>
                      <Trash2 className="size-4" />Unpair
                    </Button>
                  </div>
                </div>

                {/* Live Gate Breakdown */}
                <div className="grid gap-2 sm:grid-cols-3">
                  <GatePill
                    label="Tailscale Gate"
                    ok={Boolean(s.peer?.online)}
                    detail={s.peer?.online ? 'Online on tailnet' : s.peer?.lastSeen ? `Offline (${formatAgo(s.peer.lastSeen)})` : 'Offline — blocked'}
                  />
                  <GatePill
                    label="Windows Agent"
                    ok={Boolean(s.agent?.ok && !s.agent?.paused)}
                    detail={s.agent?.paused ? 'Paused in PC tray' : s.agent?.ok ? `Ready (${s.agent.monitors?.length ?? 1} display)` : s.peer?.online ? 'Not running on PC' : 'Waiting for Tailscale'}
                  />
                  <GatePill
                    label="Kill-Switch"
                    ok={s.device.enabled}
                    detail={s.device.enabled ? (s.device.allowShell ? 'Active + PowerShell' : 'Active (GUI only)') : 'Paused in DevDash'}
                  />
                </div>

                {s.agentError && s.peer?.online && s.device.enabled && (
                  <p className="rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
                    {s.agentError} — Download and run the Windows installer below while Tailscale is connected on your PC.
                  </p>
                )}
              </div>

              {/* Safety Controls */}
              <div className="flex flex-col justify-between gap-4 rounded-2xl bg-surface p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Allow PC control</div>
                    <p className="text-xs text-muted-foreground">Instant kill-switch across all AI agents and UI.</p>
                  </div>
                  <Switch checked={s.device.enabled} disabled={settings.isPending} onCheckedChange={(enabled) => settings.mutate({ enabled })} />
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
                  <div>
                    <div className="text-sm font-medium">Full PowerShell access</div>
                    <p className="text-xs text-muted-foreground">Let AI run PowerShell commands in addition to GUI.</p>
                  </div>
                  <Switch checked={s.device.allowShell} disabled={settings.isPending} onCheckedChange={(allowShell) => settings.mutate({ allowShell })} />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="size-3.5" />Tailscale-only + token locked
                  </span>
                  <Button variant="ghost" size="sm" disabled={settings.isPending} onClick={() => { if (confirm('Rotate secret token? You will need to re-run the Windows installer once.')) settings.mutate({ rotateToken: true }) }}>
                    <RotateCcw className="size-3.5" />Rotate token
                  </Button>
                </div>
              </div>
            </section>

            {/* Windows Installer Drawer */}
            {(showSetup || !s.agent?.ok) && (
              <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold tracking-[-0.01em]">Install on {s.device.name} (Windows 10/11)</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Zero dependencies — uses built-in Windows Win32 + UI Automation, binds strictly to {s.device.tailscaleIp}, locks Windows Firewall to VPS {s.tailnet.vpsIp}, and adds a System Tray kill-switch.
                    </p>
                  </div>
                  <Button asChild>
                    <a href="/api/pc/installer.ps1" download>
                      <Download className="size-4" />Download installer (.ps1)
                    </a>
                  </Button>
                </div>
                <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
                  <li>Make sure <strong>Tailscale</strong> is connected on your Windows PC.</li>
                  <li>Download the installer above, then open <strong>PowerShell as Administrator</strong> (so Windows Firewall locks port <code className="text-foreground">{s.device.port}</code> strictly to <code className="text-foreground">{s.tailnet.vpsIp}</code>) and run:</li>
                </ol>
                <pre className="overflow-x-auto rounded-xl bg-background p-3 font-mono text-xs text-foreground">
                  {`powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\install-devdash-pc-${s.device.name}.ps1"`}
                </pre>
                <p className="text-xs text-muted-foreground">
                  Turning off Tailscale on your PC — or clicking <strong>Pause</strong> in the Windows System Tray shield icon — cuts off AI access immediately.
                </p>
              </section>
            )}

            {/* Connect AI Harnesses (Codex / Claude / OpenCode / Antigravity) */}
            <section className="flex flex-col gap-3 rounded-2xl bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold tracking-[-0.01em]">AI Computer Use MCP (<code className="font-mono text-sm">my-pc</code>)</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Exposes 20 Codex-style tools (UI Automation tree + screenshots, click, drag, scroll, Unicode typing, hotkeys, window management, clipboard, filesystem, and PowerShell) to every AI harness with zero tokens in config files.
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
            {ready && <LiveControl allowShell={s.device.allowShell && s.agent?.allowShell !== false} />}

            {/* Recent AI / Remote Activity */}
            <section className="flex flex-col gap-3">
              <h3 className="text-base font-semibold tracking-[-0.01em]">Recent PC activity</h3>
              {s.audit.length === 0 ? (
                <p className="rounded-2xl bg-surface p-4 text-sm text-muted-foreground">No actions yet. Ask Codex, Claude, OpenCode, or Hamasa to inspect or control your PC once connected.</p>
              ) : (
                <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
                  {s.audit.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase', a.ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-destructive/15 text-destructive')}>
                          {a.source}
                        </span>
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

function PairSection({ s, onPaired }: { s: PcStatus; onPaired: (next: PcStatus) => void }) {
  const defaultPc = s.tailnet.devices.find((d) => /windows/i.test(d.os) && d.ip) ?? s.tailnet.devices.find((d) => d.ip) ?? null
  const [name, setName] = useState(defaultPc?.name ?? 'my-windows-pc')
  const [tailscaleIp, setTailscaleIp] = useState(defaultPc?.ip ?? '')
  const [port, setPort] = useState('47821')
  const [allowShell, setAllowShell] = useState(true)

  const pair = useMutation({
    mutationFn: () =>
      unwrap(api.api.pc.pair.$post({
        json: { name: name.trim(), tailscaleIp: tailscaleIp.trim(), port: Number(port) || 47821, allowShell },
      })) as Promise<PcStatus>,
    onSuccess: (next) => {
      toast.success(`Paired ${next.device?.name} — download and run the Windows installer`)
      onPaired(next)
    },
  })

  return (
    <div className="grid max-w-4xl gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); pair.mutate() }} className="flex flex-col gap-5 rounded-2xl bg-surface p-5">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Pair your Windows PC over Tailscale</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a device from your Tailscale tailnet. DevDash generates a private token and a Tailscale-locked Windows installer that only works while Tailscale is connected.
          </p>
        </div>

        {s.tailnet.devices.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Devices on your tailnet</span>
            <div className="flex flex-col gap-1">
              {s.tailnet.devices.filter((d) => d.ip).map((d) => (
                <button
                  key={d.dnsName || d.name}
                  type="button"
                  onClick={() => { setName(d.name); setTailscaleIp(d.ip ?? '') }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors',
                    tailscaleIp === d.ip ? 'bg-primary/15 ring-1 ring-primary/40' : 'bg-background hover:bg-surface-2',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Laptop className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.name}</span>
                      <span className="block text-xs text-muted-foreground tabular-nums">{d.os || 'device'} · {d.ip}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusLight state={d.online ? 'live' : 'idle'} />{d.online ? 'Online' : 'Offline'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pc-name">PC name</FieldLabel>
            <Input id="pc-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <Field>
              <FieldLabel htmlFor="pc-ip">Tailscale IPv4</FieldLabel>
              <Input id="pc-ip" value={tailscaleIp} onChange={(e) => setTailscaleIp(e.target.value)} placeholder="100.67.118.37" className="font-mono" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="pc-port">Port</FieldLabel>
              <Input id="pc-port" value={port} onChange={(e) => setPort(e.target.value)} className="font-mono" required />
            </Field>
          </div>
        </FieldGroup>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-background px-3 py-2.5">
          <div>
            <div className="text-sm font-medium">Allow full PowerShell access</div>
            <p className="text-xs text-muted-foreground">Gives AI full shell + filesystem control in addition to screen/mouse/keyboard.</p>
          </div>
          <Switch checked={allowShell} onCheckedChange={setAllowShell} />
        </div>

        <ErrorAlert error={pair.error} />
        <div>
          <Button type="submit" disabled={pair.isPending || !name.trim() || !tailscaleIp.trim()}>
            {pair.isPending ? <Spinner /> : 'Pair PC & generate installer'}
          </Button>
        </div>
      </form>

      <aside className="flex flex-col gap-3 rounded-2xl bg-surface p-5 text-xs text-muted-foreground">
        <h3 className="text-sm font-semibold text-foreground">How Tailscale-only security works</h3>
        <p>1. Your PC agent binds strictly to its Tailscale IP (<code className="text-foreground">100.x.y.z</code>) — never public internet or LAN.</p>
        <p>2. Windows Firewall + app-level peer check accept traffic <strong>only</strong> from your DevDash VPS (<code className="text-foreground">{s.tailnet.vpsIp ?? '100.x.y.z'}</code>) with a 256-bit sealed bearer token.</p>
        <p>3. DevDash checks live Tailscale peer status before every action. Turn off Tailscale on your PC and access drops instantly.</p>
      </aside>
    </div>
  )
}

function LiveControl({ allowShell }: { allowShell: boolean }) {
  const qc = useQueryClient()
  const imgRef = useRef<HTMLImageElement>(null)
  const [shot, setShot] = useState<ScreenshotState | null>(null)
  const [windows, setWindows] = useState<WindowItem[]>([])
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [typeText, setTypeText] = useState('')
  const [psCmd, setPsCmd] = useState('')
  const [psOut, setPsOut] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null)

  const runAction = useMutation({
    mutationFn: ({ tool, args }: { tool: string; args?: Record<string, unknown> }) =>
      unwrap(api.api.pc.action.$post({ json: { tool, args: args ?? {} } })) as Promise<Record<string, unknown>>,
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
  }, [autoRefresh])

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
          <Button size="sm" variant="secondary" onClick={() => void refreshWindows()} disabled={runAction.isPending}>
            <AppWindow className="size-4" />Windows
          </Button>
        </div>
      </div>

      {shot && (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-black">
          <img
            ref={imgRef}
            src={`data:${shot.mimeType || 'image/jpeg'};base64,${shot.screenshotBase64}`}
            alt="Live Windows PC screen"
            onClick={(e) => void onScreenClick(e)}
            className="w-full cursor-crosshair select-none object-contain"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 bg-background/80 px-3 py-1.5 text-[11px] text-muted-foreground tabular-nums">
            <span>Tap anywhere on screen to click · {shot.screenWidth}×{shot.screenHeight}</span>
            <span>Cursor ({shot.cursorX}, {shot.cursorY})</span>
          </div>
        </div>
      )}

      {/* Quick hotkeys & typing */}
      <div className="flex flex-wrap gap-1.5">
        {['Win', 'Alt+Tab', 'Enter', 'Escape', 'Backspace', 'Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+Esc'].map((k) => (
          <Button key={k} size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
            await runAction.mutateAsync({ tool: 'pc_press_key', args: { key: k } })
            if (shot) setTimeout(() => { void capture() }, 300)
          }}>{k}</Button>
        ))}
        <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
          await runAction.mutateAsync({ tool: 'pc_scroll', args: { deltaY: 4 } })
          if (shot) setTimeout(() => { void capture() }, 300)
        }}>Scroll Up</Button>
        <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={async () => {
          await runAction.mutateAsync({ tool: 'pc_scroll', args: { deltaY: -4 } })
          if (shot) setTimeout(() => { void capture() }, 300)
        }}>Scroll Down</Button>
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
        <Input value={typeText} onChange={(e) => setTypeText(e.target.value)} placeholder="Type text to send to PC (+ Enter)…" className="flex-1" />
        <Button type="submit" size="sm" disabled={!typeText || runAction.isPending}><Keyboard className="size-4" />Send</Button>
      </form>

      {windows.length > 0 && (
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
            <Input value={psCmd} onChange={(e) => setPsCmd(e.target.value)} placeholder="Run PowerShell on PC (e.g. Get-Process | Select -First 5)" className="flex-1 font-mono text-xs" />
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
