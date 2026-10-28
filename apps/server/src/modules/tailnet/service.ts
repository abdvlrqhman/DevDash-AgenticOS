import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { seal } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'

// Server half of per-user tailnets. The node itself runs in the member's agent
// (apps/agent/src/tailscale.ts); here we keep the sealed auth key and drive connect/disconnect, and ask the root
// helper to isolate the member's loopback proxy ports so no other local user can reach their tailnet.
type Row = {
  user_id: number; hostname: string; socks_port: number | null; http_port: number | null
  auth_key_sealed: string | null; connected: number; created_at: number; updated_at: number
}
type AgentDevice = { name: string; dnsName: string; os: string; ip: string | null; online: boolean; lastSeen: string | null }
type AgentStatus = {
  backendState: string; self: { hostName: string | null; tailscaleIPs: string[] }
  socksPort: number | null; httpPort: number | null; running: boolean; devices: AgentDevice[]
}

export function tailnetService({ db, agents, masterKey, runDir, rootHelper, isRole }: {
  db: Db; agents: AgentsService; masterKey: Buffer; runDir: string
  /** Tests: a stand-in for the root helper. */
  rootHelper?: (cmd: string, args: unknown) => Promise<{ ok: boolean; error?: string }>
  /** Whether a Claude session is a team role's (so net_* tools stay out of role sessions). Optional: Team may be off. */
  isRole?: (username: string, sessionId: string | null) => boolean
}) {
  const q = {
    get: db.prepare('select * from tailnet_nodes where user_id = ?'),
    upsert: db.prepare(`insert into tailnet_nodes (user_id, hostname, auth_key_sealed, connected, updated_at)
      values (?, ?, ?, 1, unixepoch())
      on conflict(user_id) do update set hostname = excluded.hostname, auth_key_sealed = excluded.auth_key_sealed, connected = 1, updated_at = unixepoch()`),
    setPorts: db.prepare('update tailnet_nodes set socks_port = ?, http_port = ?, updated_at = unixepoch() where user_id = ?'),
    setConnected: db.prepare('update tailnet_nodes set connected = ?, updated_at = unixepoch() where user_id = ?'),
    forgetKey: db.prepare('update tailnet_nodes set auth_key_sealed = null, connected = 0, updated_at = unixepoch() where user_id = ?'),
    user: db.prepare("select id, username, name, role from users where username = ? and disabled_at is null"),
  }
  const aad = (userId: number) => `tailnet:${userId}`

  // The root helper runs the iptables owner-match rules (deploy/helper: tailnet-isolate/unisolate). Only on a host;
  // on a dev box (no runDir) there is nothing to isolate and no agent either.
  const canHelper = !!runDir || !!rootHelper
  const helper = <T>(cmd: string, args: unknown, timeoutMs = 15_000) =>
    (rootHelper ? rootHelper(cmd, args) as Promise<{ ok: boolean; error?: string } & T>
      : requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd, args }, timeoutMs))

  const agentStatus = (username: string) =>
    agents.request<AgentStatus>(username, { op: 'tailscale.status' }, 20_000)
      .catch((): AgentStatus => ({ backendState: 'Stopped', self: { hostName: null, tailscaleIPs: [] }, socksPort: null, httpPort: null, running: false, devices: [] }))

  const publicStatus = (user: Pick<User, 'id'>, s: AgentStatus) => {
    const row = q.get.get(user.id) as Row | undefined
    return { ...s, hasKey: !!row?.auth_key_sealed, connected: row?.connected === 1 } // the key itself never leaves the server
  }

  /** Ask the helper to isolate (or release) the member's proxy ports. Best-effort: a failure is reported, not fatal. */
  async function isolate(username: string, ports: number[], on: boolean): Promise<string | null> {
    if (!canHelper || !ports.length) return canHelper ? null : 'Port isolation needs DevDash running on its Linux server; skipped here.'
    try {
      const r = await helper(on ? 'tailnet-isolate' : 'tailnet-unisolate', { username, ports })
      if (!r.ok) throw new Error(r.error || 'helper refused')
      return null
    } catch (err) {
      return `Could not ${on ? 'isolate' : 'release'} the proxy ports (${(err as Error).message}). Your tailnet may be reachable by other users on this server until an admin fixes it.`
    }
  }

  const api = {
    async status(user: Pick<User, 'id' | 'username'>) {
      return publicStatus(user, await agentStatus(user.username))
    },

    async connect(user: Pick<User, 'id' | 'username'>, authKey: string) {
      const key = authKey.trim()
      if (!key) throw new AppError(400, 'bad_key', 'Paste your Tailscale auth key.')
      // Seal the key before anything else, so a crash mid-connect still leaves it stored for a retry.
      q.upsert.run(user.id, `devdash-${user.username}`, seal(masterKey, Buffer.from(key), aad(user.id)))
      const s = await agents.request<AgentStatus>(user.username, { op: 'tailscale.up', authKey: key }, 60_000)
      const ports = [s.socksPort, s.httpPort].filter((p): p is number => typeof p === 'number')
      q.setPorts.run(s.socksPort, s.httpPort, user.id)
      const warning = await isolate(user.username, ports, true)
      return { ...publicStatus(user, s), warning }
    },

    /** Whether this member currently has a connected tailnet node (so a session may be routed through it). */
    isConnected(userId: number) {
      return (q.get.get(userId) as Row | undefined)?.connected === 1
    },

    async disconnect(user: Pick<User, 'id' | 'username'>, forgetKey = true) {
      const row = q.get.get(user.id) as Row | undefined
      const s = await agents.request<AgentStatus>(user.username, { op: 'tailscale.down' }, 30_000)
        .catch((): AgentStatus => ({ backendState: 'Stopped', self: { hostName: null, tailscaleIPs: [] }, socksPort: null, httpPort: null, running: false, devices: [] }))
      const ports = [row?.socks_port, row?.http_port].filter((p): p is number => typeof p === 'number')
      const warning = await isolate(user.username, ports, false)
      if (forgetKey) q.forgetKey.run(user.id)
      else q.setConnected.run(0, user.id)
      return { ...publicStatus(user, s), warning }
    },
  }

  // --- Claude tools (packages/claude-plugin/mcp/devdash.mjs): the caller's OWN tailnet only. Scoped to the member
  //     whose agent relayed the call; kept out of team role sessions. (A later phase wires a per-session proxy so a
  //     session can route through the tailnet — the ports are already in the status above; nothing to build here now.)
  const mcpUser = (username: string) => {
    const u = q.user.get(username) as Pick<User, 'id' | 'username'> | undefined
    if (!u) throw new AppError(403, 'forbidden', 'Unknown member.')
    return u
  }
  const sessionId = (params: unknown) => ((params ?? {}) as { sessionId?: string | null }).sessionId ?? null
  const args = (params: unknown) => ((params ?? {}) as { args?: Record<string, unknown> }).args ?? {}
  const available = (username: string, params: unknown) => !isRole?.(username, sessionId(params))

  agents.onRpc('mcp.net_here', (username, params) => ({ available: available(username, params) }))
  agents.onRpc('mcp.net_devices', async (username, params) => {
    if (!available(username, params)) throw new AppError(403, 'role', 'Network tools are only for your own sessions.')
    const s = await api.status(mcpUser(username))
    if (!s.running) return 'Your tailnet is not connected. Connect it on the Network page first.'
    return {
      backendState: s.backendState,
      self: s.self.hostName ? { name: s.self.hostName, ip: s.self.tailscaleIPs[0] ?? null } : null,
      devices: s.devices.map((d) => ({ name: d.name, dnsName: d.dnsName, os: d.os, ip: d.ip, online: d.online, lastSeen: d.lastSeen })),
    }
  })
  agents.onRpc('mcp.net_check', async (username, params) => {
    if (!available(username, params)) throw new AppError(403, 'role', 'Network tools are only for your own sessions.')
    const want = String(args(params).device ?? '').trim().toLowerCase()
    if (!want) throw new AppError(400, 'bad_args', 'Give the device name or host.')
    const s = await api.status(mcpUser(username))
    if (!s.running) return 'Your tailnet is not connected. Connect it on the Network page first.'
    const d = s.devices.find((x) => [x.name, x.dnsName, x.dnsName.split('.')[0], x.ip].some((f) => (f ?? '').toLowerCase() === want))
    if (!d) return `No device "${args(params).device}" on your tailnet. Known: ${s.devices.map((x) => x.name).join(', ') || 'none'}.`
    return { name: d.name, dnsName: d.dnsName, os: d.os, ip: d.ip, online: d.online, lastSeen: d.lastSeen, status: d.online ? 'online' : 'offline' }
  })

  return api
}

export type TailnetService = ReturnType<typeof tailnetService>
