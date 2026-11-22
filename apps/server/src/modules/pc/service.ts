import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Db } from '../../core/db.ts'
import { newToken, seal, unseal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { TailnetService } from '../tailnet/service.ts'
import { renderWindowsInstallerScript } from './windows-agent.ts'

export const DEFAULT_PC_PORT = 47821
export const PC_MCP_NAME = 'my-pc'

type PcDeviceRow = {
  id: number
  user_id: number
  name: string
  tailscale_ip: string
  port: number
  token_sealed: string
  enabled: number
  allow_shell: number
  created_at: number
  updated_at: number
  last_seen_at: number | null
}

type PcAuditRow = {
  id: number
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
    case 'pc_status': return 'Checked PC health'
    case 'pc_list_monitors': return 'Listed monitors'
    case 'pc_list_apps': return 'Listed running apps'
    case 'pc_list_windows': return 'Listed open windows'
    case 'pc_get_window_state': return args.hwnd ? `Inspected window ${args.hwnd}` : 'Inspected active window + UI tree'
    case 'pc_screenshot': return args.hwnd ? `Screenshot window ${args.hwnd}` : args.monitor !== undefined ? `Screenshot monitor ${args.monitor}` : 'Screenshot full screen'
    case 'pc_window_action': return `Window ${String(args.action ?? 'focus')} ${String(args.title ?? args.hwnd ?? '')}`.trim()
    case 'pc_launch_app': return `Launch ${String(args.target ?? '').slice(0, 80)}`
    case 'pc_kill_app': return `Kill ${String(args.name ?? args.pid ?? '')}`
    case 'pc_click': return args.elementId ? `Click element ${args.elementId}` : `Click (${args.x}, ${args.y}) ${String(args.button ?? 'left')}`
    case 'pc_move_mouse': return args.elementId ? `Move mouse to ${args.elementId}` : `Move mouse (${args.x}, ${args.y})`
    case 'pc_drag': return `Drag (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`
    case 'pc_scroll': return `Scroll dy=${args.deltaY ?? -3} dx=${args.deltaX ?? 0}`
    case 'pc_type_text': return `Typed ${String(args.text ?? '').length} chars${args.enter ? ' + Enter' : ''}`
    case 'pc_set_value': return `Set value on ${String(args.elementId ?? `(${args.x}, ${args.y})`)}`
    case 'pc_press_key': return `Key ${String(args.key ?? '')}`
    case 'pc_clipboard': return args.mode === 'set' ? `Set clipboard (${String(args.text ?? '').length} chars)` : 'Read clipboard'
    case 'pc_run_powershell': return `PowerShell: ${String(args.command ?? '').replace(/\s+/g, ' ').slice(0, 80)}`
    case 'pc_fs': return `FS ${String(args.mode ?? '')} ${String(args.path ?? '').slice(0, 80)}`
    case 'pc_wait': return `Wait ${Number(args.ms ?? 1000)}ms`
    default: return tool
  }
}

export function pcMcpCommandPath(): string {
  // Always prefer the stable /opt/devdash/current symlink in production so provider configs survive releases.
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
    device: db.prepare('select * from pc_devices where user_id = ?'),
    upsert: db.prepare(`
      insert into pc_devices (user_id, name, tailscale_ip, port, token_sealed, enabled, allow_shell, updated_at)
      values (?, ?, ?, ?, ?, 1, ?, unixepoch())
      on conflict(user_id) do update set
        name = excluded.name,
        tailscale_ip = excluded.tailscale_ip,
        port = excluded.port,
        token_sealed = excluded.token_sealed,
        enabled = 1,
        allow_shell = excluded.allow_shell,
        updated_at = unixepoch()
    `),
    updateSettings: db.prepare('update pc_devices set enabled = ?, allow_shell = ?, updated_at = unixepoch() where user_id = ?'),
    rotateToken: db.prepare('update pc_devices set token_sealed = ?, updated_at = unixepoch() where user_id = ?'),
    touchSeen: db.prepare('update pc_devices set last_seen_at = unixepoch() where id = ?'),
    remove: db.prepare('delete from pc_devices where user_id = ?'),
    addAudit: db.prepare('insert into pc_audit_log (user_id, device_id, source, action, summary, ok, duration_ms) values (?, ?, ?, ?, ?, ?, ?)'),
    pruneAudit: db.prepare('delete from pc_audit_log where user_id = ? and id not in (select id from pc_audit_log where user_id = ? order by id desc limit 200)'),
    recentAudit: db.prepare('select id, source, action, summary, ok, duration_ms, created_at from pc_audit_log where user_id = ? order by id desc limit 30'),
  }

  function requireDevice(userId: number): PcDeviceRow {
    const row = q.device.get(userId) as PcDeviceRow | undefined
    if (!row) throw new AppError(404, 'pc_not_paired', 'No PC is paired yet. Open My PC in DevDash to pair your Windows PC over Tailscale.')
    return row
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
      throw new AppError(403, 'pc_auth_failed', String(res.data?.error ?? 'PC agent rejected authentication. Re-run the installer on your PC.'))
    }
    if (res.httpStatus >= 400) {
      throw new AppError(400, 'pc_action_failed', String(res.data?.error ?? `PC agent returned HTTP ${res.httpStatus}`))
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
    const row = q.device.get(user.id) as PcDeviceRow | undefined
    const vpsIp = ts.self?.tailscaleIPs?.[0] ?? null
    const peer = row ? ts.devices.find((d) => d.ip === row.tailscale_ip) ?? null : null
    let agentHealth: Record<string, unknown> | null = null
    let agentError: string | null = null

    if (row && row.enabled === 1 && ts.running && ts.backendState === 'Running' && peer?.online) {
      try {
        agentHealth = await callAgent(user.username, row, 'GET', '/health', undefined, 5_000)
      } catch (err) {
        agentError = err instanceof Error ? err.message : 'PC agent is not responding.'
      }
    }

    const audit = (q.recentAudit.all(user.id) as PcAuditRow[]).map((a) => ({
      id: a.id,
      source: a.source,
      action: a.action,
      summary: a.summary,
      ok: a.ok === 1,
      durationMs: a.duration_ms,
      createdAt: a.created_at,
    }))

    return {
      tailnet: {
        connected: ts.running && ts.backendState === 'Running',
        backendState: ts.backendState,
        vpsIp,
        vpsName: ts.self?.hostName ?? null,
        devices: ts.devices,
      },
      device: row
        ? {
            id: row.id,
            name: row.name,
            tailscaleIp: row.tailscale_ip,
            port: row.port,
            enabled: row.enabled === 1,
            allowShell: row.allow_shell === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastSeenAt: row.last_seen_at,
          }
        : null,
      peer: peer
        ? { name: peer.name, os: peer.os, ip: peer.ip, online: peer.online, lastSeen: peer.lastSeen }
        : null,
      agent: agentHealth,
      agentError,
      mcpProviders: providers.map(({ id, label, installed, enabled }) => ({ id, label, installed, enabled })),
      audit,
    }
  }

  async function pair(
    user: User,
    input: { name: string; tailscaleIp: string; port?: number; allowShell?: boolean },
  ) {
    const name = input.name.trim().slice(0, 80)
    const ip = input.tailscaleIp.trim()
    const port = input.port ?? DEFAULT_PC_PORT
    const allowShell = input.allowShell !== false
    if (!name) throw new AppError(400, 'bad_args', 'Enter a name for your PC.')
    if (!isTailscaleIp(ip)) throw new AppError(400, 'bad_args', 'Choose a valid Tailscale IPv4 address (100.64.0.0/10).')
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AppError(400, 'bad_args', 'Port must be between 1024 and 65535.')

    const token = newToken()
    const sealed = seal(masterKey, Buffer.from(token, 'utf8'), `pc:${user.id}`)
    q.upsert.run(user.id, name, ip, port, sealed, allowShell ? 1 : 0)
    return status(user)
  }

  async function updateSettings(
    user: User,
    patch: { enabled?: boolean; allowShell?: boolean; rotateToken?: boolean },
  ) {
    const row = requireDevice(user.id)
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled
    const allowShell = patch.allowShell !== undefined ? (patch.allowShell ? 1 : 0) : row.allow_shell
    q.updateSettings.run(enabled, allowShell, user.id)
    if (patch.rotateToken) {
      q.rotateToken.run(seal(masterKey, Buffer.from(newToken(), 'utf8'), `pc:${user.id}`), user.id)
    }
    return status(user)
  }

  function unpair(user: User) {
    q.remove.run(user.id)
    return { ok: true }
  }

  async function installerScript(user: User) {
    const row = requireDevice(user.id)
    const ts = await tailnet.status(user)
    const vpsIp = ts.self?.tailscaleIPs?.[0]
    if (!vpsIp || !isTailscaleIp(vpsIp)) {
      throw new AppError(409, 'tailnet_offline', 'Connect your DevDash Tailscale node in Network before downloading the Windows installer.')
    }
    const token = unseal(masterKey, row.token_sealed, `pc:${user.id}`).toString('utf8')
    return {
      filename: `install-devdash-pc-${row.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.ps1`,
      script: renderWindowsInstallerScript({
        pcName: row.name,
        tailscaleIp: row.tailscale_ip,
        vpsTailscaleIp: vpsIp,
        port: row.port,
        token,
        allowShell: row.allow_shell === 1,
      }),
    }
  }

  async function executeTool(
    user: User,
    tool: string,
    args: Record<string, unknown> = {},
    source: 'ui' | 'mcp' = 'mcp',
  ): Promise<Record<string, unknown>> {
    const row = requireDevice(user.id)
    if (row.enabled !== 1) {
      throw new AppError(403, 'pc_disabled', 'PC Computer Use is paused in DevDash. Enable it in My PC to resume.')
    }
    if (tool === 'pc_run_powershell' && row.allow_shell !== 1) {
      throw new AppError(403, 'pc_shell_disabled', 'PowerShell execution is turned off in My PC settings.')
    }

    const started = Date.now()
    const summary = summarizeAction(tool, args)
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
          result = await callAgent(user.username, row, 'POST', '/v1/window_state', args, 30_000)
          break
        case 'pc_screenshot':
          result = await callAgent(user.username, row, 'POST', '/v1/screenshot', args, 25_000)
          break
        case 'pc_window_action':
          result = await callAgent(user.username, row, 'POST', '/v1/window_action', args, 15_000)
          break
        case 'pc_launch_app':
          result = await callAgent(user.username, row, 'POST', '/v1/launch_app', args, 15_000)
          break
        case 'pc_kill_app':
          result = await callAgent(user.username, row, 'POST', '/v1/kill_app', args, 15_000)
          break
        case 'pc_click':
          result = await callAgent(user.username, row, 'POST', '/v1/click', args, 15_000)
          break
        case 'pc_move_mouse':
          result = await callAgent(user.username, row, 'POST', '/v1/move_mouse', args, 10_000)
          break
        case 'pc_drag':
          result = await callAgent(user.username, row, 'POST', '/v1/drag', args, 20_000)
          break
        case 'pc_scroll':
          result = await callAgent(user.username, row, 'POST', '/v1/scroll', args, 10_000)
          break
        case 'pc_type_text':
          result = await callAgent(user.username, row, 'POST', '/v1/type_text', args, 25_000)
          break
        case 'pc_set_value':
          result = await callAgent(user.username, row, 'POST', '/v1/set_value', args, 20_000)
          break
        case 'pc_press_key':
          result = await callAgent(user.username, row, 'POST', '/v1/press_key', args, 15_000)
          break
        case 'pc_clipboard':
          result = await callAgent(user.username, row, 'POST', '/v1/clipboard', args, 10_000)
          break
        case 'pc_run_powershell':
          result = await callAgent(user.username, row, 'POST', '/v1/powershell', args, Math.min((Number(args.timeoutSec) || 30) * 1000 + 10_000, 110_000))
          break
        case 'pc_fs':
          result = await callAgent(user.username, row, 'POST', '/v1/fs', args, 20_000)
          break
        case 'pc_wait': {
          const ms = Math.min(Math.max(Number(args.ms) || 1000, 100), 15_000)
          await delay(ms)
          result = args.screenshot === true
            ? await callAgent(user.username, row, 'POST', '/v1/screenshot', { maxWidth: args.maxWidth ?? 1280 }, 25_000)
            : { ok: true, waitedMs: ms }
          break
        }
        default:
          throw new AppError(400, 'unknown_tool', `Unknown PC tool: ${tool}`)
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
      if (!tool) throw new AppError(400, 'bad_args', 'Missing PC tool name.')
      return executeTool(user, tool, args, 'mcp')
    })
  }

  return { status, pair, updateSettings, unpair, installerScript, executeTool, installMcp, registerMcp }
}

export type PcService = ReturnType<typeof pcService>
