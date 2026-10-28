import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDb } from '../../core/db.ts'
import { unseal } from '../../core/crypto.ts'
import type { AgentsService } from '../agents/service.ts'
import { tailnetService } from './service.ts'

const RUNNING = {
  backendState: 'Running', self: { hostName: 'devdash-yara', tailscaleIPs: ['100.64.0.1'] },
  socksPort: 41000, httpPort: 41001, running: true,
  devices: [
    { name: 'iphone', dnsName: 'iphone.tail1.ts.net', os: 'iOS', ip: '100.64.0.2', online: true, lastSeen: '2026-10-12T10:00:00Z' },
    { name: 'ida-box', dnsName: 'ida-box.tail1.ts.net', os: 'linux', ip: '100.64.0.3', online: false, lastSeen: '2026-10-11T09:00:00Z' },
  ],
}
const STOPPED = { backendState: 'Stopped', self: { hostName: null, tailscaleIPs: [] }, socksPort: null, httpPort: null, running: false, devices: [] }

function setup({ isRole }: { isRole?: (u: string, s: string | null) => boolean } = {}) {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'y@x.io', 'yara', 'Yara', 'x', 'x', 'admin')").run()
  const masterKey = randomBytes(32)
  const rpc: Record<string, (u: string, p: unknown) => unknown> = {}
  const agentCalls: { username: string; op: string }[] = []
  let agentReply = RUNNING
  const agents = {
    onRpc: (name: string, fn: (u: string, p: unknown) => unknown) => void (rpc[name] = fn),
    request: async (username: string, msg: Record<string, unknown>) => {
      agentCalls.push({ username, op: String(msg.op) })
      if (msg.op === 'tailscale.down') return STOPPED
      return agentReply
    },
  } as unknown as AgentsService
  const helperCalls: { cmd: string; args: unknown }[] = []
  const rootHelper = async (cmd: string, args: unknown) => {
    helperCalls.push({ cmd, args })
    return { ok: true }
  }
  const tailnet = tailnetService({ db, agents, masterKey, runDir: '', rootHelper, isRole })
  const user = { id: 1, username: 'yara' }
  return { db, tailnet, user, masterKey, rpc, agentCalls, helperCalls, setReply: (r: typeof RUNNING) => (agentReply = r) }
}

test('connect: seals the key, brings the node up, isolates the ports, never returns the key', async () => {
  const { db, tailnet, user, masterKey, agentCalls, helperCalls } = setup()
  const r = await tailnet.connect(user, '  tskey-auth-secret123  ') as Record<string, unknown>
  // agent asked to bring the node up (tailscale.up returns the fresh status, so no extra status call)
  assert.deepEqual(agentCalls.map((c) => c.op), ['tailscale.up'])
  // key stored sealed with AAD tailnet:<id>, decrypts back to the trimmed key
  const row = db.prepare('select auth_key_sealed, socks_port, http_port, connected from tailnet_nodes where user_id = 1').get() as { auth_key_sealed: string; socks_port: number; http_port: number; connected: number }
  assert.equal(unseal(masterKey, row.auth_key_sealed, 'tailnet:1').toString('utf8'), 'tskey-auth-secret123')
  assert.equal(row.socks_port, 41000)
  assert.equal(row.connected, 1)
  // isolation ran with the resolved ports
  assert.deepEqual(helperCalls, [{ cmd: 'tailnet-isolate', args: { username: 'yara', ports: [41000, 41001] } }])
  // the response has hasKey/connected but never the key itself
  assert.equal(r.hasKey, true)
  assert.equal(r.connected, true)
  assert.equal(r.warning, null)
  assert.ok(!JSON.stringify(r).includes('tskey-auth-secret123'))
})

test('connect: an empty key is rejected', async () => {
  const { tailnet, user } = setup()
  await assert.rejects(tailnet.connect(user, '   '), /Paste your Tailscale auth key/)
})

test('status: reports hasKey without leaking the key', async () => {
  const { tailnet, user } = setup()
  await tailnet.connect(user, 'tskey-auth-x')
  const s = await tailnet.status(user) as Record<string, unknown>
  assert.equal(s.hasKey, true)
  assert.equal(s.running, true)
  assert.equal((s.devices as unknown[]).length, 2)
  assert.ok(!JSON.stringify(s).includes('tskey-auth-x'))
})

test('disconnect: logs out, releases the ports, and forgets the key', async () => {
  const { db, tailnet, user, agentCalls, helperCalls } = setup()
  await tailnet.connect(user, 'tskey-auth-x')
  agentCalls.length = 0
  helperCalls.length = 0
  const r = await tailnet.disconnect(user) as Record<string, unknown>
  assert.ok(agentCalls.some((c) => c.op === 'tailscale.down'))
  assert.deepEqual(helperCalls, [{ cmd: 'tailnet-unisolate', args: { username: 'yara', ports: [41000, 41001] } }])
  const row = db.prepare('select auth_key_sealed, connected from tailnet_nodes where user_id = 1').get() as { auth_key_sealed: string | null; connected: number }
  assert.equal(row.auth_key_sealed, null)
  assert.equal(row.connected, 0)
  assert.equal(r.hasKey, false)
})

test('MCP net_devices / net_check: own tailnet only, gated out of role sessions', async () => {
  const { tailnet, user, rpc } = setup({ isRole: (_u, s) => s === 'role-session' })
  void tailnet
  // listed in a person's own session, hidden in a role session
  assert.deepEqual(rpc['mcp.net_here']!('yara', { sessionId: 'mine' }), { available: true })
  assert.deepEqual(rpc['mcp.net_here']!('yara', { sessionId: 'role-session' }), { available: false })

  const devices = await rpc['mcp.net_devices']!('yara', { sessionId: 'mine' }) as { devices: { name: string; online: boolean }[] }
  assert.deepEqual(devices.devices.map((d) => d.name), ['iphone', 'ida-box'])

  const check = await rpc['mcp.net_check']!('yara', { sessionId: 'mine', args: { device: 'iphone' } }) as { status: string; online: boolean }
  assert.equal(check.status, 'online')
  const byIp = await rpc['mcp.net_check']!('yara', { sessionId: 'mine', args: { device: '100.64.0.3' } }) as { status: string }
  assert.equal(byIp.status, 'offline')
  assert.match(await rpc['mcp.net_check']!('yara', { sessionId: 'mine', args: { device: 'nope' } }) as string, /No device/)

  await assert.rejects(async () => rpc['mcp.net_devices']!('yara', { sessionId: 'role-session' }), /only for your own sessions/)
})

test('MCP net_devices: tells the user to connect first when the node is down', async () => {
  const { tailnet, rpc, setReply } = setup()
  void tailnet
  setReply(STOPPED as unknown as typeof RUNNING)
  assert.match(await rpc['mcp.net_devices']!('yara', { sessionId: 'mine' }) as string, /not connected/)
})
