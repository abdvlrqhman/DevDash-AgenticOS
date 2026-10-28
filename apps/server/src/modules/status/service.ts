import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync, statfsSync, statSync } from 'node:fs'
import { cpus, loadavg, uptime } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Db } from '../../core/db.ts'
import { requestLine } from '../../core/unix.ts'
import type { AgentsService } from '../agents/service.ts'
import type { ServicesService } from '../services/service.ts'
import type { BrowserService } from '../browser/service.ts'
import { memoryHealth } from '../claude/service.ts'

const run = promisify(execFile)
const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return null } }

/** One look at the server's health: resources, versions, backups and the parts of DevDash that run on it. */
export function statusService({ db, agents, services, browser, runDir, dataDir, version }: {
  db: Db; agents: AgentsService; services: ServicesService; browser: BrowserService; runDir: string; dataDir: string; version: string
}) {
  const members = db.prepare('select username, name from users where disabled_at is null order by name')

  function memory() {
    const info = read('/proc/meminfo')
    const kb = (k: string) => Number(info?.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
    return info ? { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') } : null
  }
  function disk() {
    try {
      const s = statfsSync('/')
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
    } catch { return null }
  }
  function release() {
    try {
      const target = readlinkSync('/opt/devdash/current')
      return { id: target.split('/').pop() ?? target, since: Math.floor(statSync(target).mtimeMs / 1000) }
    } catch { return null }
  }
  // The version of the Claude Code binary DevDash runs (asked once per update, not on every page load).
  let claude: { at: number; version: string | null } = { at: 0, version: null }
  async function claudeVersion() {
    if (Date.now() - claude.at < 10 * 60_000) return claude.version
    const out = await run('/opt/devdash/claude/current/bin/claude', ['--version'], { timeout: 10_000 }).then((r) => r.stdout, () => '')
    claude = { at: Date.now(), version: out.match(/\d+\.\d+\.\d+/)?.[0] ?? null }
    return claude.version
  }

  // Claude Code comes from the Agent SDK package (deploy/claude-update.sh); the installed SDK version names its folder.
  const installedSdk = () => { try { return readlinkSync('/opt/devdash/claude/current').split('/').pop() ?? null } catch { return null } }
  let latest: { at: number; version: string | null } = { at: 0, version: null }
  async function latestSdk() {
    if (Date.now() - latest.at < 60 * 60_000) return latest.version
    const v = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest', { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json() as Promise<{ version?: string }>).then((j) => j.version ?? null, () => null)
    latest = { at: Date.now(), version: v ?? latest.version }
    return latest.version
  }
  const helper = <T>(cmd: string, timeoutMs = 15_000) => requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd }, timeoutMs)
    .then((r) => { if (!r.ok) throw new Error(r.error ?? `${cmd} failed`); return r })
  const askUpdating = () => helper<{ state: string; result: string }>('claude-update-status').then((r) => r.state === 'activating' || r.state === 'active', () => false)
  // Each helper call starts a root process: the Server page (polled every 15 s) reuses the answer for 30 s.
  let updatingSeen = { at: 0, value: false }
  async function updating() {
    if (watching) return true
    if (Date.now() - updatingSeen.at > 30_000) updatingSeen = { at: Date.now(), value: await askUpdating() }
    return updatingSeen.value
  }

  // After an update finishes: read the version again, and let agents restart onto the new SDK once no turn runs.
  let watching = false
  async function watchUpdate() {
    if (watching) return
    watching = true
    try {
      const started = Date.now()
      do {
        await new Promise((r) => setTimeout(r, 5000))
      } while ((await askUpdating()) && Date.now() - started < 20 * 60_000)
      claude = { at: 0, version: null }
      updatingSeen = { at: 0, value: false }
      await agents.upgradeAll((members.all() as { username: string }[]).map((m) => m.username))
    } finally {
      watching = false
    }
  }

  return {
    release,

    async get(admin: boolean) {
      const [agentStates, browserState] = await Promise.all([
        Promise.all((members.all() as { username: string; name: string }[]).map(async (m) => {
          const [ok, memory] = await Promise.all([
            agents.request(m.username, { op: 'terminals.list' }, 5000).then(() => true, () => false),
            memoryHealth(agents, m.username, 5000).catch(() => null),
          ])
          return { name: m.name, username: m.username, ok, memory }
        })),
        browser.status().catch(() => ({ running: false })),
      ])
      const svc = services.list({ id: 0, role: 'admin' })
      const backup = read(join(dataDir, 'backup-status.json'))
      return {
        host: { uptime: Math.floor(uptime()), load: loadavg(), cpus: cpus().length, memory: memory(), disk: disk() },
        software: {
          devdash: version, release: release(), claude: await claudeVersion(), node: process.versions.node,
          claudeSdk: { installed: installedSdk(), latest: await latestSdk(), updating: await updating() },
        },
        backup: backup ? JSON.parse(backup) as { at: number; ok: boolean; snapshot: string; bytes: number; offsite: boolean; note: string } : null,
        agents: agentStates,
        services: { total: svc.length, running: svc.filter((s) => s.state === 'running').length, crashed: svc.filter((s) => s.state === 'crashed').map((s) => s.name) },
        browser: browserState,
        canAct: admin,
      }
    },

    /** Admins: Claude Code to the latest version for everyone. Running sessions keep their version until they restart. */
    async updateClaude() {
      if (await askUpdating()) return
      await helper('claude-update')
      void watchUpdate().catch((err) => console.error('claude update:', err))
    },

    async backupNow() {
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), { cmd: 'backup-run' }, 30_000)
      if (!r.ok) throw new Error(r.error ?? 'Could not start the backup.')
    },
  }
}

export type StatusService = ReturnType<typeof statusService>
