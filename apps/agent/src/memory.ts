// claude-mem (github.com/thedotmack/claude-mem) for one Claude profile. Off by default: a profile then has Claude
// Code's own memory (CLAUDE.md and auto memory) only. Switching it on installs the plugin into that profile like any
// other plugin; its worker and database belong to the Linux user (~/.claude-mem), shared by all their profiles.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PROFILE_RE, profileDir, profileEnv } from './claude.ts'
import { CLAUDE_BIN } from './sdk.ts'

const run = promisify(execFile)
const PLUGIN = 'claude-mem@thedotmack'
const MARKETPLACE = 'thedotmack'
const MARKETPLACE_SOURCE = 'thedotmack/claude-mem'
const BUN_PATHS = ['/usr/local/bin/bun', join(homedir(), '.bun', 'bin', 'bun')]

function readJson(path: string): Record<string, any> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** Where the profile's installed copy of the plugin lives, or null if it isn't installed. */
function pluginRoot(profile: string) {
  const root = readJson(join(profileDir(profile), 'plugins', 'installed_plugins.json')).plugins?.[PLUGIN]?.[0]?.installPath
  return typeof root === 'string' && existsSync(root) ? root : null
}

export function enabled(profile: string) {
  return readJson(join(profileDir(profile), 'settings.json')).enabledPlugins?.[PLUGIN] === true
}

/**
 * Settings DevDash needs on a shared server, written only where the member hasn't set their own:
 * - a worker port of its own (claude-mem's default, 37700 + uid % 100, collides for uids 100 apart),
 * - no Chroma: it would start a Python vector server on port 8000 for every member; SQLite search remains,
 * - for a non-default profile, the observer signs in with that profile's login.
 */
export function configure(profile: string) {
  const dir = join(homedir(), '.claude-mem')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'settings.json')
  const s = readJson(file)
  const defaults: Record<string, string> = {
    CLAUDE_MEM_WORKER_PORT: String(37000 + userInfo().uid),
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    ...(profile === 'default' ? {} : { CLAUDE_MEM_CLAUDE_CONFIG_DIR: profileDir(profile) }),
  }
  let changed = false
  for (const [k, v] of Object.entries(defaults)) {
    if (!s[k]) { s[k] = v; changed = true }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
}

const jobs = new Map<string, Promise<void>>()
/** One change per profile at a time: a double tap must not run two installs. */
export function set(profile: string, on: boolean) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const next = (jobs.get(profile) ?? Promise.resolve()).catch(() => {}).then(() => apply(profile, on))
  jobs.set(profile, next)
  void next.finally(() => { if (jobs.get(profile) === next) jobs.delete(profile) }).catch(() => {})
  return next
}

async function apply(profile: string, on: boolean) {
  const env = { ...process.env, ...profileEnv(profile) }
  const claude = async (...args: string[]) => {
    try {
      await run(CLAUDE_BIN, ['plugin', ...args], { env, timeout: 180_000 })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      const why = (e.stderr || e.message).trim().split('\n').filter(Boolean).pop() ?? 'unknown error'
      throw new Error(`claude plugin ${args[0]} failed: ${why.slice(0, 300)}`)
    }
  }
  if (!on) {
    if (enabled(profile)) await claude('disable', PLUGIN, '--scope', 'user')
    return
  }
  if (!BUN_PATHS.some((p) => existsSync(p))) {
    throw new Error('claude-mem needs Bun, which this server does not have yet. Ask an admin to redeploy DevDash (it installs Bun).')
  }
  configure(profile)
  if (pluginRoot(profile)) return void (await claude('enable', PLUGIN, '--scope', 'user'))
  if (!readJson(join(profileDir(profile), 'plugins', 'known_marketplaces.json'))[MARKETPLACE]) await claude('marketplace', 'add', MARKETPLACE_SOURCE)
  await claude('install', PLUGIN, '--scope', 'user')
  // claude-mem fetches its own dependencies in a Setup hook; do it now so the first session doesn't wait or fail.
  const root = pluginRoot(profile)
  if (root && existsSync(join(root, 'scripts', 'version-check.js'))) {
    await run(process.execPath, [join(root, 'scripts', 'version-check.js')], { env: { ...env, CLAUDE_PLUGIN_ROOT: root }, timeout: 180_000 }).catch(() => {})
  }
}

const workerPort = () => Number(readJson(join(homedir(), '.claude-mem', 'settings.json')).CLAUDE_MEM_WORKER_PORT) || 37700 + (userInfo().uid % 100)

async function getJson(port: number, path: string) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) })
  return (await r.json()) as Record<string, any>
}

/**
 * How claude-mem is doing for this member: which profiles use it and what their worker reports. The worker starts
 * with the first Claude session after it was switched on, so "on but not running" is normal until then.
 */
export async function health(profiles: string[]) {
  const on = profiles.filter(enabled)
  if (!on.length) return { on, state: 'off' as const }
  const port = workerPort()
  let h: Record<string, any>
  try {
    h = await getJson(port, '/api/health')
  } catch {
    return { on, state: 'stopped' as const }
  }
  const stats = await getJson(port, '/api/stats').catch(() => ({}) as Record<string, any>)
  const last = h.ai?.lastInteraction as { timestamp?: number; success?: boolean; error?: string } | null | undefined
  const problems = ((h.dependencies?.statuses ?? []) as { message?: string }[]).map((d) => String(d.message ?? '')).filter(Boolean)
  const error = last?.success === false ? String(last.error ?? 'failed') : h.status !== 'ok' ? `worker ${h.status}` : null
  return {
    on,
    state: error ? ('error' as const) : ('ok' as const),
    error,
    version: typeof h.version === 'string' ? h.version : null,
    uptime: typeof h.uptime === 'number' ? h.uptime : null,
    memories: typeof stats.database?.observations === 'number' ? (stats.database.observations as number) : null,
    lastSaved: last?.success && typeof last.timestamp === 'number' ? Math.floor(last.timestamp / 1000) : null,
    problems,
  }
}

/** Restarts the member's worker (it reads its settings and login again); with nothing running, starts it. */
export async function restart(profiles: string[]) {
  const profile = profiles.find(enabled)
  const root = profile && pluginRoot(profile)
  if (!profile || !root) throw new Error('claude-mem is not on for any of your profiles.')
  const env = { ...process.env, ...profileEnv(profile), CLAUDE_PLUGIN_ROOT: root }
  const scripts = join(root, 'scripts')
  await run(process.execPath, [join(scripts, 'bun-runner.js'), join(scripts, 'worker-service.cjs'), 'restart'], { env, cwd: homedir(), timeout: 60_000 })
}
