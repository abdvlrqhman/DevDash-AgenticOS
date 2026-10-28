import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { tsTmux } from './tmux.ts'

// One userspace Tailscale node for this member, isolated to them: it logs into THEIR Tailscale account and routes
// traffic through a local SOCKS5 proxy, so the shared server never joins anyone's tailnet.
// Rootless: `tailscaled --tun=userspace-networking` needs no TUN device and touches no host networking. The daemon
// runs in its own tmux server (apps/agent/src/tmux.ts) so it outlives agent restarts, and a shell loop respawns it
// if it ever dies.
const run = promisify(execFile)
const STATE_DIR = join(homedir(), '.local', 'share', 'devdash-tailscale')
const SOCKET = join(STATE_DIR, 'tailscaled.sock')
const STATE_FILE = join(STATE_DIR, 'ts.state')
const PORTS_FILE = join(STATE_DIR, 'ports.json')
const SESSION = 'tailscaled' // tmux session (on the devdash-ts server) running the respawn loop
const user = () => process.env.USER || 'user'
const hostname = () => `devdash-${user()}`

export type Ports = { socksPort: number; httpPort: number }
export type Device = { name: string; dnsName: string; os: string; ip: string | null; online: boolean; lastSeen: string | null }
export type Status = {
  backendState: string
  self: { hostName: string | null; tailscaleIPs: string[] }
  socksPort: number | null
  httpPort: number | null
  running: boolean
  devices: Device[]
}

/** Trims a `tailscale status --json` blob to what the app and Claude need. Pure, so it is unit-tested. */
export function trimStatus(raw: unknown, ports: Ports): Status {
  const r = (raw ?? {}) as { BackendState?: string; Self?: Record<string, unknown>; Peer?: Record<string, Record<string, unknown>> }
  const self = (r.Self ?? {}) as { HostName?: string; TailscaleIPs?: string[] }
  const peers = r.Peer ?? {}
  const devices: Device[] = Object.values(peers).map((p) => {
    const d = p as { HostName?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string }
    return {
      name: d.HostName ?? (d.DNSName ?? '').split('.')[0] ?? '',
      dnsName: (d.DNSName ?? '').replace(/\.$/, ''),
      os: d.OS ?? '',
      ip: d.TailscaleIPs?.[0] ?? null,
      online: d.Online === true,
      lastSeen: d.LastSeen ?? null,
    }
  }).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  return {
    backendState: r.BackendState ?? 'Unknown',
    self: { hostName: self.HostName ?? null, tailscaleIPs: self.TailscaleIPs ?? [] },
    socksPort: ports.socksPort,
    httpPort: ports.httpPort,
    running: true,
    devices,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const canListen = (port: number) => new Promise<boolean>((resolve) => {
  const s = createServer()
  s.once('error', () => resolve(false))
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
})

/**
 * Two stable loopback ports for this member's proxies, remembered in the state dir so status reports the same ones.
 * The base is derived from the uid (so members rarely collide), then nudged to the first free pair.
 */
async function ports(): Promise<Ports> {
  try {
    const saved = JSON.parse(await readFile(PORTS_FILE, 'utf8')) as Ports
    if (Number.isInteger(saved.socksPort) && Number.isInteger(saved.httpPort)) return saved
  } catch {
    // none chosen yet
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  let base = 41000 + ((uid % 2000) * 2)
  for (let i = 0; i < 2000; i++, base = 41000 + ((((base - 41000) / 2) + 1) % 2000) * 2) {
    if ((await canListen(base)) && (await canListen(base + 1))) break
  }
  const chosen = { socksPort: base, httpPort: base + 1 }
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(PORTS_FILE, JSON.stringify(chosen))
  return chosen
}

/** This member's chosen proxy ports, for routing a Claude session through the tailnet (apps/agent/src/claude.ts). */
export const getPorts = (): Promise<Ports> => ports()

const running = () => tsTmux('has-session', '-t', `=${SESSION}`).then(() => true, () => false)
const socketReady = () => stat(SOCKET).then((s) => s.isSocket(), () => false)

/** `tailscale` CLI against this node's private socket. */
const cli = (...args: string[]) => run('tailscale', ['--socket', SOCKET, ...args], { timeout: 30_000 })

/** Ensures the daemon is up (spawning it in tmux if needed) and returns the chosen ports. */
async function ensureDaemon(): Promise<Ports> {
  const p = await ports()
  if (await running()) return p
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  // A shell loop keeps tailscaled up without the agent: if it exits, wait a moment and start it again.
  const cmd = `while true; do tailscaled --tun=userspace-networking --state=${STATE_FILE} --socket=${SOCKET}`
    + ` --socks5-server=127.0.0.1:${p.socksPort} --outbound-http-proxy-listen=127.0.0.1:${p.httpPort}; sleep 2; done`
  await tsTmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', 'bash', '-lc', cmd)
  for (let i = 0; i < 50 && !(await socketReady()); i++) await sleep(200) // wait for the control socket
  return p
}

/**
 * Bring this member's node up with their auth key and log in. The key arrives already decrypted from the server;
 * it is passed to the CLI as an argument on this member's own box and is never logged.
 */
export async function up(r: Record<string, unknown>): Promise<Status> {
  const authKey = r.authKey
  if (typeof authKey !== 'string' || !authKey.trim()) throw new Error('missing auth key')
  await ensureDaemon()
  // The key goes through a 0600 file, not the command line: `ps` is world-readable, so an argv key would leak it to
  // other members on this shared box. We remove the file right after.
  const keyFile = join(STATE_DIR, 'authkey')
  await writeFile(keyFile, authKey, { mode: 0o600 })
  try {
    await cli('up', `--auth-key=file:${keyFile}`, `--hostname=${hostname()}`, '--accept-routes')
  } finally {
    await rm(keyFile, { force: true }).catch(() => {})
  }
  return status()
}

/** Reads status without ever spawning the daemon: a stopped node reports itself stopped. */
export async function status(): Promise<Status> {
  if (!(await running()) || !(await socketReady())) {
    const p = await ports().catch(() => ({ socksPort: null, httpPort: null }))
    return { backendState: 'Stopped', self: { hostName: null, tailscaleIPs: [] }, socksPort: p.socksPort, httpPort: p.httpPort, running: false, devices: [] }
  }
  const p = await ports()
  try {
    const { stdout } = await cli('status', '--json')
    return trimStatus(JSON.parse(stdout), p)
  } catch {
    // daemon up but not logged in / still starting: report that rather than a hard error
    return { backendState: 'Starting', self: { hostName: null, tailscaleIPs: [] }, socksPort: p.socksPort, httpPort: p.httpPort, running: true, devices: [] }
  }
}

/** Full disconnect for the Disconnect button: log out of the tailnet, then stop the daemon (and its respawn loop). */
export async function down(): Promise<Status> {
  if (await socketReady()) await cli('logout').catch(() => {})
  await tsTmux('kill-session', '-t', `=${SESSION}`).catch(() => {})
  return status()
}
