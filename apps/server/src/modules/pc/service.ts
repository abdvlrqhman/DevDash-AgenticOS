import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Db } from '../../core/db.ts'
import { newToken, seal, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { TailnetService } from '../tailnet/service.ts'
import { renderWindowsInstallerScript } from './windows-agent.ts'
import { renderAndroidInstallerScript } from './android-agent.ts'

export const DEFAULT_PC_PORT = 47821
export const DEFAULT_ANDROID_PORT = 47822
export const PC_MCP_NAME = 'my-pc'

export type DevicePlatform = 'windows' | 'android'

type PcDeviceRow = {
  id: number
  user_id: number
  name: string
  platform: DevicePlatform
  tailscale_ip: string
  port: number
  token_sealed: string
  enabled: number
  allow_shell: number
  is_default: number
  created_at: number
  updated_at: number
  last_seen_at: number | null
}

type PcAuditRow = {
  id: number
  device_id: number | null
  device_name: string | null
  source: string
  action: string
  summary: string
  ok: number
  duration_ms: number
  created_at: number
}

type McpInventory = {
  sources: { id: string; label: string; revision: string; canToggle?: boolean; error?: string }[]
  entries: { source: string; name: string; transport: string; host: string | null; enabled: boolean }[]
}

export function isTailscaleIp(ip: string): boolean {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  if (nums.some((n) => n < 0 || n > 255)) return false
  return nums[0] === 100 && nums[1]! >= 64 && nums[1]! <= 127
}

function summarizeAction(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'pc_list_devices': return 'Listed paired devices'
    case 'pc_status': return 'Checked device health'
    case 'pc_list_monitors': return 'Listed displays'
    case 'pc_list_apps': return 'Listed apps'
    case 'pc_list_windows': return 'Listed open windows'
    case 'pc_get_window_state': return args.hwnd ? `Inspected window ${args.hwnd}` : 'Inspected active screen + UI tree'
    case 'pc_screenshot': return args.hwnd ? `Screenshot window ${args.hwnd}` : args.monitor !== undefined ? `Screenshot display ${args.monitor}` : 'Screenshot'
    case 'pc_window_action': return `Window ${String(args.action ?? 'focus')} ${String(args.title ?? args.hwnd ?? '')}`.trim()
    case 'pc_launch_app': return `Launch ${String(args.target ?? '').slice(0, 80)}`
    case 'pc_kill_app': return `Stop ${String(args.name ?? args.pid ?? '')}`
    case 'pc_click': return args.elementId ? `Tap/click element ${args.elementId}` : `Tap/click (${args.x}, ${args.y}) ${String(args.button ?? 'left')}`
    case 'pc_move_mouse': return args.elementId ? `Move cursor to ${args.elementId}` : `Move cursor (${args.x}, ${args.y})`
    case 'pc_drag': return `Drag/swipe (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`
    case 'pc_scroll': return `Scroll dy=${args.deltaY ?? -3} dx=${args.deltaX ?? 0}`
    case 'pc_type_text': return `Typed ${String(args.text ?? '').length} chars${args.enter ? ' + Enter' : ''}`
    case 'pc_set_value': return `Set value on ${String(args.elementId ?? `(${args.x}, ${args.y})`)}`
    case 'pc_press_key': return `Key ${String(args.key ?? '')}`
    case 'pc_clipboard': return args.mode === 'set' ? `Set clipboard (${String(args.text ?? '').length} chars)` : 'Read clipboard'
    case 'pc_run_powershell': return `Shell: ${String(args.command ?? '').replace(/\s+/g, ' ').slice(0, 80)}`
    case 'pc_fs': return `FS ${String(args.mode ?? '')} ${String(args.path ?? '').slice(0, 80)}`
    case 'pc_wait': return `Wait ${Number(args.ms ?? 1000)}ms`
    default: return tool
  }
}

export function pcMcpCommandPath(): string {
  const current = resolve(import.meta.dirname, '../../../../../packages/claude-plugin/mcp/pc.mjs')
  if (current.startsWith('/opt/devdash/releases/')) {
    return '/opt/devdash/current/packages/claude-plugin/mcp/pc.mjs'
  }
  return current
}

export function pcService({
  db,
  agents,
  tailnet,
  masterKey,
}: {
  db: Db
  agents: AgentsService
  tailnet: TailnetService
  masterKey: Buffer
}) {
  const q = {
    userByName: db.prepare('select id, username, name, email, role from users where username = ? and disabled_at is null'),
    devices: db.prepare('select * from pc_devices where user_id = ? order by is_default desc, id asc'),
    deviceById: db.prepare('select * from pc_devices where user_id = ? and id = ?'),
    upsert: db.prepare(`
      insert into pc_devices (user_id, name, platform, tailscale_ip, port, token_sealed, enabled, allow_shell, is_default, updated_at)
      values (?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch())
      on conflict(user_id, tailscale_ip) do update set
        name = excluded.name,
        platform = excluded.platform,
        port = excluded.port,
        token_sealed = excluded.token_sealed,
        enabled = 1,
        allow_shell = excluded.allow_shell,
        updated_at = unixepoch()
    `),
    clearDefault: db.prepare('update pc_devices set is_default = 0 where user_id = ?'),
    setDefault: db.prepare('update pc_devices set is_default = 1 where user_id = ? and id = ?'),
    updateSettings: db.prepare('update pc_devices set enabled = ?, allow_shell = ?, updated_at = unixepoch() where user_id = ? and id = ?'),
    rotateToken: db.prepare('update pc_devices set token_sealed = ?, updated_at = unixepoch() where user_id = ? and id = ?'),
    touchSeen: db.prepare('update pc_devices set last_seen_at = unixepoch() where id = ?'),
    removeById: db.prepare('delete from pc_devices where user_id = ? and id = ?'),
    removeAll: db.prepare('delete from pc_devices where user_id = ?'),
    addAudit: db.prepare('insert into pc_audit_log (user_id, device_id, source, action, summary, ok, duration_ms) values (?, ?, ?, ?, ?, ?, ?)'),
    pruneAudit: db.prepare('delete from pc_audit_log where user_id = ? and id not in (select id from pc_audit_log where user_id = ? order by id desc limit 200)'),
    recentAudit: db.prepare(`
      select a.id, a.device_id, d.name as device_name, a.source, a.action, a.summary, a.ok, a.duration_ms, a.created_at
      from pc_audit_log a
      left join pc_devices d on d.id = a.device_id
      where a.user_id = ?
      order by a.id desc
      limit 40
    `),
  }

  function resolveDevice(userId: number, selector?: string | number | null): PcDeviceRow {
    const list = q.devices.all(userId) as PcDeviceRow[]
    if (!list.length) {
      throw new AppError(404, 'pc_not_paired', 'No device is paired yet. Open My Devices in DevDash to pair your Windows PC or Android phone over Tailscale.')
    }
    if (selector === undefined || selector === null || selector === '') {
      return list[0]!
    }
    if (typeof selector === 'number' || /^\d+$/.test(String(selector))) {
      const byId = list.find((d) => d.id === Number(selector))
      if (byId) return byId
    }
    const needle = String(selector).trim().toLowerCase()
    const match =
      list.find((d) => d.tailscale_ip === needle) ??
      list.find((d) => d.name.toLowerCase() === needle) ??
      list.find((d) => d.platform === needle) ??
      list.find((d) => d.name.toLowerCase().includes(needle))
    if (!match) {
      throw new AppError(404, 'pc_not_found', `Device "${selector}" not found. Paired devices: ${list.map((d) => `${d.name} (${d.platform})`).join(', ')}.`)
    }
    return match
  }

  async function callAgent(
    username: string,
    device: PcDeviceRow,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
    fresh = false,
  ): Promise<Record<string, unknown>> {
    const token = unseal(masterKey, device.token_sealed, `pc:${device.user_id}`).toString('utf8')
    const res = await agents.request<{ httpStatus: number; data: Record<string, unknown> }>(
      username,
      {
        op: 'pc.request',
        targetIp: device.tailscale_ip,
        port: device.port,
        token,
        method,
        path,
        body,
        timeoutMs,
        fresh,
      },
      timeoutMs + 5_000,
    )
    if (res.httpStatus === 401 || res.httpStatus === 403) {
      throw new AppError(403, 'pc_auth_failed', String(res.data?.error ?? 'Device agent rejected authentication. Re-run the installer on your device.'))
    }
    if (res.httpStatus >= 400) {
      throw new AppError(400, 'pc_action_failed', String(res.data?.error ?? `Device agent returned HTTP ${res.httpStatus}`))
    }
    q.touchSeen.run(device.id)
    return res.data ?? {}
  }

  async function mcpProviders(username: string) {
    try {
      const inv = await agents.request<McpInventory>(username, { op: 'mcps.list' }, 10_000)
      return inv.sources
        .filter((s) => !s.error)
        .map((s) => {
          const entry = inv.entries.find((e) => e.source === s.id && e.name === PC_MCP_NAME)
          return { id: s.id, label: s.label, revision: s.revision, installed: Boolean(entry), enabled: entry?.enabled ?? false }
        })
    } catch {
      return []
    }
  }

  async function status(user: User) {
    const [ts, providers] = await Promise.all([
      tailnet.status(user),
      mcpProviders(user.username),
    ])
    const rows = q.devices.all(user.id) as PcDeviceRow[]
    const vpsIp = ts.self?.tailscaleIPs?.[0] ?? null
    const tsRunning = ts.running && ts.backendState === 'Running'

    const devices = await Promise.all(
      rows.map(async (row) => {
        const peer = ts.devices.find((d) => d.ip === row.tailscale_ip) ?? null
        let agentHealth: Record<string, unknown> | null = null
        let agentError: string | null = null
        if (row.enabled === 1 && tsRunning && peer?.online) {
          try {
            agentHealth = await callAgent(user.username, row, 'GET', '/health', undefined, 5_000)
          } catch (err) {
            agentError = err instanceof Error ? err.message : 'Device agent is not responding.'
          }
        }
        return {
          id: row.id,
          name: row.name,
          platform: row.platform,
          tailscaleIp: row.tailscale_ip,
          port: row.port,
          enabled: row.enabled === 1,
          allowShell: row.allow_shell === 1,
          isDefault: row.is_default === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastSeenAt: row.last_seen_at,
          peer: peer ? { name: peer.name, os: peer.os, ip: peer.ip, online: peer.online, lastSeen: peer.lastSeen } : null,
          agent: agentHealth,
          agentError,
        }
      }),
    )

    const primary = devices[0] ?? null
    const audit = (q.recentAudit.all(user.id) as PcAuditRow[]).map((a) => ({
      id: a.id,
      deviceId: a.device_id,
      deviceName: a.device_name,
      source: a.source,
      action: a.action,
      summary: a.summary,
      ok: a.ok === 1,
      durationMs: a.duration_ms,
      createdAt: a.created_at,
    }))

    return {
      tailnet: {
        connected: tsRunning,
        backendState: ts.backendState,
        vpsIp,
        vpsName: ts.self?.hostName ?? null,
        devices: ts.devices,
      },
      devices,
      device: primary
        ? {
            id: primary.id,
            name: primary.name,
            platform: primary.platform,
            tailscaleIp: primary.tailscaleIp,
            port: primary.port,
            enabled: primary.enabled,
            allowShell: primary.allowShell,
            isDefault: primary.isDefault,
            createdAt: primary.createdAt,
            updatedAt: primary.updatedAt,
            lastSeenAt: primary.lastSeenAt,
          }
        : null,
      peer: primary?.peer ?? null,
      agent: primary?.agent ?? null,
      agentError: primary?.agentError ?? null,
      mcpProviders: providers.map(({ id, label, installed, enabled }) => ({ id, label, installed, enabled })),
      audit,
    }
  }

  async function pair(
    user: User,
    input: { name: string; tailscaleIp: string; platform?: DevicePlatform; port?: number; allowShell?: boolean },
  ) {
    const name = input.name.trim().slice(0, 80)
    const ip = input.tailscaleIp.trim()
    const platform: DevicePlatform = input.platform === 'android' ? 'android' : 'windows'
    const port = input.port ?? (platform === 'android' ? DEFAULT_ANDROID_PORT : DEFAULT_PC_PORT)
    const allowShell = input.allowShell !== false
    if (!name) throw new AppError(400, 'bad_args', 'Enter a name for your device.')
    if (!isTailscaleIp(ip)) throw new AppError(400, 'bad_args', 'Choose a valid Tailscale IPv4 address (100.64.0.0/10).')
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AppError(400, 'bad_args', 'Port must be between 1024 and 65535.')

    const existing = q.devices.all(user.id) as PcDeviceRow[]
    const isFirst = existing.length === 0 ? 1 : 0
    const token = newToken()
    const sealed = seal(masterKey, Buffer.from(token, 'utf8'), `pc:${user.id}`)
    q.upsert.run(user.id, name, platform, ip, port, sealed, allowShell ? 1 : 0, isFirst)
    return status(user)
  }

  async function updateSettings(
    user: User,
    patch: { deviceId?: number; enabled?: boolean; allowShell?: boolean; rotateToken?: boolean; setDefault?: boolean },
  ) {
    const row = resolveDevice(user.id, patch.deviceId)
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled
    const allowShell = patch.allowShell !== undefined ? (patch.allowShell ? 1 : 0) : row.allow_shell
    q.updateSettings.run(enabled, allowShell, user.id, row.id)
    if (patch.rotateToken) {
      q.rotateToken.run(seal(masterKey, Buffer.from(newToken(), 'utf8'), `pc:${user.id}`), user.id, row.id)
    }
    if (patch.setDefault) {
      q.clearDefault.run(user.id)
      q.setDefault.run(user.id, row.id)
    }
    return status(user)
  }

  function unpair(user: User, deviceId?: number) {
    if (deviceId) {
      q.removeById.run(user.id, deviceId)
    } else {
      q.removeAll.run(user.id)
    }
    const remaining = q.devices.all(user.id) as PcDeviceRow[]
    if (remaining.length > 0 && !remaining.some((d) => d.is_default === 1)) {
      q.setDefault.run(user.id, remaining[0]!.id)
    }
    return { ok: true }
  }

  async function installerScript(user: User, deviceId?: number) {
    const row = resolveDevice(user.id, deviceId)
    const ts = await tailnet.status(user)
    const vpsIp = ts.self?.tailscaleIPs?.[0]
    if (!vpsIp || !isTailscaleIp(vpsIp)) {
      throw new AppError(409, 'tailnet_offline', 'Connect your DevDash Tailscale node in Network before downloading the installer.')
    }
    const token = unseal(masterKey, row.token_sealed, `pc:${user.id}`).toString('utf8')
    const slug = row.name.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const params = {
      pcName: row.name,
      tailscaleIp: row.tailscale_ip,
      vpsTailscaleIp: vpsIp,
      port: row.port,
      token,
      allowShell: row.allow_shell === 1,
    }
    if (row.platform === 'android') {
      return {
        filename: `install-devdash-android-${slug}.sh`,
        script: renderAndroidInstallerScript(params),
      }
    }
    return {
      filename: `install-devdash-pc-${slug}.ps1`,
      script: renderWindowsInstallerScript(params),
    }
  }

  async function executeTool(
    user: User,
    tool: string,
    args: Record<string, unknown> = {},
    source: 'ui' | 'mcp' = 'mcp',
  ): Promise<Record<string, unknown>> {
    if (tool === 'pc_list_devices') {
      const ts = await tailnet.status(user)
      const rows = q.devices.all(user.id) as PcDeviceRow[]
      return {
        ok: true,
        tailnetConnected: ts.running && ts.backendState === 'Running',
        devices: rows.map((r) => {
          const peer = ts.devices.find((d) => d.ip === r.tailscale_ip)
          return {
            id: r.id,
            name: r.name,
            platform: r.platform,
            tailscaleIp: r.tailscale_ip,
            port: r.port,
            enabled: r.enabled === 1,
            allowShell: r.allow_shell === 1,
            isDefault: r.is_default === 1,
            tailscaleOnline: peer?.online === true,
          }
        }),
      }
    }

    const { device: deviceSelector, deviceId, ...forwardArgs } = args
    const row = resolveDevice(user.id, (deviceId ?? deviceSelector) as string | number | undefined)
    if (row.enabled !== 1) {
      throw new AppError(403, 'pc_disabled', `${row.name} is paused in DevDash. Enable it in My Devices to resume.`)
    }
    if (tool === 'pc_run_powershell' && row.allow_shell !== 1) {
      throw new AppError(403, 'pc_shell_disabled', `Shell access is turned off for ${row.name} in My Devices settings.`)
    }

    const started = Date.now()
    const summary = summarizeAction(tool, forwardArgs)
    try {
      let result: Record<string, unknown>
      switch (tool) {
        case 'pc_status':
          result = await callAgent(user.username, row, 'GET', '/health', undefined, 10_000, true)
          break
        case 'pc_list_monitors':
          result = await callAgent(user.username, row, 'GET', '/v1/monitors', undefined, 10_000)
          break
        case 'pc_list_apps':
          result = await callAgent(user.username, row, 'GET', '/v1/apps', undefined, 15_000)
          break
        case 'pc_list_windows':
          result = await callAgent(user.username, row, 'GET', '/v1/windows', undefined, 15_000)
          break
        case 'pc_get_window_state':
          result = await callAgent(user.username, row, 'POST', '/v1/window_state', forwardArgs, 30_000)
          break
        case 'pc_screenshot':
          result = await callAgent(user.username, row, 'POST', '/v1/screenshot', forwardArgs, 25_000)
          break
        case 'pc_window_action':
          result = await callAgent(user.username, row, 'POST', '/v1/window_action', forwardArgs, 15_000)
          break
        case 'pc_launch_app':
          result = await callAgent(user.username, row, 'POST', '/v1/launch_app', forwardArgs, 15_000)
          break
        case 'pc_kill_app':
          result = await callAgent(user.username, row, 'POST', '/v1/kill_app', forwardArgs, 15_000)
          break
        case 'pc_click':
          result = await callAgent(user.username, row, 'POST', '/v1/click', forwardArgs, 15_000)
          break
        case 'pc_move_mouse':
          result = await callAgent(user.username, row, 'POST', '/v1/move_mouse', forwardArgs, 10_000)
          break
        case 'pc_drag':
          result = await callAgent(user.username, row, 'POST', '/v1/drag', forwardArgs, 20_000)
          break
        case 'pc_scroll':
          result = await callAgent(user.username, row, 'POST', '/v1/scroll', forwardArgs, 10_000)
          break
        case 'pc_type_text':
          result = await callAgent(user.username, row, 'POST', '/v1/type_text', forwardArgs, 25_000)
          break
        case 'pc_set_value':
          result = await callAgent(user.username, row, 'POST', '/v1/set_value', forwardArgs, 20_000)
          break
        case 'pc_press_key':
          result = await callAgent(user.username, row, 'POST', '/v1/press_key', forwardArgs, 15_000)
          break
        case 'pc_clipboard':
          result = await callAgent(user.username, row, 'POST', '/v1/clipboard', forwardArgs, 10_000)
          break
        case 'pc_run_powershell':
          result = await callAgent(user.username, row, 'POST', '/v1/powershell', forwardArgs, Math.min((Number(forwardArgs.timeoutSec) || 30) * 1000 + 10_000, 110_000))
          break
        case 'pc_fs':
          result = await callAgent(user.username, row, 'POST', '/v1/fs', forwardArgs, 20_000)
          break
        case 'pc_wait': {
          const ms = Math.min(Math.max(Number(forwardArgs.ms) || 1000, 100), 15_000)
          await delay(ms)
          result = forwardArgs.screenshot === true
            ? await callAgent(user.username, row, 'POST', '/v1/screenshot', { maxWidth: forwardArgs.maxWidth ?? 1280 }, 25_000)
            : { ok: true, waitedMs: ms }
          break
        }
        default:
          throw new AppError(400, 'unknown_tool', `Unknown device tool: ${tool}`)
      }
      q.addAudit.run(user.id, row.id, source, tool, summary, 1, Date.now() - started)
      q.pruneAudit.run(user.id, user.id)
      return result
    } catch (err) {
      q.addAudit.run(user.id, row.id, source, tool, `${summary} — ${err instanceof Error ? err.message : 'failed'}`.slice(0, 240), 0, Date.now() - started)
      q.pruneAudit.run(user.id, user.id)
      throw err
    }
  }

  async function installMcp(user: User, sourceIds?: string[]) {
    const providers = await mcpProviders(user.username)
    const targets = sourceIds?.length ? providers.filter((p) => sourceIds.includes(p.id)) : providers
    const cmd = `node ${pcMcpCommandPath()}`
    const results: { id: string; label: string; ok: boolean; error?: string }[] = []
    for (const p of targets) {
      try {
        await agents.request(user.username, {
          op: 'mcps.change',
          action: 'upsert',
          source: p.id,
          revision: p.revision,
          name: PC_MCP_NAME,
          transport: 'stdio',
          command: cmd,
          enabled: true,
        }, 15_000)
        results.push({ id: p.id, label: p.label, ok: true })
      } catch (err) {
        results.push({ id: p.id, label: p.label, ok: false, error: err instanceof Error ? err.message : 'Failed' })
      }
    }
    return { results, status: await status(user) }
  }

  function registerMcp() {
    agents.onRpc('mcp.pc_tool', async (username, params) => {
      const user = q.userByName.get(username) as User | undefined
      if (!user) throw new AppError(403, 'forbidden', 'Unknown member.')
      const p = (params ?? {}) as { tool?: unknown; args?: unknown }
      const tool = typeof p.tool === 'string' ? p.tool.trim() : ''
      const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? (p.args as Record<string, unknown>) : {}
      if (!tool) throw new AppError(400, 'bad_args', 'Missing device tool name.')
      return executeTool(user, tool, args, 'mcp')
    })
  }

  return { status, pair, updateSettings, unpair, installerScript, executeTool, installMcp, registerMcp }
}

export type PcService = ReturnType<typeof pcService>
