import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { svcTmux } from './tmux.ts'

// Services run in their own tmux server (separate from terminals), one session per service: svc-<name>.
// remain-on-exit keeps a crashed service's last output on screen for its logs.
export const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
const session = (name: string) => `svc-${name}`
const target = (name: string) => `=${session(name)}:`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function check(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('invalid service name')
  return name
}

/** Resolves ~ and relative paths for this member and checks the folder exists. */
export async function dir(path: unknown) {
  if (typeof path !== 'string' || !path) throw new Error('Choose a folder.')
  const p = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : isAbsolute(path) ? resolve(path) : resolve(homedir(), path)
  const s = await stat(p).catch(() => null)
  if (!s?.isDirectory()) throw new Error(`${path} is not a folder you can use.`)
  return p
}

async function exists(name: string) {
  return svcTmux('has-session', '-t', `=${session(name)}`).then(() => true, () => false)
}

/** Starts (or restarts in place) one service. Its command runs in bash with PORT set; compose projects get their own name. */
export async function start(r: Record<string, unknown>) {
  const name = check(r.name)
  const cwd = await dir(r.cwd)
  const port = Number(r.port)
  if (typeof r.command !== 'string' || !r.command.trim()) throw new Error('missing command')
  if (!Number.isInteger(port) || port < 20000 || port > 20999) throw new Error('invalid port')
  const extra = Array.isArray(r.env) ? (r.env as [string, string][]).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== 'PORT') : []
  // Where people open it: apps that need a base path (Vite --base, Next basePath) can use DEVDASH_BASE_PATH.
  const where = typeof r.url === 'string' && typeof r.basePath === 'string' ? ['-e', `DEVDASH_URL=${r.url}`, '-e', `DEVDASH_BASE_PATH=${r.basePath}`] : []
  const env = [...extra.flatMap(([k, v]) => ['-e', `${k}=${v}`]), '-e', `PORT=${port}`, '-e', `COMPOSE_PROJECT_NAME=dd-${name}`, '-e', `DEVDASH_SERVICE=${name}`, ...where]
  const run = ['respawn-pane', '-k', '-t', target(name), '-c', cwd, ...env, 'bash', '-lc', r.command]
  if (await exists(name)) return void (await svcTmux(...run))
  // Create the session with a placeholder, keep panes after exit, then swap in the real command (no race with fast exits).
  await svcTmux('new-session', '-d', '-s', session(name), '-x', '200', '-y', '50', '-c', cwd, ...env, 'sleep 30',
    ';', 'set-option', '-w', '-t', target(name), 'remain-on-exit', 'on', ';', ...run)
}

/** Ctrl+C first (lets servers and docker compose shut down cleanly), then the session goes. */
export async function stop(r: Record<string, unknown>) {
  const name = check(r.name)
  if (!(await exists(name))) return
  await svcTmux('send-keys', '-t', target(name), 'C-c').catch(() => {})
  for (let i = 0; i < 100; i++) {
    const live = (await status())[name]
    if (!live || live.dead) break
    await sleep(100)
  }
  await svcTmux('kill-session', '-t', `=${session(name)}`).catch(() => {})
}

export async function status() {
  const out: Record<string, { dead: boolean; code: number | null }> = {}
  try {
    const { stdout } = await svcTmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}\t#{pane_dead_status}')
    for (const line of stdout.trim().split('\n')) {
      const [s, dead, code] = line.split('\t')
      if (s?.startsWith('svc-')) out[s.slice(4)] = { dead: dead === '1', code: code ? Number(code) : null }
    }
  } catch {
    // no services running: no tmux server
  }
  return out
}

export async function logs(r: Record<string, unknown>) {
  const name = check(r.name)
  const n = Math.min(5000, Math.max(1, Number(r.lines) || 200))
  if (!(await exists(name))) return ''
  const { stdout } = await svcTmux('capture-pane', '-p', '-J', '-S', `-${n}`, '-t', target(name))
  return stdout.replace(/\n{3,}/g, '\n\n').trim() // the pane's empty rows aren't output
}

export const sessionName = (name: unknown) => session(check(name))
