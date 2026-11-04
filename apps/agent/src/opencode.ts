// OpenCode (opencode.ai, version 2), one of the coding agents harness.ts drives over ACP. Installed for everyone by
// deploy/opencode-update.sh. Everything DevDash needs it to do differently is set per session through
// OPENCODE_CONFIG_CONTENT, which outranks the member's own and the project's config (checked against 2.2.5), so nothing
// is written into anyone's files.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const OPENCODE_HOME = process.env.DEVDASH_OPENCODE_HOME ?? '/opt/devdash/opencode/current'
export const OPENCODE_BIN = join(OPENCODE_HOME, 'bin', 'opencode')
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/
/** DevDash's plugin for OpenCode's terminal app: it reports the CLI's status, as Claude Code's hooks do. */
export const PLUGIN_DIR = fileURLToPath(new URL('../../../packages/opencode-plugin', import.meta.url))

/**
 * A profile is its own OpenCode database: its provider logins and its sessions. Settings, agents and skills
 * (~/.config/opencode) are shared by the member's profiles.
 */
export const profileDir = (p: string) => join(homedir(), '.opencode-profiles', p)
export const profileEnv = (p: string): Record<string, string> => (p === 'default' ? {} : { OPENCODE_DB: join(profileDir(p), 'opencode.db') })

export function profileNames() {
  const root = join(homedir(), '.opencode-profiles')
  return ['default', ...(existsSync(root) ? readdirSync(root).filter((n) => PROFILE_RE.test(n) && n !== 'default') : [])]
}
export function createProfile(name: string) {
  if (!PROFILE_RE.test(name) || name === 'default') throw new Error('Profile names use lowercase letters, digits and dashes.')
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 })
}

/** Commands for OpenCode's own server, never the shared background one it starts by default (one per user, its own port). */
const STANDALONE = '--standalone'
const opencode = (profile: string, args: string[], timeout = 30_000) =>
  run(OPENCODE_BIN, [...args, STANDALONE], { env: { ...process.env, ...profileEnv(profile) }, timeout, cwd: homedir() }).then((r) => r.stdout)

export const installed = () => existsSync(OPENCODE_BIN)
export async function version() {
  if (!installed()) return null
  const out = await run(OPENCODE_BIN, ['--version'], { timeout: 10_000 }).then((r) => r.stdout, () => '')
  return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null
}

/** The providers a profile has signed in to (API keys, OAuth), by name. */
export async function providers(profile: string): Promise<string[]> {
  const out = await opencode(profile, ['auth', 'list', '--format', 'json']).catch(() => '[]')
  let list: unknown
  try {
    list = JSON.parse(out)
  } catch {
    return []
  }
  // [{ id, name, connections: [...] }] in 2.2.5: what has at least one connection (a key, an account, an env variable).
  const names = (Array.isArray(list) ? list : []).filter((e) => !Array.isArray((e as { connections?: unknown })?.connections) || (e as { connections: unknown[] }).connections.length > 0).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    return [o.name, o.provider, o.providerID, o.integration, o.id].find((v) => typeof v === 'string') as string | undefined
  })
  return [...new Set(names.filter((n): n is string => !!n))]
}

/** Every model the profile can use, as provider/model ids. */
export async function models(profile: string): Promise<string[]> {
  const out = await opencode(profile, ['models'], 45_000).catch(() => '')
  return out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
}

type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }
const rule = (action: string, effect: Rule['effect']): Rule => ({ action, resource: '*', effect })
/**
 * In the CLI nobody but the person at the terminal decides, so OpenCode asks as the session's permission mode would:
 * Bypass runs everything, Accept edits asks before commands, Ask (and Plan) before anything that changes something.
 * (The CLI is only for the owner and people with full access, so there is no guest gate to keep.)
 */
export function cliPermissions(mode: string): Rule[] {
  if (mode === 'bypassPermissions' || mode === 'dontAsk' || mode === 'auto') return [rule('*', 'allow')]
  if (mode === 'acceptEdits') return [rule('*', 'allow'), rule('shell', 'ask')]
  return [rule('*', 'ask'), ...['read', 'glob', 'grep', 'websearch', 'skill', 'question', 'subagent'].map((a) => rule(a, 'allow'))]
}

/**
 * The session's config. In Chat every tool asks, so DevDash decides each call (harness.ts): the session's permission
 * mode, and the guest gate in a teammate's turn; in the CLI, `cliMode` says how. DevDash's rules go in as instructions. MCP servers are named here rather than
 * passed over ACP, so the CLI gets them too, and their tools are called directly rather than through OpenCode's code
 * mode, where neither the step list nor the gate could see them.
 */
export function config(o: { rulesFile: string; mcp: Record<string, { type: 'local'; command: string[]; environment: Record<string, string> } | { type: 'remote'; url: string }>; cliMode?: string; noTools?: boolean }) {
  return {
    // noTools: a one-off answer (harness.ts complete), which may use nothing.
    permissions: o.noTools ? [rule('*', 'deny')] : o.cliMode ? cliPermissions(o.cliMode) : [rule('*', 'ask')],
    instructions: [o.rulesFile],
    update: 'disable', // the install is root's: deploy/opencode-update.sh updates it for everyone
    experimental: { todo: true }, // a to-do list, shown beside the conversation
    mcp: { servers: Object.fromEntries(Object.entries(o.mcp).map(([name, s]) => [name, { ...s, codemode: false }])) },
    // In Chat DevDash drives OpenCode and knows its status; in the CLI the plugin tells it.
    ...(o.cliMode ? { plugins: [PLUGIN_DIR] } : {}),
  }
}

/**
 * OpenCode's own commands, offered before a session has said which it has (it reports its list, the project's and the
 * member's custom commands included, once it starts). A prompt that starts with one runs it.
 */
export const COMMANDS = [
  { name: 'init', description: 'Guided AGENTS.md setup' },
  { name: 'review', description: 'Review changes, defaults to uncommitted', argumentHint: '[commit|branch|pr]' },
  { name: 'goal', description: 'Keep working until an objective is met', argumentHint: '<objective> | pause | resume | clear' },
  { name: 'compact', description: 'Compact the session' },
]

export const acpArgs = ['acp']
/** Its terminal app on the same session. */
export const cliArgs = (nativeId: string) => [STANDALONE, '--session', nativeId]
/**
 * Its own sign-in, in a terminal tab: `login` picks any provider; `acct` is the OpenCode account (its Console plans, a
 * code to enter on any device), `go` the OpenCode Go subscription's key. Every one works from a server's terminal, except
 * browser sign-ins that return to this machine (Sign in with ChatGPT): harness.ts finishSignIn takes their last step.
 */
export const SIGN_INS: Record<string, string | null> = { login: null, acct: 'opencode', go: 'opencode-go' }
export const loginArgs = (target: string | null) => ['auth', 'login', ...(target ? [target] : []), STANDALONE]
/** OpenCode's agents for DevDash's permission modes: Plan reads and plans, the rest build. */
export const modeFor = (permissionMode: string) => (permissionMode === 'plan' ? 'plan' : 'build')
