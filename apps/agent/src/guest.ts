import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// While a teammate's message is being handled in someone's session (a "guest turn"), Claude still runs as the owner: their
// Linux user, Claude account, GitHub login, Drive, Tailscale and home folder. This decides, for each tool call, whether it
// can go ahead or has to wait for the owner's approval.
//
// Commands run for teammates as they would for the owner: the team chose to rely on Claude's judgment about what belongs
// to the task (its rules for teammates' requests, in the system prompt). What waits is what can be seen to reach the
// owner's own things: their private files and credentials; their accounts (Drive, GitHub, Tailscale, connected apps)
// unless they shared them here, per session or as their default for the project; and the few changes that can't be taken
// back. A command line can hide what it does (a script, `npm test`), so this is a backstop for the obvious, not a wall.

const SRV = process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
/** Folders every member reaches with their own account anyway: the shared checkouts, the worktrees, the team's files. */
export const SHARED_ROOTS = [`${SRV}/projects`, `${SRV}/worktrees`, `${SRV}/files`]

/**
 * What an owner can let teammates' requests use without asking. drive: rclone on their DevDash Drive folder. tailnet: their
 * Tailscale devices (web requests, ssh, curl, tailnet MCPs). github: gh, and git talking to GitHub (push, pull, clone), as
 * them. apps: their other MCP servers and connectors.
 */
export const GUEST_CAPS = ['drive', 'tailnet', 'github', 'apps'] as const
export type GuestCap = (typeof GUEST_CAPS)[number]

/** Tools that use nothing of the owner's. A subagent's own tool calls come through this gate too. */
const HARMLESS = new Set(['TodoWrite', 'Task', 'Agent', 'WebSearch', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'])
/** File tools, and which of their inputs is a path. */
const PATHS: Record<string, string[]> = {
  Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'],
  NotebookRead: ['notebook_path'], NotebookEdit: ['notebook_path'], LS: ['path'], Glob: ['path'], Grep: ['path'],
}
/** Reading and stopping background commands: like the commands themselves. */
const SHELL_MORE = new Set(['BashOutput', 'KillShell', 'KillBash'])

/** Where a path really is, symlinks followed; for one that doesn't exist yet, inside its nearest existing folder. */
export function realPath(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.unshift(basename(cur))
      cur = parent
    }
  }
}

const inside = (p: string, roots: string[]) => {
  const r = realPath(p)
  return roots.some((root) => r === root || r.startsWith(`${root}/`))
}

/** The folder part of a glob before its first wildcard: `/home/x/**\/*.key` → `/home/x`, `../a/*.ts` → `../a`, `*.ts` → `.`. */
const globFolder = (pattern: string) => {
  const parts = pattern.split('/')
  const wild = parts.findIndex((s) => /[*?[{]/.test(s))
  const fixed = parts.slice(0, wild < 0 ? parts.length - 1 : wild)
  return fixed.join('/') || (pattern.startsWith('/') ? '/' : '.')
}

export type GuestContext = {
  /** The session's folder: relative paths, and file searches with no path, start there. */
  cwd: string
  /** The session reaches the owner's private network (its tools get the tailnet proxy). */
  tailnet: boolean
  roots?: string[]
  /** What the owner shared with teammates in this session. */
  caps?: readonly string[] | null
  /** The session's tailnet MCP servers, by name. */
  tailnetMcps?: string[]
  /** The owner's home folder (this process's). */
  home?: string
}

/** Whether a tool call may go ahead in a guest turn without the owner. */
export function guestMay(tool: string, input: Record<string, unknown>, o: GuestContext): boolean {
  const caps = new Set(o.caps ?? [])
  if (HARMLESS.has(tool)) return true
  // Through the owner's tailnet proxy a page fetch could reach their devices.
  if (tool === 'WebFetch') return !o.tailnet || caps.has('tailnet')
  if (tool.startsWith('mcp__')) return caps.has(tailnetTool(tool, o) ? 'tailnet' : 'apps')
  if (tool === 'Bash') return commandMay(String(input.command ?? ''), caps, o)
  if (SHELL_MORE.has(tool)) return true
  const keys = PATHS[tool]
  if (!keys) return false // anything unknown
  const roots = o.roots ?? SHARED_ROOTS
  const paths = keys.map((k) => input[k]).filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (!paths.length) paths.push(o.cwd)
  // A Glob pattern can climb out of its folder (`../../home/x/**`): where its fixed part lands counts too.
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    const from = isAbsolute(paths[0]!) ? paths[0]! : resolve(o.cwd, paths[0]!)
    const fixed = globFolder(input.pattern)
    paths.push(input.pattern.startsWith('~') ? '~' : isAbsolute(fixed) ? fixed : resolve(from, fixed))
  }
  // "~" is the owner's home, never shared.
  return paths.every((p) => !p.startsWith('~') && inside(isAbsolute(p) ? p : resolve(o.cwd, p), roots))
}

/** DevDash's network tools and the session's tailnet MCPs reach the owner's devices. */
const tailnetTool = (tool: string, o: GuestContext) =>
  tool.startsWith('mcp__plugin_devdash_devdash__net_')
  || (o.tailnetMcps ?? []).some((n) => tool.startsWith(`mcp__${n.replace(/[^a-zA-Z0-9_-]/g, '_')}__`))

/**
 * A command for a teammate: it runs unless the command line shows it reaching the owner's own things (see the top). Run
 * where the session lives: a session in the owner's home folder has their files at every relative path.
 */
export function commandMay(cmd: string, caps: Set<string>, o: GuestContext): boolean {
  if (!inside(o.cwd, o.roots ?? SHARED_ROOTS)) return false
  // What a commit message or a PR's title says isn't what the command does.
  const line = cmd.replace(/(\s(?:-m|--message|-t|--title|-b|--body)[\s=]+)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1""')
  if (privateRef(line, o.home ?? homedir())) return false
  for (const [cap, re] of ACCOUNTS) if (re.some((r) => r.test(line)) && !caps.has(cap)) return false
  return !DRASTIC.some((r) => r.test(line))
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The owner's home and credentials: `~`, $HOME, /home, /root, their sockets, the usual key and token files. */
function privateRef(line: string, home: string): boolean {
  return /(^|[\s'"=:(<>|;&])~(?=$|[\s/'"):;|&<>])/.test(line)
    || /\$\{?HOME\b/.test(line)
    || new RegExp(`(^|[^\\w.-])(${esc(home)}|/home|/root|/run/user)(?=$|[/\\s'":;|&)])`).test(line)
    || /\.ssh\b|\bid_(rsa|ed25519|ecdsa)\b|\.config\/(gh|rclone|gcloud)\b|rclone\.conf|\.git-credentials|\.netrc|\.aws\/|\.kube\/|\.docker\/config|\.credentials\.json|\.claude\.json|\/proc\/[^\s/]+\/environ|\b(GH|GITHUB)_TOKEN\b/.test(line)
}

/** The owner's accounts as a command line uses them, by what the owner can share. */
const ACCOUNTS: [GuestCap, RegExp[]][] = [
  ['drive', [/(^|[\s;&|(`'"/])rclone(\s|$)/]],
  ['github', [
    /(^|[\s;&|(`'"/])gh(\s|$)/,
    /(^|[\s;&|(`'"/])git(\s+-[^\s]+(\s+[^-\s][^\s]*)?)*\s+(push|pull|fetch|clone|ls-remote|submodule)\b/,
    /api\.github\.com/,
  ]],
  ['tailnet', [
    /(^|[\s;&|(`'"/])(ssh|scp|sftp|tailscale|tailnet-connect)(\s|$)/,
    /\brsync\b[^\n;&|]*\s([\w.-]+@)?[\w.-]+:/,
    /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\.ts\.net\b|\b(ALL_PROXY|all_proxy|DEVDASH_TAILNET_SOCKS)\b|socks5/,
  ]],
]

/** What can't be taken back, or hands out or changes the owner's accounts: always theirs to approve, shared or not. */
const DRASTIC = [
  /\bgh\s+(auth|secret|variable|ssh-key|gpg-key|config|extension|ext|alias|codespace)\b/,
  /\bgh\s+repo\s+(delete|archive|unarchive|rename|edit|deploy-key|transfer)\b/,
  /\bgh\s+api\b.*(-X\s*|--method[=\s]+)DELETE\b/i,
  /\bgit\s+push\b[^\n;&|]*\s(--force\b|--force-with-lease\b|-f\b|--mirror\b|--delete\b|-d\b|\+\S|:\S)/,
  /\brclone\s+(purge|delete|deletefile|rmdirs?|sync|config|dedupe|cleanup|backend)\b|\brclone\b[^\n;&|]*(--config\b|\s:[a-z]+[:,])/,
  /\btailscale\s+(up|down|login|logout|switch|set|serve|funnel|file|cert)\b/,
  /\bcrontab\b|\bsystemctl\s+--user\b|\bloginctl\b/,
]
