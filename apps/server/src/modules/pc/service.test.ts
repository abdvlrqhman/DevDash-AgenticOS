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
        return { httpStatus: 200, data: { ok: true, targetIp: msg.targetIp, path: msg.path } }
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
      self: { hostName: 'devdash-ken', tailscaleIPs: ['100.111.214.117'] },
      socksPort: 43000,
      httpPort: 43001,
      running: true,
      hasKey: true,
      connected: true,
      devices: [
        { name: 'DESKTOP-LGSA21G', dnsName: 'desktop-lgsa21g.ts.net', os: 'windows', ip: '100.67.118.37', online: true, lastSeen: null },
        { name: "Kensei's A36", dnsName: 'kenseis-a36.ts.net', os: 'android', ip: '100.93.73.0', online: true, lastSeen: null },
      ],
    }),
  } as unknown as TailnetService

  const pc = pcService({ db, agents, tailnet, masterKey })
  pc.registerMcp()
  return { db, user, pc, calls, getRpc: () => rpcHandler! }
}

describe('pcService (Windows PC + Android multi-device)', () => {
  it('pairs both a Windows PC and Android phone, generates platform installers, and routes MCP tools per device', async () => {
    const { user, pc, calls, getRpc } = setup()

    await assert.rejects(
      () => pc.pair(user, { name: 'Bad', tailscaleIp: '192.168.1.5' }),
      /Tailscale IPv4/,
    )

    const s1 = await pc.pair(user, { name: 'DESKTOP-LGSA21G', platform: 'windows', tailscaleIp: '100.67.118.37', allowShell: true })
    assert.equal(s1.devices.length, 1)
    assert.equal(s1.devices[0]?.platform, 'windows')

    const s2 = await pc.pair(user, { name: "Kensei's A36", platform: 'android', tailscaleIp: '100.93.73.0', allowShell: true })
    assert.equal(s2.devices.length, 2)
    const winDev = s2.devices.find((d) => d.platform === 'windows')!
    const andDev = s2.devices.find((d) => d.platform === 'android')!
    assert.equal(andDev.port, 47822)

    // Windows installer (.ps1) vs Android Termux installer (.sh)
    const winInst = await pc.installerScript(user, winDev.id)
    assert.match(winInst.filename, /\.ps1$/)
    assert.match(winInst.script, /New-NetFirewallRule/)

    const andInst = await pc.installerScript(user, andDev.id)
    assert.match(andInst.filename, /\.sh$/)
    assert.match(andInst.script, /100\.111\.214\.117/)
    assert.match(andInst.script, /pair-adb\.sh/)

    // MCP pc_list_devices shows both devices
    const listed = await getRpc()('ken', { tool: 'pc_list_devices', args: {} }) as { devices: unknown[] }
    assert.equal(listed.devices.length, 2)

    // Default targets Windows; device:"android" targets Android phone!
    const rWin = await getRpc()('ken', { tool: 'pc_list_windows', args: {} }) as Record<string, unknown>
    assert.equal(rWin.targetIp, '100.67.118.37')

    const rAnd = await getRpc()('ken', { tool: 'pc_screenshot', args: { device: 'android' } }) as Record<string, unknown>
    assert.equal(rAnd.targetIp, '100.93.73.0')

    // Per-device kill-switch blocks only Android while Windows stays active
    await pc.updateSettings(user, { deviceId: andDev.id, enabled: false })
    await assert.rejects(() => pc.executeTool(user, 'pc_screenshot', { device: 'android' }, 'mcp'), /paused in DevDash/)
    const rWinStillOk = await pc.executeTool(user, 'pc_screenshot', { device: 'windows' }, 'mcp')
    assert.equal(rWinStillOk.ok, true)

    // One-click MCP install registers my-pc in Codex
    const installed = await pc.installMcp(user)
    assert.equal(installed.results[0]?.ok, true)
    assert.ok(calls.some((c) => c.msg.op === 'mcps.change' && c.msg.name === 'my-pc'))
  })
})
