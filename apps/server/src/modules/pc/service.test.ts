import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../core/db.ts'
import { pcService } from './service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { TailnetService } from '../tailnet/service.ts'
import type { User } from '../auth/repo.ts'

function setup() {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'ken@example.com', 'ken', 'Ken', 'x', 'x', 'admin')").run()
  const user: User = { id: 1, username: 'ken', name: 'Ken', email: 'ken@example.com', role: 'admin' }
  const masterKey = randomBytes(32)
  const calls: { username: string; msg: Record<string, unknown> }[] = []
  let rpcHandler: ((username: string, params: unknown) => unknown) | undefined

  const agents = {
    request: async (username: string, msg: Record<string, unknown>) => {
      calls.push({ username, msg })
      if (msg.op === 'mcps.list') {
        return {
          sources: [{ id: 'codex', label: 'Codex', revision: 'r1', canToggle: true }],
          entries: [],
        }
      }
      if (msg.op === 'mcps.change') return { ok: true }
      if (msg.op === 'pc.request') {
        return { httpStatus: 200, data: { ok: true, hostname: 'DESKTOP-LGSA21G', path: msg.path } }
      }
      return { ok: true }
    },
    onRpc: (method: string, fn: (username: string, params: unknown) => unknown) => {
      if (method === 'mcp.pc_tool') rpcHandler = fn
    },
  } as unknown as AgentsService

  const tailnet = {
    status: async () => ({
      backendState: 'Running',
      self: { hostName: 'devdash-ken-1', tailscaleIPs: ['100.111.214.117'] },
      socksPort: 43000,
      httpPort: 43001,
      running: true,
      hasKey: true,
      connected: true,
      devices: [
        { name: 'desktop-lgsa21g', dnsName: 'desktop-lgsa21g.ts.net', os: 'windows', ip: '100.67.118.37', online: true, lastSeen: null },
      ],
    }),
  } as unknown as TailnetService

  const pc = pcService({ db, agents, tailnet, masterKey })
  pc.registerMcp()
  return { db, user, pc, calls, getRpc: () => rpcHandler! }
}

describe('pcService', () => {
  it('pairs a Tailscale PC, seals its token, generates a Tailscale-locked installer, and runs MCP tools', async () => {
    const { db, user, pc, calls, getRpc } = setup()

    await assert.rejects(
      () => pc.pair(user, { name: 'Bad', tailscaleIp: '192.168.1.5' }),
      /Tailscale IPv4/,
    )

    const paired = await pc.pair(user, { name: 'desktop-lgsa21g', tailscaleIp: '100.67.118.37', allowShell: true })
    assert.equal(paired.device?.name, 'desktop-lgsa21g')
    assert.equal(paired.device?.tailscaleIp, '100.67.118.37')
    assert.equal((paired.device as Record<string, unknown>).token_sealed, undefined)

    // Token is sealed in DB, not plaintext
    const dbRow = db.prepare('select token_sealed from pc_devices where user_id = 1').get() as { token_sealed: string }
    assert.ok(dbRow.token_sealed.length > 20)

    // Installer embeds VPS Tailscale IP + strict firewall rule
    const { script, filename } = await pc.installerScript(user)
    assert.match(filename, /install-devdash-pc-desktop-lgsa21g\.ps1/)
    assert.match(script, /100\.111\.214\.117/)
    assert.match(script, /New-NetFirewallRule/)

    // Execute MCP tool through registered RPC
    const res = await getRpc()('ken', { tool: 'pc_list_windows', args: {} }) as Record<string, unknown>
    assert.equal(res.ok, true)
    assert.equal(res.path, '/v1/windows')

    // Kill-switch blocks further actions immediately
    await pc.updateSettings(user, { enabled: false })
    await assert.rejects(() => pc.executeTool(user, 'pc_screenshot', {}, 'mcp'), /paused in DevDash/)

    // Re-enable but disable PowerShell
    await pc.updateSettings(user, { enabled: true, allowShell: false })
    await assert.rejects(() => pc.executeTool(user, 'pc_run_powershell', { command: 'whoami' }, 'mcp'), /PowerShell execution is turned off/)

    // One-click MCP install registers my-pc in Codex
    const installed = await pc.installMcp(user)
    assert.equal(installed.results[0]?.ok, true)
    const upsert = calls.find((c) => c.msg.op === 'mcps.change')
    assert.equal(upsert?.msg.name, 'my-pc')
    assert.match(String(upsert?.msg.command), /pc\.mjs$/)
  })
})
