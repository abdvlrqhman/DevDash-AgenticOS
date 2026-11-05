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
  const helper = <T>(cmd: string, timeoutMs = 15_000) => requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd }, timeoutMs)
    .then((r) => { if (!r.ok) throw new Error(r.error ?? `${cmd} failed`); return r })

  /**
   * A coding agent installed for everyone in /opt/devdash/<name> (deploy/<name>-update.sh): the version it runs (asked
   * once per update, not on every page load), the installed and newest package versions, and its install/update job.
   */
  function agentInstall(o: { name: string; bin: string; pkg: string; afterUpdate?: () => Promise<unknown> }) {
    let running: { at: number; version: string | null } = { at: 0, version: null }
    let latest: { at: number; version: string | null } = { at: 0, version: null }
    async function version() {
      if (Date.now() - running.at < 10 * 60_000) return running.version
      const out = await run(o.bin, ['--version'], { timeout: 10_000 }).then((r) => r.stdout, () => '')
      running = { at: Date.now(), version: out.match(/\d+\.\d+\.\d+/)?.[0] ?? null }
      return running.version
    }
    // The installed package version names its folder.
    const installed = () => { try { return readlinkSync(`/opt/devdash/${o.name}/current`).split('/').pop() ?? null } catch { return null } }
    async function newest() {
      if (Date.now() - latest.at < 60 * 60_000) return latest.version
      const v = await fetch(`https://registry.npmjs.org/${o.pkg}/latest`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json() as Promise<{ version?: string }>).then((j) => j.version ?? null, () => null)
      latest = { at: Date.now(), version: v ?? latest.version }
      return latest.version
    }
    // The job's unit: running, or how the last run ended (a failed oneshot stays "failed" until the next run).
    const askStatus = () => helper<{ state: string; result: string }>(`${o.name}-update-status`).then(
      (r) => ({ running: r.state === 'activating' || r.state === 'active', failed: r.state === 'failed' }),
      () => ({ running: false, failed: false }),
    )
    const askUpdating = () => askStatus().then((s) => s.running)
    // Each helper call starts a root process: the Server page (polled every 15 s) reuses the answer for 30 s.
    let statusSeen = { at: 0, value: { running: false, failed: false } }
    let watching = false
    async function status() {
      if (watching) return { running: true, failed: false }
      if (Date.now() - statusSeen.at > 30_000) statusSeen = { at: Date.now(), value: await askStatus() }
      return statusSeen.value
    }
    // After an update finishes: read the version again, then whatever the agent needs (Claude: agents restart onto it).
    async function watch() {
      if (watching) return
      watching = true
      try {
        const started = Date.now()
        do {
          await new Promise((r) => setTimeout(r, 5000))
        } while ((await askUpdating()) && Date.now() - started < 20 * 60_000)
        running = { at: 0, version: null }
        statusSeen = { at: 0, value: { running: false, failed: false } }
        await o.afterUpdate?.()
      } finally {
        watching = false
      }
    }
    return {
      version,
      state: async () => {
        const s = await status()
        return { installed: installed(), latest: await newest(), updating: s.running, failed: s.failed }
      },
      async update() {
        if (await askUpdating()) return
        await helper(`${o.name}-update`)
        void watch().catch((err) => console.error(`${o.name} update:`, err))
      },
    }
  }
  // Claude Code comes from the Agent SDK package; agents restart onto a new one once no turn runs.
  const claude = agentInstall({
    name: 'claude', bin: '/opt/devdash/claude/current/bin/claude', pkg: '@anthropic-ai/claude-agent-sdk',
    afterUpdate: () => agents.upgradeAll((members.all() as { username: string }[]).map((m) => m.username)),
  })
  // OpenCode starts a new process per session, so a new version applies to the next session by itself.
  const opencode = agentInstall({ name: 'opencode', bin: '/opt/devdash/opencode/current/bin/opencode', pkg: '@opencode/cli' })

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
          devdash: version, release: release(), claude: await claude.version(), node: process.versions.node,
          claudeSdk: await claude.state(),
          opencode: { version: await opencode.version(), ...(await opencode.state()) },
        },
        backup: backup ? JSON.parse(backup) as { at: number; ok: boolean; snapshot: string; bytes: number; offsite: boolean; note: string } : null,
        agents: agentStates,
        services: { total: svc.length, running: svc.filter((s) => s.state === 'running').length, crashed: svc.filter((s) => s.state === 'crashed').map((s) => s.name) },
        browser: browserState,
        canAct: admin,
      }
    },

    /** Admins: Claude Code to the latest version for everyone. Running sessions keep their version until they restart. */
    updateClaude: () => claude.update(),
    /** Admins: install OpenCode, or update it to the latest version, for everyone. */
    updateOpencode: () => opencode.update(),

    async backupNow() {
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), { cmd: 'backup-run' }, 30_000)
      if (!r.ok) throw new Error(r.error ?? 'Could not start the backup.')
    },
  }
}

export type StatusService = ReturnType<typeof statusService>
