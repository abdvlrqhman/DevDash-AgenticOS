// Claude sessions for one member. Each session id runs in exactly one place at a time:
//   Chat mode: an Agent SDK query in this process (streaming input), events go to the server.
//   CLI mode:  the real `claude` TUI in tmux session c-<id>, status comes from the DevDash plugin's hooks.
// Switching mode stops one process and resumes the same id in the other (Claude Code has no lock of its own).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CLAUDE_BIN, loadSdk, type PermissionMode, type PermissionResult, type Query, type SDKUserMessage } from './sdk.ts'
import { hasSession, listSessions, tmux } from './tmux.ts'
import { getPorts } from './tailscale.ts'
import { startForwarder, writeSshHelper } from './tailnet-session.ts'
import * as storage from './storage.ts'

export const PLUGIN_DIR = fileURLToPath(new URL('../../../packages/claude-plugin', import.meta.url))
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// An idle Chat process (no turn, no question, no background task) is closed to free memory; the next message resumes it.
const IDLE_CLOSE_MS = 20 * 60_000 // ponytail: fixed; make per-member if RAM allows longer
const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Launch = {
  id: string
  cwd: string
  profile: string
  model?: string | null
  effort?: string | null
  permissionMode: PermissionMode
  /** false until the first message exists, so the first start uses sessionId instead of resume */
  started: boolean
  /** Fast mode (faster output on models that have it, billed as extra usage). */
  fast?: boolean
  /** Remote Control: the session also shows in claude.ai/code and the Claude app, under this title. */
  remote?: boolean
  title?: string
  /** Added to Claude's system prompt after DevDash's own rules (sessions other features start, e.g. a team role's). */
  instructions?: string | null
  /** Limits the session: `tools` = the built-in tools it has, `allow` = the tools that run without asking. */
  toolPolicy?: { tools?: string[]; allow?: string[] } | null
  /** Reach my tailnet: route the session's shell tools (ssh/curl/frida) through the owner's SOCKS/HTTP proxy. */
  reachTailnet?: boolean
  /** Tailnet MCPs (e.g. IDA Pro at http://100.x:13337/mcp) to expose to the session, each reached over the proxy. */
  tailnetMcps?: { name: string; url: string }[] | null
  /** The owner's connected cloud storage (their Google Drive), set up as an rclone remote before the session starts. */
  storage?: storage.Storage | null
}
export type Status = 'working' | 'waiting' | 'idle' | 'stopped' | 'error'
type Pending = { requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; resolve: (r: PermissionResult) => void }
/** `bg`: background shells, subagents and monitors still running; Claude picks their results up when they finish. */
/** `remote`: the claude.ai link while Remote Control is on. */
/** `tasks`: background shells, subagents and monitors still running (Claude picks up their results when they finish). */
type Task = { id: string; type: string; description: string }
type Chat = { launch: Launch; q: Query; inbox: Inbox; pending: Map<string, Pending>; status: Status; lastActive: number; bg: number; tasks: Task[]; remote: string | null; fresh: boolean; done?: Promise<void> }

let emit: (ev: Record<string, unknown>) => void = () => {}
export const setEmitter = (fn: typeof emit) => { emit = fn }

const chats = new Map<string, Chat>()

// Per-session tailnet routing. Each entry owns the local TCP→SOCKS forwarders (one per tailnet MCP) that must be torn
// down when the session's process ends. Keyed by session id; closing an old one before starting a new one is safe.
const tailnets = new Map<string, { close: () => void }>()
function teardownTailnet(id: string) {
  const t = tailnets.get(id)
  if (!t) return
  tailnets.delete(id)
  try { t.close() } catch { /* already gone */ }
}
type TailnetSetup = { env: Record<string, string>; mcpServers?: Record<string, unknown> }
/**
 * When "Reach my tailnet" is on: build the env that routes the session's shell tools through the owner's SOCKS/HTTP
 * proxy, write the ssh ProxyCommand helper onto its PATH, and — for each tailnet MCP — start a local forwarder and
 * point the MCP at it. Never sets HTTPS_PROXY: Claude's own Anthropic API calls (HTTPS) must stay direct, or the
 * SDK's traffic would tunnel through the proxy and break. Returns null when routing is off.
 */
async function setupTailnet(l: Launch): Promise<TailnetSetup | null> {
  if (!l.reachTailnet) { teardownTailnet(l.id); return null }
  const { socksPort, httpPort } = await getPorts()
  const binDir = join(homedir(), '.cache', 'devdash', 'tailnet', l.id)
  await writeSshHelper(binDir, socksPort)
  const env: Record<string, string> = {
    // Shell tools go through the tailnet proxy; NO HTTPS_PROXY on purpose (see this function's doc comment).
    ALL_PROXY: `socks5://127.0.0.1:${socksPort}`,
    all_proxy: `socks5://127.0.0.1:${socksPort}`,
    HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
    http_proxy: `http://127.0.0.1:${httpPort}`,
    DEVDASH_TAILNET_SOCKS: String(socksPort),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  }
  // The SDK/CLI HTTP MCP client can't reach a userspace 100.x address, so for each MCP forward a localhost port to it
  // over SOCKS and register it at the forwarded URL (original scheme/path kept, e.g. /mcp), under its own server name.
  const forwarders: { close: () => void }[] = []
  let mcpServers: Record<string, unknown> | undefined
  for (const mcp of l.tailnetMcps ?? []) {
    const u = new URL(mcp.url)
    const fwd = await startForwarder(socksPort, u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80))
    forwarders.push(fwd)
    const url = `${u.protocol}//127.0.0.1:${fwd.port}${u.pathname}${u.search}`
    mcpServers = { ...mcpServers, [mcp.name]: { type: 'http', url } }
  }
  teardownTailnet(l.id)
  tailnets.set(l.id, { close: () => { for (const f of forwarders) try { f.close() } catch { /* gone */ } } })
  return { env, mcpServers }
}

// Mode changes, sends and stops for one session run one at a time (a double tap must not start two processes).
const queues = new Map<string, Promise<unknown>>()
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
  queues.set(id, next)
  void next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => {})
  return next
}
const cliName = (id: string) => `c-${id}`
export const cliSession = cliName

/** The SDK's streaming input: messages are pushed as the member sends them. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(m: SDKUserMessage) {
    this.items.push(m)
    this.wake?.()
  }
  close() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = undefined
    }
  }
}

export const profileDir = (p: string) => (p === 'default' ? join(homedir(), '.claude') : join(homedir(), '.claude-profiles', p))
export const profileEnv = (p: string): Record<string, string> => (p === 'default' ? {} : { CLAUDE_CONFIG_DIR: profileDir(p) })

function validate(l: Launch) {
  if (!ID_RE.test(l.id)) throw new Error('invalid session id')
  if (!PROFILE_RE.test(l.profile)) throw new Error('invalid profile')
  if (!existsSync(l.cwd)) throw new Error(`Folder not found: ${l.cwd}`)
}

function setStatus(c: Chat | undefined, id: string, status: Status, detail?: string) {
  if (c) {
    if (c.status === status && !detail) return
    c.status = status
  }
  emit({ ev: 'claude.status', id, status, ...(detail ? { detail } : {}) })
}

// Added to Claude's system prompt in Chat and CLI: how to run things that must outlive a turn on a shared server.
const RULES = `You are running on a DevDash server that a team shares and that stays on 24/7.
New apps, sites and experiments each get their own folder under ~/projects/<short-name> (work in the current folder when it is already a project's own folder, which is the usual case). Never create a project directly in the home folder.
Long-running processes (web servers, dev servers, APIs, workers, containers) go in the DevDash services center, never in a foreground or background Bash command:
- \`devdash service add <name> --cmd '<command>'\` registers and starts one in the current folder and prints its port. The command must listen on $PORT, bound to 127.0.0.1. Never pick a port yourself; other people's services use the rest.
- Docker: \`docker run --rm -p 127.0.0.1:$PORT:<container-port> ...\`. Compose: publish "127.0.0.1:\${PORT}:<port>"; $COMPOSE_PROJECT_NAME keeps names apart.
- Before starting anything, run \`devdash service ls\` (everyone's services) and \`devdash service ports\` (every port in use on the server); reuse what's already running instead of starting a duplicate.
- \`devdash service logs <name>\`, \`restart <name>\`, \`stop <name>\`, \`rm <name>\`. Options for add: \`--env KEY=value\`, \`--no-autostart\`, \`--no-restart\`. Services keep running after this session ends, start with the server and restart if they crash.
- Each service opens in the browser at $DEVDASH_URL (members only, or anyone with the link if made public); \`devdash service add\` prints it. Apps that build absolute URLs should use the base path $DEVDASH_BASE_PATH (Vite: \`--base $DEVDASH_BASE_PATH\`).
- Services you add are linked to this session. Only stop or change services that belong to this person.
Be light on the shared machine — its disk and CPU are limited and used by everyone:
- Don't duplicate large things. When you work on a branch in a worktree, never re-download a big toolchain into it (node_modules, Android/Flutter SDKs, gradle/pub caches): reuse the project's main checkout — symlink it (\`ln -sfn <main-checkout>/node_modules node_modules\`) or point the tool at a shared cache (GRADLE_USER_HOME, ANDROID_SDK_ROOT, PUB_CACHE, npm cache) instead of a per-worktree copy.
- Clean up build outputs and scratch files you don't need; write throwaway files under /tmp, not into the repo. Worktrees are temporary — DevDash removes abandoned ones automatically once they're stale and their work is merged, so commit or merge anything you want to keep.
- Don't commit large binaries or build artifacts.
- The CPU is shared by the whole team and other services: don't fan out many heavy parallel subagents or run several big builds/test suites at once — do heavy work in sequence.
People read your replies in DevDash, where a file path you write opens that file. When you mention a file or folder, write its full path (from / or ~/), also when it's in a worktree or another checkout; never just its name.`

// Added only when "Reach my tailnet" is on: how the session reaches the owner's private devices.
const TAILNET_NOTE = `This session can reach the owner's private Tailscale tailnet. Their devices are at 100.x addresses (and *.ts.net MagicDNS names) and are reachable only through the proxy already set in your environment:
- List the devices and their online status with the net_devices tool; check one before connecting with net_check.
- ssh: use \`ssh -o ProxyCommand="tailnet-connect %h %p" user@100.x.x.x\` (the tailnet-connect helper is on your PATH).
- curl, frida (\`frida -H 100.x:port\`) and other tools honour the proxy env (ALL_PROXY / HTTP_PROXY) and reach 100.x directly.
Your own Anthropic API calls are NOT proxied; they go out directly as usual.`

const systemAppend = (l: Launch) => {
  const parts = [RULES, storage.note(l.storage, storage.driveFolder(l.cwd))]
  if (l.reachTailnet) parts.push(TAILNET_NOTE)
  if (l.instructions?.trim()) parts.push(l.instructions.trim())
  return parts.join('\n\n')
}

// Questions and plan approvals need a person in every mode. Bypass mode skips canUseTool entirely, so these two
// tools are routed through a PreToolUse hook instead, which always runs.
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode'])
const WEEK_S = 7 * 86_400

/** Makes sure the owner's Drive remote is in their rclone config before Claude starts (a new profile, a deleted file). */
const ensureStorage = (l: Launch) =>
  l.storage ? storage.configure(l.storage).catch((err: Error) => console.error(`[${l.id.slice(0, 8)}] storage:`, err.message)) : undefined

async function startChat(l: Launch): Promise<Chat> {
  validate(l)
  await requireLogin(l.profile)
  await ensureStorage(l)
  const sdk = await loadSdk()
  // Route this session through the owner's tailnet when asked (env + an optional MCP forwarder); off → null.
  const tn = await setupTailnet(l).catch((err: Error) => { console.error(`[${l.id.slice(0, 8)}] tailnet:`, err.message); return null })
  const inbox = new Inbox()
  const pending = new Map<string, Pending>()
  let chat: Chat | undefined
  const ask = (toolName: string, input: Record<string, unknown>, suggestions: unknown[] | undefined, signal: AbortSignal) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID()
      pending.set(requestId, { requestId, toolName, input, suggestions, resolve })
      setStatus(chat, l.id, 'waiting')
      emit({ ev: 'claude.permission', id: l.id, requestId, toolName, input, suggestions })
      signal.addEventListener('abort', () => {
        if (!pending.delete(requestId)) return
        emit({ ev: 'claude.permission_done', id: l.id, requestId })
        resolve({ behavior: 'deny', message: 'Cancelled' })
      })
    })
  const q = sdk.query({
    prompt: inbox,
    options: {
      cwd: l.cwd,
      env: { ...process.env, ...profileEnv(l.profile), DEVDASH_SESSION_ID: l.id, ...(tn?.env ?? {}) },
      ...(tn?.mcpServers ? { mcpServers: tn.mcpServers } : {}),
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      ...(l.started ? { resume: l.id } : { sessionId: l.id }),
      ...(l.model ? { model: l.model } : {}),
      ...(l.effort ? { effort: l.effort } : {}),
      // The SDK keeps fast mode off unless the session's flag settings ask for it.
      ...(l.fast ? { settings: { fastMode: true } } : {}),
      permissionMode: l.permissionMode,
      allowDangerouslySkipPermissions: l.permissionMode === 'bypassPermissions',
      // A complete Claude Code session: same system prompt, settings, skills, agents, hooks and MCP as the CLI.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(l) },
      ...(l.toolPolicy?.tools ? { tools: l.toolPolicy.tools } : {}),
      ...(l.toolPolicy?.allow ? { allowedTools: l.toolPolicy.allow } : {}),
      plugins: [{ type: 'local', path: PLUGIN_DIR }],
      includePartialMessages: true,
      canUseTool: async (toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; suggestions?: unknown[] }) =>
        INTERACTIVE.has(toolName) ? { behavior: 'allow', updatedInput: input } : ask(toolName, input, o.suggestions, o.signal),
      hooks: {
        PreToolUse: [{
          matcher: 'AskUserQuestion|ExitPlanMode',
          timeout: WEEK_S, // people answer from their phone, maybe much later
          hooks: [async (h: { tool_name: string; tool_input: Record<string, unknown> }, _id: string | undefined, o: { signal: AbortSignal }) => {
            const r = await ask(h.tool_name, h.tool_input, undefined, o.signal)
            return {
              hookSpecificOutput: r.behavior === 'allow'
                ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: r.updatedInput ?? h.tool_input }
                : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.message },
            }
          }],
        }],
      },
      stderr: (d: string) => console.error(`[${l.id.slice(0, 8)}] ${d.trimEnd()}`),
    },
  })
  chat = { launch: { ...l, started: true }, q, inbox, pending, status: 'idle', lastActive: Date.now(), bg: 0, tasks: [], remote: null, fresh: !l.started }
  chats.set(l.id, chat)
  chat.done = pump(chat)
  if (l.remote) void remoteControl(chat, true).catch((err: Error) => emit({ ev: 'claude.remote', id: l.id, url: null, error: err.message.slice(0, 300) }))
  return chat
}

const commandCache = new Map<string, unknown[]>()
const modelCache = new Map<string, unknown[]>()

async function pump(c: Chat) {
  const id = c.launch.id
  try {
    for await (const msg of c.q) {
      c.lastActive = Date.now()
      if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
        const s = msg.state
        setStatus(c, id, s === 'running' ? 'working' : s === 'requires_action' ? 'waiting' : 'idle')
      } else if (msg.type === 'result' && !c.pending.size) {
        setStatus(c, id, 'idle')
        refreshTitle(c.launch)
      } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        c.tasks = (msg.tasks as { task_id: string; task_type: string; description: string; subagent_type?: string; ambient?: boolean }[])
          .filter((t) => !t.ambient)
          .map((t) => ({ id: t.task_id, type: t.subagent_type ?? t.task_type, description: t.description }))
        c.bg = c.tasks.length
        emit({ ev: 'claude.tasks', id, tasks: c.tasks })
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        void c.q.supportedCommands().then((v) => commandCache.set(c.launch.profile, v), () => {})
        void c.q.supportedModels().then((v) => modelCache.set(c.launch.profile, v), () => {})
      }
      if (msg.type === 'result') reportContext(c)
      // A brand-new session's running cost starts at zero; a resumed one carries its total over (the server subtracts).
      // A reply says which folder Claude is in, when it has moved (cd, a worktree): its relative file paths are relative to it.
      const cwd = msg.type === 'assistant' && !msg.parent_tool_use_id ? currentFolder(c.launch) : null
      emit({ ev: 'claude.msg', id, msg: msg.type === 'result' ? { ...msg, devdash_fresh: c.fresh } : cwd && cwd !== c.launch.cwd ? { ...msg, cwd } : msg })
    }
    setStatus(c, id, 'idle')
  } catch (err) {
    setStatus(c, id, 'error', (err as Error).message.slice(0, 500))
  } finally {
    if (chats.get(id) === c) chats.delete(id)
    teardownTailnet(id) // the session process is gone: close its tailnet MCP forwarder
    // Clear any still-open question/permission on viewers' screens: the session is gone, nothing can answer it now.
    for (const p of c.pending.values()) {
      emit({ ev: 'claude.permission_done', id, requestId: p.requestId })
      p.resolve({ behavior: 'deny', message: 'Session closed' })
    }
    c.pending.clear()
    if (c.tasks.length) emit({ ev: 'claude.tasks', id, tasks: [] })
    emit({ ev: 'claude.closed', id })
  }
}

/** How full the context window is, as /context reports it; sent after every turn. */
function reportContext(c: Chat) {
  void c.q.getContextUsage({ detail: 'summary' }).then(
    (u) => emit({ ev: 'claude.context', id: c.launch.id, percent: u.percentage, tokens: u.totalTokens, max: u.maxTokens }),
    () => {},
  )
}

async function remoteControl(c: Chat, on: boolean) {
  if (!c.q.enableRemoteControl) throw new Error('This Claude Code version has no Remote Control. Update Claude Code from the Server page.')
  const r = await c.q.enableRemoteControl(on, on ? c.launch.title : undefined)
  c.remote = on ? (r?.session_url ?? 'https://claude.ai/code') : null
  c.launch = { ...c.launch, remote: on }
  emit({ ev: 'claude.remote', id: c.launch.id, url: c.remote })
}

/**
 * Remote Control on or off. In Chat it applies now (starting the process if needed, so the Claude app can reach the
 * session); in the CLI it applies the next time the CLI opens.
 */
export const remote = (l: Launch, on: boolean) => serial(l.id, async () => {
  if (await hasSession(cliName(l.id))) return { url: null, cli: true }
  let c = chats.get(l.id)
  if (!c) {
    if (!on) return { url: null }
    c = await startChat({ ...l, remote: false })
  }
  await remoteControl(c, on)
  return { url: c.remote }
})

async function stopChat(c: Chat) {
  c.inbox.close()
  c.q.close()
  await c.done
}

async function stopCli(id: string) {
  const name = cliName(id)
  if (!(await hasSession(name))) return teardownTailnet(id)
  await tmux('send-keys', '-t', `=${name}`, 'Escape').catch(() => {})
  await tmux('send-keys', '-t', `=${name}`, '/exit', 'Enter').catch(() => {})
  for (let i = 0; i < 40 && (await hasSession(name)); i++) await sleep(100)
  await tmux('kill-session', '-t', `=${name}`).catch(() => {})
  teardownTailnet(id) // the CLI process is gone: close its tailnet MCP forwarder
}

/** Sends a user message in Chat mode, starting or resuming the SDK process if needed. */
export const send = (l: Launch, content: unknown[], uuid: string) => serial(l.id, async () => {
  if (await hasSession(cliName(l.id))) throw new Error('This session is open in the CLI. Switch to Chat to send from here.')
  const c = chats.get(l.id) ?? (await startChat(l))
  c.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: l.id, uuid })
  c.lastActive = Date.now()
  setStatus(c, l.id, 'working')
})

export function answer(id: string, requestId: string, result: PermissionResult) {
  const c = chats.get(id)
  const p = c?.pending.get(requestId)
  if (!c || !p) throw new Error('This request is no longer waiting for an answer.')
  c.pending.delete(requestId)
  p.resolve(result)
  emit({ ev: 'claude.permission_done', id, requestId })
  setStatus(c, id, 'working')
}

export async function interrupt(id: string) {
  const c = chats.get(id)
  if (c) await c.q.interrupt()
  else if (await hasSession(cliName(id))) await tmux('send-keys', '-t', `=${cliName(id)}`, 'Escape')
}

/** Model, permission mode, effort and fast mode all apply live to a running Chat session (and to the next start otherwise). */
export async function setOption(id: string, key: 'model' | 'permissionMode' | 'effort' | 'fast', value: string | boolean | null) {
  const c = chats.get(id)
  if (!c) return
  if (key === 'model') await c.q.setModel((value as string | null) ?? undefined)
  else if (key === 'permissionMode') await c.q.setPermissionMode(value as PermissionMode)
  else if (key === 'fast') await c.q.applyFlagSettings({ fastMode: value === true })
  else await c.q.applyFlagSettings({ effortLevel: value })
  c.launch = { ...c.launch, [key]: value }
}

export const stop = (id: string) => serial(id, async () => {
  const c = chats.get(id)
  if (c) await stopChat(c)
  await stopCli(id)
})

/**
 * The folder a session works in counts as trusted: choosing it in DevDash is the person's answer to Claude Code's
 * "do you trust this folder?", whose default would quit the CLI. Written just before the CLI starts; if the config
 * can't be read cleanly it is left alone and Claude Code asks as usual.
 */
export function trustFolder(configFile: string, cwd: string) {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return
  }
  const projects = (config.projects ??= {}) as Record<string, Record<string, unknown>>
  if (projects[cwd]?.hasTrustDialogAccepted === true) return
  projects[cwd] = { ...projects[cwd], hasTrustDialogAccepted: true }
  const tmp = `${configFile}.devdash-${process.pid}`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(tmp, configFile)
}
const claudeConfig = (profile: string) => (profile === 'default' ? join(homedir(), '.claude.json') : join(profileDir(profile), '.claude.json'))

/** Opens CLI mode: the SDK process must be gone first, so only one process ever writes the transcript. */
export const openCli = (l: Launch, cols: number, rows: number) => serial(l.id, () => openCliNow(l, cols, rows))
async function openCliNow(l: Launch, cols: number, rows: number) {
  validate(l)
  const c = chats.get(l.id)
  if (c) await stopChat(c)
  if (await hasSession(cliName(l.id))) return
  cliLaunches.set(l.id, l)
  try { trustFolder(claudeConfig(l.profile), l.cwd) } catch { /* Claude Code asks instead */ }
  await ensureStorage(l)
  // Route this session through the owner's tailnet when asked (env + an optional MCP forwarder); off → null.
  const tn = await setupTailnet(l).catch((err: Error) => { console.error(`[${l.id.slice(0, 8)}] tailnet:`, err.message); return null })
  const args = [CLAUDE_BIN, ...(l.started ? ['--resume', l.id] : ['--session-id', l.id]), '--plugin-dir', PLUGIN_DIR, '--append-system-prompt', systemAppend(l)]
  if (l.toolPolicy?.tools?.length) args.push('--tools', l.toolPolicy.tools.join(','))
  if (l.toolPolicy?.allow?.length) args.push('--allowedTools', l.toolPolicy.allow.join(','))
  if (l.model) args.push('--model', l.model)
  if (l.effort) args.push('--effort', l.effort)
  if (l.fast) args.push('--settings', JSON.stringify({ fastMode: true }))
  if (l.remote) args.push('--remote-control')
  if (tn?.mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers: tn.mcpServers }))
  args.push(...(l.permissionMode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : ['--permission-mode', l.permissionMode]))
  // The classic renderer, not the full-screen one: the conversation flows into the terminal's history, so it scrolls
  // all the way back (phones included) and can be selected and copied in the browser.
  const env = Object.entries({ ...profileEnv(l.profile), DEVDASH_SESSION_ID: l.id, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', ...(tn?.env ?? {}) }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  try {
    await tmux('new-session', '-d', '-s', cliName(l.id), '-c', l.cwd, '-x', String(cols), '-y', String(rows), ...env, ...args)
  } catch (err) {
    if (!/duplicate session/.test((err as Error).message)) throw new Error('Could not start the Claude CLI. Try again in a moment.')
  }
  emit({ ev: 'claude.status', id: l.id, status: 'idle', mode: 'cli' })
}

/** Leaves CLI mode; the next Chat message resumes the session through the SDK. */
export const closeCli = (id: string) => serial(id, async () => {
  await stopCli(id)
  emit({ ev: 'claude.status', id, status: 'idle', mode: 'chat' })
})

export async function snapshot() {
  const cli = (await listSessions()).filter((s) => s.name.startsWith('c-')).map((s) => ({ id: s.name.slice(2), mode: 'cli' }))
  const chat = [...chats.values()].map((c) => ({
    id: c.launch.id, mode: 'chat', status: c.status, remote: c.remote, tasks: c.tasks,
    pending: [...c.pending.values()].map(({ resolve: _, ...p }) => p),
  }))
  return [...chat, ...cli]
}

export function pendingFor(id: string) {
  return [...(chats.get(id)?.pending.values() ?? [])].map(({ resolve: _, ...p }) => p)
}

// The SDK reads CLAUDE_CONFIG_DIR from the environment, so history reads for other profiles take turns.
let envLock: Promise<unknown> = Promise.resolve()
function withProfile<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  const next = envLock.then(async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    if (profile === 'default') delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = profileDir(profile)
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
  envLock = next.catch(() => {})
  return next
}

export type HistoryMessage = { type: string; uuid: string; parent_tool_use_id: string | null; message?: { content?: unknown } }
/** A raw transcript line as Claude Code writes it to the `.jsonl` (a superset of HistoryMessage). */
type TranscriptLine = {
  type?: string
  subtype?: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: { content?: unknown }
  isSidechain?: boolean
  isCompactSummary?: boolean
  timestamp?: string
  /** The folder Claude was in: it moves with `cd`, or into a worktree, so a relative path it wrote is relative to this. */
  cwd?: string
}

/** A message the person typed (not a tool result Claude Code sends back as a "user" message). */
function isPrompt(m: HistoryMessage) {
  if (m.type !== 'user' || m.parent_tool_use_id) return false
  const c = m.message?.content
  if (typeof c === 'string') return !!c.trim()
  return Array.isArray(c) && !c.some((b: { type?: string }) => b.type === 'tool_result') && c.some((b: { type?: string }) => b.type === 'text' || b.type === 'image' || b.type === 'document')
}

/** Which messages a page holds: from the `turns`-th last prompt before `before` (or the end) up to it. */
export function pageOf(all: HistoryMessage[], o: { before?: string; turns?: number }) {
  let end = all.length
  if (o.before) {
    const i = all.findIndex((m) => m.uuid === o.before)
    if (i >= 0) end = i
  }
  let start = 0
  if (o.turns && o.turns > 0) {
    let seen = 0
    for (let i = end - 1; i >= 0; i--) {
      if (isPrompt(all[i]!) && ++seen === o.turns) {
        start = i
        break
      }
    }
  }
  return { start, end }
}

/** A transcript line we can show as pre-compaction history: not subagent noise, not the compaction summary itself. */
function recoverable(m: TranscriptLine) {
  if (m.isSidechain === true || m.isCompactSummary === true) return false
  if (m.type === 'system') return m.subtype === 'compact_boundary' // the "Conversation compacted" note, kept; drop other system lines
  return (m.type === 'user' || m.type === 'assistant') && !!m.message
}

/**
 * The full chronological history: the SDK's active thread with the turns Claude Code dropped when it compacted
 * prepended. getSessionMessages returns only the live thread (the last compaction's summary onward), so once a session
 * has compacted the earlier turns vanish from it — but the `.jsonl` on disk still has every line. We take the active
 * thread as given, then prepend every earlier transcript line up to the first active message, deduped by uuid and with
 * subagent sidechains and the compaction summary left out, so scrolling up reaches the very first message. A session
 * that never compacted has its active thread start at the first line, so nothing is prepended and the result is
 * exactly what getSessionMessages gave.
 */
export function mergeHistory(active: HistoryMessage[], raw: TranscriptLine[]): HistoryMessage[] {
  const activeUuids = new Set(active.map((m) => m.uuid).filter(Boolean))
  const pos = new Map<string, number>()
  raw.forEach((m, i) => { if (m.uuid && !pos.has(m.uuid)) pos.set(m.uuid, i) })
  let first = Infinity
  for (const m of active) {
    const p = pos.get(m.uuid)
    if (p !== undefined && p < first) first = p
  }
  if (!Number.isFinite(first)) return active // the active thread isn't on disk (yet): leave it exactly as given
  const older: HistoryMessage[] = []
  const seen = new Set<string>()
  for (let i = 0; i < first; i++) {
    const m = raw[i]!
    if (!recoverable(m) || !m.uuid || activeUuids.has(m.uuid) || seen.has(m.uuid)) continue
    seen.add(m.uuid)
    older.push({ ...m, type: m.type!, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id ?? null } as HistoryMessage)
  }
  return [...older, ...active]
}

/**
 * The folder that holds a session's transcript: the escaped-cwd path Claude Code normally uses, or the shortened one
 * it falls back to for very long folder paths. Null when the session has no file yet. Its `<id>/subagents/` subfolder
 * holds the session's subagents, so finding subagents reuses exactly this resolution.
 */
function sessionDir(l: Launch): string | null {
  const root = join(profileDir(l.profile), 'projects')
  const escaped = join(root, l.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  if (existsSync(join(escaped, `${l.id}.jsonl`))) return escaped
  const dir = existsSync(root) ? readdirSync(root).find((d) => existsSync(join(root, d, `${l.id}.jsonl`))) : undefined
  return dir ? join(root, dir) : null
}

/**
 * The folder Claude is in right now, from the newest lines of its transcript: it moves with `cd`, or into a worktree,
 * and live messages don't say. Only the end of the file is read, so this is cheap enough for every reply.
 */
const transcriptFiles = new Map<string, string>()
function currentFolder(l: Launch): string | null {
  let file = transcriptFiles.get(l.id)
  if (!file) {
    const dir = sessionDir(l)
    if (!dir) return null
    file = join(dir, `${l.id}.jsonl`)
    transcriptFiles.set(l.id, file)
  }
  try {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, 256 * 1024))
      readSync(fd, buf, 0, buf.length, size - buf.length)
      const last = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1]
      return last ? (JSON.parse(`"${last}"`) as string) : null
    } finally {
      closeSync(fd)
    }
  } catch {
    transcriptFiles.delete(l.id)
    return null
  }
}

/**
 * One `.jsonl` transcript file, parsed into lines in the order Claude Code wrote them. Cached per file size: a growing
 * file is read again, a finished one once. A half-written last line is skipped.
 */
const transcriptCache = new Map<string, { size: number; lines: TranscriptLine[] }>()
function readLines(file: string): TranscriptLine[] {
  if (!existsSync(file)) return []
  const size = statSync(file).size
  const hit = transcriptCache.get(file)
  if (hit?.size === size) return hit.lines
  const lines: TranscriptLine[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      lines.push(JSON.parse(line) as TranscriptLine)
    } catch {
      // a line being written right now
    }
  }
  transcriptCache.set(file, { size, lines })
  return lines
}

/**
 * The session's transcript lines — the whole on-disk record, which is more than getSessionMessages returns once a
 * session has compacted.
 */
function transcriptLines(l: Launch) {
  const dir = sessionDir(l)
  return dir ? readLines(join(dir, `${l.id}.jsonl`)) : []
}

/**
 * A page of a session's history: the last `turns` prompts and everything after them, ending before message `before`
 * (the first message of the page already shown). Long sessions open fast and load older turns as you scroll up.
 */
export async function history(l: Launch, o: { before?: string; turns?: number } = {}) {
  if (!ID_RE.test(l.id) || !PROFILE_RE.test(l.profile)) throw new Error('invalid session')
  const sdk = await loadSdk()
  const active = (await withProfile(l.profile, () => sdk.getSessionMessages(l.id, { dir: l.cwd }))) as HistoryMessage[]
  let all = active
  const times = new Map<string, string>()
  const folders = new Map<string, string>()
  try {
    // The transcript on disk carries the pre-compaction turns the SDK drops, and the timestamps and folders it leaves out.
    const lines = transcriptLines(l)
    all = mergeHistory(active, lines)
    for (const e of lines) {
      if (e.uuid && e.timestamp) times.set(e.uuid, e.timestamp)
      if (e.uuid && e.cwd && e.cwd !== l.cwd) folders.set(e.uuid, e.cwd) // only where Claude had moved: most messages don't need it
    }
  } catch {
    // an unreadable transcript shouldn't lose the active thread
  }
  const { start, end } = pageOf(all, o)
  const messages = all.slice(start, end).map((m) => {
    const timestamp = times.get(m.uuid)
    const cwd = folders.get(m.uuid)
    return timestamp || cwd ? { ...m, ...(timestamp ? { timestamp } : {}), ...(cwd ? { cwd } : {}) } : m
  })
  return { messages, more: start > 0 }
}

/** A subagent's meta file (`<id>/subagents/agent-<agentId>.meta.json`): what links it to its parent Task tool call. */
export type SubagentMeta = { agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number }

/**
 * The agentId of the subagent spawned by a given Task `tool_use`: the meta file whose `toolUseId` matches. Pure, so it
 * is unit-tested. Returns null when no subagent has that toolUseId (it hasn't been written yet, or isn't ours).
 */
export function subagentIdFor(metas: { agentId: string; meta: SubagentMeta }[], toolUseId: string): string | null {
  return metas.find((m) => m.meta.toolUseId === toolUseId)?.agentId ?? null
}

// A subagent's transcript is bounded, but can be long; keep the most recent messages so the payload stays sane.
const SUBAGENT_CAP = 2000
/**
 * A subagent's transcript lines shaped exactly like `history()` returns, so the web renders them with the same
 * pipeline: only the user/assistant messages (Claude Code's `attachment` and other bookkeeping lines dropped), each
 * with `parent_tool_use_id` null (the subagent's own thread is the top level here) and its timestamp kept. The leading
 * task prompt stays in; the web decides whether to show it. Pure, so it is unit-tested.
 */
export function shapeSubagent(lines: TranscriptLine[]): (HistoryMessage & { timestamp?: string })[] {
  const out = lines
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && !!m.message && !!m.uuid)
    .map((m) => ({ type: m.type!, uuid: m.uuid!, parent_tool_use_id: null, message: m.message, ...(m.timestamp ? { timestamp: m.timestamp } : {}), ...(m.cwd ? { cwd: m.cwd } : {}) }))
  return out.length > SUBAGENT_CAP ? out.slice(-SUBAGENT_CAP) : out
}

/**
 * One subagent's activity, for the web to show nested under its Task step. Finds the subagent spawned by `toolUseId`
 * (reusing the same transcript-path resolution as history), reads its transcript and returns it in history's shape,
 * plus its type and task description from the meta. Answers `{ found: false }` gracefully when the subagent's files
 * don't exist yet (there is a beat between spawning it and the files appearing).
 */
export async function subagent(l: Launch, toolUseId: string) {
  if (!ID_RE.test(l.id) || !PROFILE_RE.test(l.profile)) throw new Error('invalid session')
  const dir = sessionDir(l)
  const subDir = dir ? join(dir, l.id, 'subagents') : null
  const miss = { found: false as const, agentType: null, description: null, messages: [] }
  if (!subDir || !existsSync(subDir)) return miss
  const metas: { agentId: string; meta: SubagentMeta }[] = []
  for (const name of readdirSync(subDir)) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!m) continue
    try {
      metas.push({ agentId: m[1]!, meta: JSON.parse(readFileSync(join(subDir, name), 'utf8')) as SubagentMeta })
    } catch {
      // a meta file mid-write
    }
  }
  const agentId = subagentIdFor(metas, toolUseId)
  if (!agentId) return miss
  const meta = metas.find((x) => x.agentId === agentId)!.meta
  const messages = shapeSubagent(readLines(join(subDir, `agent-${agentId}.jsonl`)))
  return { found: true as const, agentType: meta.agentType ?? null, description: meta.description ?? null, messages }
}

/** Stops one background task (a shell, subagent or monitor) of a Chat session. */
export async function stopTask(id: string, taskId: string) {
  const c = chats.get(id)
  if (!c) throw new Error('This session is not running.')
  await c.q.stopTask(taskId)
}

/**
 * Slash commands and models for a profile. Known once a session has run; before that, a short-lived Claude Code
 * process is asked (no model call is made), so the New session dialog can offer the real model list.
 */
const lists = new Map<string, Promise<void>>()
export async function commandsAndModels(profile: string) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  if (!modelCache.has(profile)) {
    const running = [...chats.values()].find((c) => c.launch.profile === profile)?.q
    let job = lists.get(profile)
    if (!job) {
      job = (async () => {
        const temp = running ? undefined : new Inbox()
        const q = running ?? (await loadSdk()).query({
          prompt: temp!,
          options: { cwd: homedir(), env: { ...process.env, ...profileEnv(profile) }, pathToClaudeCodeExecutable: CLAUDE_BIN, persistSession: false },
        })
        try {
          const [cmds, mods] = await Promise.all([q.supportedCommands(), q.supportedModels()])
          commandCache.set(profile, cmds)
          modelCache.set(profile, mods)
        } finally {
          if (temp) { temp.close(); q.close() }
        }
      })().finally(() => lists.delete(profile))
      lists.set(profile, job)
    }
    await Promise.race([job.catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  }
  return { commands: commandCache.get(profile) ?? [], models: modelCache.get(profile) ?? [] }
}

/**
 * Session titles come from Claude Code itself: after each turn the agent reads the title Claude Code keeps for the
 * session (its own generated one, or one set with /rename) and reports it when it changes.
 */
const cliLaunches = new Map<string, Launch>()
const titles = new Map<string, string>()
function refreshTitle(l: Launch) {
  void title(l).then(({ title: t }) => {
    if (t && titles.get(l.id) !== t) {
      titles.set(l.id, t)
      emit({ ev: 'claude.title', id: l.id, title: t })
    }
  }, () => {})
}

/** The title Claude Code keeps for a session, or null before it has one. */
export async function title(l: Launch) {
  validate(l)
  const sdk = await loadSdk()
  const info = await withProfile(l.profile, () => sdk.getSessionInfo(l.id, { dir: l.cwd }))
  return { title: info?.summary?.trim().split('\n')[0]?.slice(0, 120) || null }
}

/** A title set in DevDash goes to Claude Code too (as if typed with /rename), so both show the same name. */
export async function rename(l: Launch, title: string) {
  validate(l)
  const sdk = await loadSdk()
  await withProfile(l.profile, () => sdk.renameSession(l.id, title.slice(0, 120), { dir: l.cwd }))
  titles.set(l.id, title.slice(0, 120))
}

async function authStatus(name: string) {
  try {
    const { stdout } = await run(CLAUDE_BIN, ['auth', 'status', '--json'], { env: { ...process.env, ...profileEnv(name) }, timeout: 20_000 })
    const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string }
    return { name, loggedIn: !!s.loggedIn, authMethod: s.authMethod ?? null, email: s.email ?? null, plan: s.subscriptionType ?? null }
  } catch {
    return { name, loggedIn: false, authMethod: null, email: null, plan: null }
  }
}

export function profileNames() {
  const root = join(homedir(), '.claude-profiles')
  return ['default', ...(existsSync(root) ? readdirSync(root).filter((n) => PROFILE_RE.test(n) && n !== 'default') : [])]
}

export const profiles = () => Promise.all(profileNames().map(authStatus))

// Without a login the SDK process waits silently; say so up front instead. Checked at most every 5 minutes.
const loginChecked = new Map<string, number>()
async function requireLogin(profile: string) {
  if ((loginChecked.get(profile) ?? 0) > Date.now() - 5 * 60_000) return
  if (!(await authStatus(profile)).loggedIn) {
    throw new Error(`The ${profile === 'default' ? 'default' : `"${profile}"`} Claude profile isn't signed in. Open Claude setup and sign in first.`)
  }
  loginChecked.set(profile, Date.now())
}

// Plan limits (5-hour, weekly, per model) for one profile, as /usage shows them. Asks a running Chat process of that
// profile, or briefly starts one without a prompt (no conversation, nothing sent to the model). Cached for a minute.
const usageCache = new Map<string, { at: number; data: unknown }>()
export async function usage(profile: string) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const hit = usageCache.get(profile)
  if (hit && Date.now() - hit.at < 60_000) return hit.data
  await requireLogin(profile)
  let q = [...chats.values()].find((c) => c.launch.profile === profile)?.q
  let temp: Inbox | undefined
  if (!q) {
    temp = new Inbox()
    q = (await loadSdk()).query({
      prompt: temp,
      options: { cwd: homedir(), env: { ...process.env, ...profileEnv(profile) }, pathToClaudeCodeExecutable: CLAUDE_BIN, persistSession: false },
    })
  }
  try {
    if (!q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) throw new Error('This Claude Code version does not report usage.')
    const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    const data = { plan: r.subscription_type, available: r.rate_limits_available, limits: r.rate_limits }
    usageCache.set(profile, { at: Date.now(), data })
    return data
  } finally {
    if (temp) {
      temp.close()
      q.close()
    }
  }
}

/**
 * One answer to one prompt, for small jobs DevDash does with Claude (writing a summary, drafting text). No tools, no
 * session file, and none of the member's settings, hooks or plugins (so e.g. claude-mem doesn't record it).
 */
export async function complete(profile: string, prompt: string, o: { model?: string; system?: string } = {}) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  await requireLogin(profile)
  const inbox = new Inbox()
  const q = (await loadSdk()).query({
    prompt: inbox,
    options: {
      cwd: homedir(), env: { ...process.env, ...profileEnv(profile) }, pathToClaudeCodeExecutable: CLAUDE_BIN,
      persistSession: false, settingSources: [], tools: [], maxTurns: 1,
      ...(o.model ? { model: o.model } : {}), ...(o.system ? { systemPrompt: o.system } : {}),
    },
  })
  inbox.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null })
  try {
    for await (const m of q) {
      if (m.type !== 'result') continue
      const text = typeof m.result === 'string' ? m.result.trim() : ''
      if (m.is_error || m.subtype !== 'success') throw new Error(text || 'Claude could not answer.')
      return text
    }
    throw new Error('Claude stopped without an answer.')
  } finally {
    inbox.close()
    q.close()
  }
}

export function createProfile(name: string) {
  if (!PROFILE_RE.test(name) || name === 'default') throw new Error('Profile names use lowercase letters, digits and dashes.')
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 })
}

/** Status for CLI-mode sessions, reported by packages/claude-plugin/hooks/report.mjs. */
export function hook(p: { session_id?: string; hook_event_name?: string }) {
  const id = p.session_id
  if (!id || !ID_RE.test(id) || chats.has(id)) return // Chat mode reports its own status
  const status: Status | undefined = ({
    UserPromptSubmit: 'working', PreToolUse: 'working', Notification: 'waiting', Stop: 'idle', SessionEnd: 'stopped',
  } as Record<string, Status>)[p.hook_event_name ?? '']
  if (status) emit({ ev: 'claude.status', id, status })
  const l = cliLaunches.get(id)
  if (l && (status === 'idle' || status === 'stopped')) refreshTitle(l)
}

/** Login runs in a terminal tab, because Claude's own login flow is interactive. */
export function loginCommand(profile: string) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  return { env: profileEnv(profile), args: [CLAUDE_BIN, 'auth', 'login'] }
}

/** Something would be cut off if this agent restarted now. */
export const busy = () => [...chats.values()].some((c) => c.status === 'working' || c.status === 'waiting' || c.bg > 0)

setInterval(() => {
  for (const c of chats.values()) {
    // With Remote Control on, the Claude app needs the process: it stays until the owner turns it off.
    if (c.status === 'idle' && !c.pending.size && !c.bg && !c.remote && Date.now() - c.lastActive > IDLE_CLOSE_MS) void stopChat(c)
  }
}, 60_000).unref()
