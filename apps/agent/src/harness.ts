// Coding agents other than Claude Code, driven over ACP (acp.ts). Each session runs in its own agent process, as the
// member, and looks to the server exactly like a Claude Chat session (claude.ts): the same events, the same transcript
// messages, the same permission cards and guest gate. CLI mode runs the agent's own terminal app in tmux, in the same
// c-<id> session Claude's CLI uses. Today that is OpenCode (opencode.ts); another ACP agent is another entry in AGENTS.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { notFound, PROTOCOL_VERSION, Rpc, Transcriber, type ToolCall, type Usage } from './acp.ts'
import {
  cliSession, ensureStorage, IDLE_CLOSE_MS, pageOf, PLUGIN_DIR, PROFILE_RE, setupTailnet, systemAppend, teardownTailnet, validate,
  type Guest, type HistoryMessage, type Launch, type Pending, type Status,
} from './claude.ts'
import { guestMay } from './guest.ts'
import type { PermissionResult } from './sdk.ts'
import { hasSession, tmux } from './tmux.ts'
import * as opencode from './opencode.ts'

/** What DevDash needs to know about one ACP agent. */
type Agent = {
  name: string
  bin: string
  installed: () => boolean
  version: () => Promise<string | null>
  profileNames: () => string[]
  createProfile: (name: string) => void
  profileEnv: (profile: string) => Record<string, string>
  providers: (profile: string) => Promise<string[]>
  models: (profile: string) => Promise<string[]>
  /** Env for one session: its rules and MCP servers. */
  /** Env for one session: its rules and MCP servers, and in the CLI how it asks and which session the plugin reports. */
  sessionEnv: (o: Parameters<typeof opencode.config>[0] & { nativeId?: string }) => Record<string, string>
  acpArgs: string[]
  cliArgs: (nativeId: string) => string[]
  loginArgs: (target: string | null) => string[]
  /** Its sign-ins by kind (login: any provider), as the integration each opens. */
  signIns: Record<string, string | null>
  modeFor: (permissionMode: string) => string
  /** Its commands before a session reports its own. */
  commands: Command[]
}
type Command = { name: string; description: string; argumentHint?: string }

export const AGENTS: Record<string, Agent> = {
  opencode: {
    name: 'OpenCode', bin: opencode.OPENCODE_BIN, installed: opencode.installed, version: opencode.version,
    profileNames: opencode.profileNames, createProfile: opencode.createProfile, profileEnv: opencode.profileEnv,
    providers: opencode.providers, models: opencode.models,
    sessionEnv: ({ nativeId, ...o }) => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify(opencode.config(o)), ...(nativeId ? { DEVDASH_OPENCODE_SESSION: nativeId } : {}) }),
    acpArgs: opencode.acpArgs, cliArgs: opencode.cliArgs, loginArgs: opencode.loginArgs, signIns: opencode.SIGN_INS, modeFor: opencode.modeFor, commands: opencode.COMMANDS,
  },
}
export const isAcp = (harness: unknown): harness is string => typeof harness === 'string' && Object.hasOwn(AGENTS, harness)
const agentOf = (harness: string) => {
  const a = AGENTS[harness]
  if (!a) throw new Error(`Unknown agent: ${harness}`)
  if (!a.installed()) throw new Error(`${a.name} isn't installed on this server yet. An admin can install it from the Server page.`)
  return a
}

let emit: (ev: Record<string, unknown>) => void = () => {}
export const setEmitter = (fn: typeof emit) => { emit = fn }

type Config = { id: string; category?: string; currentValue?: string; options?: { value: string; name?: string; description?: string }[] }
type Chat = {
  launch: Launch; agent: Agent; child: ChildProcess; rpc: Rpc; sessionId: string; t: Transcriber
  /** A child session's (subagent's) own transcriber, nested under the Task step that started it. */
  children: Map<string, Transcriber>
  status: Status; pending: Map<string, Pending>; guest: Guest | null; lastActive: number
  queue: { content: unknown[]; uuid: string; guest: boolean }[]; turn: boolean; lastTaken: number
  /** The session's total cost so far (the agent reports it), its context, and its config options (model, mode). */
  cost: number | null; model: string | null; config: Config[]; fresh: boolean; mcpNames: string[]
  replay: Record<string, unknown>[] | null
  /** Set while DevDash stops it: the turn it cuts short ends as stopped, not as an error. */
  stopping: boolean
  /** What "Always allow" covers in this session (alwaysKey). */
  /** The commands it has (its own report, else the agent's built-ins). */
  commands: Command[]
  always: Set<string>
  /** The effort levels last reported for its model, to report only changes. */
  effortsSent?: string
  childTranscriber: (sessionId: string, parent?: string) => Transcriber
  done: Promise<void>
}
const chats = new Map<string, Chat>()
export const has = (id: string) => chats.has(id)

const DIR = () => join(homedir(), '.local', 'share', 'devdash', 'sessions')
const transcriptFile = (id: string) => join(DIR(), `${id}.jsonl`)

/** Every message of a session, as DevDash keeps it: the agent's own storage is its business, this is ours. */
function readTranscript(id: string): (HistoryMessage & { timestamp?: string })[] {
  const file = transcriptFile(id)
  if (!existsSync(file)) return []
  const out: (HistoryMessage & { timestamp?: string })[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a line being written */ }
  }
  return out
}
function keep(id: string, msgs: Record<string, unknown>[]) {
  if (!msgs.length) return
  mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  const at = new Date().toISOString()
  appendFileSync(transcriptFile(id), msgs.map((m) => `${JSON.stringify({ ...m, timestamp: m.timestamp ?? at })}\n`).join(''), { mode: 0o600 })
}

/** A user message that is the person's own prompt (not a tool result). */
const isPrompt = (m: { type?: string; isSynthetic?: boolean; message?: { content?: unknown } }) =>
  m.type === 'user' && !m.isSynthetic && Array.isArray(m.message?.content) && !(m.message!.content as { type?: string }[]).some((b) => b.type === 'tool_result')

/**
 * What a replayed session has that DevDash's transcript doesn't: the turns typed in the agent's own terminal app. Ours
 * has the first `k` prompts; everything in the replay from its (k+1)-th prompt on is new. Pure, so it is unit-tested.
 */
export function newFromReplay<T extends { type?: string; message?: { content?: unknown } }>(ours: T[], replay: T[]): T[] {
  const k = ours.filter(isPrompt).length
  let seen = 0
  const i = replay.findIndex((m) => isPrompt(m) && ++seen > k)
  return i < 0 ? [] : replay.slice(i)
}

function setStatus(c: Chat | undefined, id: string, status: Status, detail?: string) {
  if (c) {
    if (c.status === status && !detail) return
    c.status = status
  }
  emit({ ev: 'claude.status', id, status, ...(detail ? { detail } : {}) })
}

/** ACP prompt content from the Claude-shaped blocks the server sends: text, images, attached documents. */
export function toPrompt(content: unknown[]): Record<string, unknown>[] {
  return content.flatMap((b): Record<string, unknown>[] => {
    const x = b as { type?: string; text?: string; title?: string; source?: { type?: string; media_type?: string; data?: string } }
    if (x.type === 'text' && x.text) return [{ type: 'text', text: x.text }]
    if (x.type === 'image' && x.source?.type === 'base64') return [{ type: 'image', mimeType: x.source.media_type, data: x.source.data }]
    if (x.type === 'document' && x.source?.data) {
      const uri = `file:///${encodeURIComponent(x.title ?? 'attachment')}`
      return [{ type: 'resource', resource: x.source.type === 'text' ? { uri, mimeType: 'text/plain', text: x.source.data } : { uri, mimeType: x.source.media_type, blob: x.source.data } }]
    }
    return []
  })
}

/**
 * A prompt that names one of the session's commands ("/review src/auth.ts"), as the transcript text Claude Code writes
 * for a command, which the web shows as one; null for anything else. Pure, so it is unit-tested.
 */
export function commandText(content: unknown[], commands: { name: string }[]): unknown[] | null {
  const texts = content.filter((b) => (b as { type?: string }).type === 'text')
  if (texts.length !== 1 || content.length !== 1) return null
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(((texts[0] as { text?: string }).text ?? '').trim())
  if (!m || !commands.some((x) => x.name === m[1])) return null
  return [{ type: 'text', text: `<command-name>/${m[1]}</command-name>\n<command-args>${m[2]?.trim() ?? ''}</command-args>` }]
}

/**
 * A teammate's message never runs a command: a custom command can run shell blocks outside the agent's permission
 * flow, so the guest gate would never see them. A prompt starting with "/" runs one, so theirs never starts with it.
 * (The server already puts its note about the teammate first; this keeps it so whatever comes first.)
 */
export function notACommand(prompt: Record<string, unknown>[]): Record<string, unknown>[] {
  const first = prompt[0] as { type?: string; text?: string } | undefined
  return first?.type === 'text' && first.text?.trimStart().startsWith('/') ? [{ type: 'text', text: 'A teammate wrote:' }, ...prompt] : prompt
}

/** What runs without asking in each permission mode, like Claude Code's: reads always, edits in Accept edits, all in Bypass. */
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'Task', 'skill', 'Skill'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'patch', 'apply_patch'])
export function autoAllowed(mode: string, tool: string) {
  if (mode === 'bypassPermissions') return true
  if (READS.has(tool) || tool.startsWith('mcp__plugin_devdash_devdash__') && !tool.includes('__net_')) return true
  return mode === 'acceptEdits' && EDITS.has(tool)
}

/**
 * OpenCode's question form (elicitation/create) as Claude Code's AskUserQuestion, so the same card asks it, and the
 * card's answers ({question: "label, label" | typed text}) back as the form's content. Pure, so they are unit-tested.
 */
type Form = { properties?: Record<string, { type?: string; title?: string; description?: string; oneOf?: { const: string; title?: string; description?: string }[]; items?: { anyOf?: { const: string; title?: string; description?: string }[]; oneOf?: { const: string; title?: string; description?: string }[] } }> }
export function formQuestions(schema: Form, message?: string) {
  const props = schema.properties ?? {}
  return Object.entries(props).filter(([k]) => !k.endsWith('_custom')).map(([key, p]) => {
    const choices = p.oneOf ?? p.items?.anyOf ?? p.items?.oneOf ?? []
    return {
      key, question: p.description || p.title || message || key, header: p.title, multiSelect: p.type === 'array',
      options: choices.map((o) => ({ label: o.title ?? o.const, description: o.description, value: o.const })),
    }
  })
}
export function formAnswer(qs: ReturnType<typeof formQuestions>, answers: Record<string, string>, schema: Form) {
  const content: Record<string, unknown> = {}
  for (const q of qs) {
    const said = (answers[q.question] ?? '').trim()
    const byLabel = new Map(q.options.map((o) => [o.label, o.value]))
    const parts = q.multiSelect ? said.split(', ') : [said]
    const picked = parts.map((p) => byLabel.get(p)).filter((v): v is string => !!v)
    const typed = picked.length === parts.length ? '' : said
    if (q.multiSelect) content[q.key] = picked
    else if (picked[0]) content[q.key] = picked[0]
    if (typed && schema.properties?.[`${q.key}_custom`]) content[`${q.key}_custom`] = typed
    else if (typed && !q.options.length) content[q.key] = typed
  }
  return content
}

async function startChat(l: Launch): Promise<Chat> {
  validate(l)
  const agent = agentOf(l.harness!)
  await ensureStorage(l)
  const tn = await setupTailnet(l).catch((err: Error) => { console.error(`[${l.id.slice(0, 8)}] tailnet:`, err.message); return null })
  // DevDash's rules for the session, read by the agent as instructions; rewritten at every start (they change with sharing).
  const dir = join(homedir(), '.cache', 'devdash', 'sessions', l.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const rulesFile = join(dir, 'devdash-rules.md')
  writeFileSync(rulesFile, systemAppend(l), { mode: 0o600 })
  const mcp: Parameters<Agent['sessionEnv']>[0]['mcp'] = {
    devdash: { type: 'local', command: [process.execPath, join(PLUGIN_DIR, 'mcp', 'devdash.mjs')], environment: { DEVDASH_AGENT_SOCKET: process.env.DEVDASH_AGENT_SOCKET ?? '', DEVDASH_SESSION_ID: l.id } },
  }
  for (const [name, s] of Object.entries(tn?.mcpServers ?? {})) mcp[name] = { type: 'remote', url: (s as { url: string }).url }
  const child = spawn(agent.bin, agent.acpArgs, {
    cwd: l.cwd,
    env: { ...process.env, ...agent.profileEnv(l.profile), DEVDASH_SESSION_ID: l.id, ...(tn?.env ?? {}), ...agent.sessionEnv({ rulesFile, mcp }) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr!.on('data', (d: Buffer) => console.error(`[${l.id.slice(0, 8)}] ${d.toString().trimEnd().slice(0, 2000)}`))
  let c: Chat | undefined
  const rpc = new Rpc(child, {
    notify: (method, params) => { if (c && method === 'session/update') update(c, params) },
    request: async (method, params) => {
      if (!c) throw new Error('not ready')
      if (method === 'session/request_permission') return permission(c, params)
      if (method === 'elicitation/create') return question(c, params)
      throw notFound(method)
    },
  })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const failed = (err: Error) => {
    child.kill()
    teardownTailnet(l.id)
    throw new Error(`${agent.name} didn't start: ${err.message}`)
  }
  const init = await Promise.race([
    rpc.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'DevDash', version: '1' },
    }),
    exited.then((code) => Promise.reject(new Error(`it exited (${code})`))),
  ]).catch(failed)

  const t = (sessionId: string, parent?: string) => new Transcriber((msg, live) => {
    if (!c) return
    if (c.replay) return void (!live && c.replay.push(msg))
    // Results aren't kept: the server saves each turn's numbers and puts them back in the history itself.
    if (!live && msg.type !== 'result') keep(l.id, [msg])
    c.lastActive = Date.now()
    emit({ ev: 'claude.msg', id: l.id, msg })
  }, { model: () => c?.model ?? null, mcpServers: Object.keys(mcp), sessionId, ...(parent ? { parent } : {}) })
  c = {
    launch: { ...l, started: true }, agent, child, rpc, sessionId: l.nativeId ?? '', t: t(l.nativeId ?? ''), children: new Map(),
    status: 'idle', pending: new Map(), guest: null, lastActive: Date.now(), queue: [], turn: false, lastTaken: 0,
    cost: null, model: l.model ?? null, config: [], fresh: !l.started, mcpNames: Object.keys(mcp), replay: null, stopping: false, always: loadAlways(l.id), commands: agent.commands,
    childTranscriber: t, done: exited.then(() => {}),
  }
  const chat = c

  // An existing session: load it, which replays it. What the agent's terminal app added since is added to ours.
  let opened: { sessionId?: string; configOptions?: Config[] } | null = null
  if (l.nativeId && init.agentCapabilities?.loadSession) {
    chat.replay = []
    opened = await rpc.request<{ configOptions?: Config[] }>('session/load', { sessionId: l.nativeId, cwd: l.cwd, mcpServers: [] }).catch((err: Error) => {
      console.error(`[${l.id.slice(0, 8)}] load:`, err.message)
      return null
    })
    chat.t.flush()
    const extra = opened ? newFromReplay(readTranscript(l.id), chat.replay as HistoryMessage[]) : []
    chat.replay = null
    keep(l.id, extra as unknown as Record<string, unknown>[])
    chat.t = t(l.nativeId) // the live turns start from a clean slate, not the replay's
  }
  if (!opened) {
    opened = await rpc.request<{ sessionId: string; configOptions?: Config[] }>('session/new', { cwd: l.cwd, mcpServers: [] }).catch(failed)
    chat.sessionId = opened.sessionId!
    chat.t = t(chat.sessionId)
    emit({ ev: 'claude.native', id: l.id, nativeId: chat.sessionId })
    if (l.nativeId) {
      // The agent no longer has the old conversation (another profile, deleted): say so where it continues.
      const text = `${agent.name} couldn't find the earlier conversation, so it starts over from here.`
      keep(l.id, [{ type: 'user', uuid: randomUUID(), isSynthetic: true, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }])
    }
  }
  chat.config = opened.configOptions ?? []
  await applyModel(chat, l.model ?? null)
  await applyEffort(chat, l.effort ?? null)
  await applyMode(chat)
  reportEfforts(chat)
  chats.set(l.id, chat)
  void chat.done.then(() => closed(chat))
  return chat
}

const option = (c: Chat, category: string) => c.config.find((o) => o.category === category)
async function applyModel(c: Chat, model: string | null) {
  const o = option(c, 'model')
  if (o?.currentValue) c.model = o.currentValue
  if (!o || !model || model === o.currentValue) return
  await setConfig(c, o.id, model).catch((err: Error) => {
    emit({ ev: 'claude.status', id: c.launch.id, status: c.status, detail: `Model ${model} isn't available: ${err.message}`.slice(0, 300) })
  })
  c.model = model
}
/**
 * Effort is the model's own levels (OpenCode calls them variants: "high", "max", "minimal"…), so they change with the
 * model; the server shows the current model's. A level this model doesn't have is left alone.
 */
async function applyEffort(c: Chat, effort: string | null) {
  const o = option(c, 'thought_level')
  const want = effort ?? 'default'
  if (o && o.currentValue !== want && o.options?.some((x) => x.value === want)) await setConfig(c, o.id, want).catch(() => {})
}
function reportEfforts(c: Chat) {
  const o = option(c, 'thought_level')
  const efforts = (o?.options ?? []).map((x) => x.value).filter((v) => v !== 'default')
  const key = JSON.stringify(efforts)
  if (key === c.effortsSent) return
  c.effortsSent = key
  emit({ ev: 'claude.efforts', id: c.launch.id, efforts })
}
async function applyMode(c: Chat) {
  const o = option(c, 'mode')
  const want = c.agent.modeFor(c.launch.permissionMode)
  if (o && o.currentValue !== want && o.options?.some((x) => x.value === want)) await setConfig(c, o.id, want).catch(() => {})
}
async function setConfig(c: Chat, configId: string, value: string) {
  const r = await c.rpc.request<{ configOptions?: Config[] }>('session/set_config_option', { sessionId: c.sessionId, configId, value })
  if (r?.configOptions) c.config = r.configOptions
}

/** The transcriber for an update: the session's own, or a subagent's (child session), nested under its Task step. */
function transcriberFor(c: Chat, u: Record<string, unknown>) {
  const child = ((u._meta ?? {}) as Record<string, { id?: string } | undefined>)['opencode/child-session']?.id
  if (!child) return c.t
  let t = c.children.get(child)
  if (!t) {
    t = c.childTranscriber(child, c.t.claimTask() ?? undefined)
    c.children.set(child, t)
  }
  return t
}

function update(c: Chat, p: Record<string, unknown>) {
  const u = (p.update ?? {}) as Record<string, unknown>
  const id = c.launch.id
  c.lastActive = Date.now()
  switch (u.sessionUpdate) {
    case 'user_message_chunk': {
      // Only in a replay (the agent's own record of the conversation): DevDash keeps the prompts it sends itself.
      const text = (u.content as { text?: string } | undefined)?.text
      if (c.replay && text) c.t.userText(text, typeof u.messageId === 'string' ? `${u.messageId}` : undefined)
      return
    }
    case 'usage_update': {
      const used = Number(u.used), size = Number(u.size)
      const cost = u.cost as { amount?: number; currency?: string } | undefined
      if (cost?.currency === 'USD' && typeof cost.amount === 'number') c.cost = cost.amount
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0 && !c.replay) emit({ ev: 'claude.context', id, percent: Math.round((used / size) * 100), tokens: used, max: size })
      return
    }
    case 'session_info_update': {
      if (typeof u.title === 'string' && u.title.trim() && !c.replay) emit({ ev: 'claude.title', id, title: u.title.trim().slice(0, 120) })
      const meta = (u._meta ?? {}) as Record<string, { error?: { message?: string }; status?: string } | null | undefined>
      if ('opencode/retry' in meta && !c.replay) {
        const r = meta['opencode/retry']
        setStatus(c, id, 'working', r ? `Retrying: ${r.error?.message ?? 'the model call failed'}`.slice(0, 300) : undefined)
      }
      if (meta['opencode/compaction']?.status === 'completed') {
        c.t.flush()
        const note = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID() }
        if (c.replay) c.replay.push(note)
        else { keep(id, [note]); emit({ ev: 'claude.msg', id, msg: note }) }
      }
      return
    }
    case 'config_option_update':
      if (Array.isArray(u.configOptions)) c.config = u.configOptions as Config[]
      if (option(c, 'model')?.currentValue) c.model = option(c, 'model')!.currentValue!
      reportEfforts(c)
      return
    case 'available_commands_update':
      // Built-in, the member's and the project's own commands; the composer offers them, a prompt naming one runs it.
      if (Array.isArray(u.availableCommands)) {
        c.commands = (u.availableCommands as { name: string; description?: string; input?: { hint?: string } | null }[]).map((x) => ({
          name: x.name, description: x.description ?? '', ...(x.input?.hint ? { argumentHint: x.input.hint } : {}),
        }))
        commandCache.set(`${c.launch.harness}:${c.launch.profile}`, c.commands)
      }
      return
    default:
      transcriberFor(c, u).update(u)
  }
}

/**
 * Asks the person (or, for what would use the owner's access in a teammate's turn, the owner) and waits. `always`:
 * the card offers "Always allow" too (the web shows it when there are suggestions).
 */
function ask(c: Chat, toolName: string, input: Record<string, unknown>, o: { askedBy?: Guest; always?: string } = {}) {
  return new Promise<PermissionResult>((resolve) => {
    const requestId = randomUUID()
    const extra = { ...(o.askedBy ? { ownerOnly: true, askedBy: o.askedBy } : {}), ...(o.always ? { suggestions: [{ always: o.always }] } : {}) }
    c.pending.set(requestId, { requestId, toolName, input, resolve, ...extra })
    setStatus(c, c.launch.id, 'waiting')
    emit({ ev: 'claude.permission', id: c.launch.id, requestId, toolName, input, ...extra })
  })
}

/**
 * What "Always allow" covers, like Claude Code's rules: a command by its program and subcommand ("git status", "npm
 * test"), a fetch by its site, anything else by its tool. Pure, so it is unit-tested.
 */
const SUBCOMMANDS = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'deno', 'cargo', 'go', 'pip', 'pip3', 'uv', 'poetry',
  'docker', 'podman', 'kubectl', 'flutter', 'dart', 'gradle', 'mvn', 'make', 'devdash', 'systemctl', 'brew', 'apt', 'apt-get', 'rclone', 'tailscale'])
export function alwaysKey(tool: string, input: Record<string, unknown>) {
  if (tool === 'Bash' && typeof input.command === 'string') {
    const words = input.command.trim().split(/\s+/)
    // A program with subcommands is allowed per subcommand (git status, not all of git); others as a whole.
    const sub = SUBCOMMANDS.has(words[0] ?? '') && words[1] && /^[a-z][\w:.-]*$/i.test(words[1]) ? ` ${words[1]}` : ''
    return `Bash(${words[0] ?? ''}${sub})`
  }
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    try { return `WebFetch(${new URL(input.url).hostname})` } catch { return 'WebFetch' }
  }
  return tool
}
/**
 * DevDash keeps "Always allow" itself, per session (and across its restarts), rather than letting the agent save it:
 * an agent that stops asking would let a teammate's later turn skip the guest gate, which this never does.
 */
const alwaysFile = (id: string) => join(homedir(), '.cache', 'devdash', 'sessions', id, 'always.json')
function loadAlways(id: string): Set<string> {
  try { return new Set(JSON.parse(readFileSync(alwaysFile(id), 'utf8')) as string[]) } catch { return new Set() }
}
function saveAlways(c: Chat, key: string) {
  c.always.add(key)
  mkdirSync(join(homedir(), '.cache', 'devdash', 'sessions', c.launch.id), { recursive: true, mode: 0o700 })
  writeFileSync(alwaysFile(c.launch.id), JSON.stringify([...c.always]), { mode: 0o600 })
}

/**
 * A role's limits (a team role's session): `tools` are the built-in tools it has, `allow` the ones that run without
 * asking; MCP tools aren't limited by `tools`, as in Claude Code. Pure, so it is unit-tested.
 */
export function policyDecision(policy: Launch['toolPolicy'], tool: string, input: Record<string, unknown> = {}): 'deny' | 'allow' | null {
  if (!policy) return null
  if (policy.tools && !tool.startsWith('mcp__') && tool !== 'AskUserQuestion' && !policy.tools.includes(tool)) return 'deny'
  return policy.allow && allowedBy(policy.allow, tool, input) ? 'allow' : null
}

/**
 * Claude Code's allow rules: a tool ("Read"), a whole MCP server ("mcp__plugin_devdash_devdash") or one of its tools, a
 * command by prefix ("Bash(git log:*)") or exactly ("Bash(npm test)"), a fetch by site ("WebFetch(domain:x.com)"). A
 * command with several parts (a pipe, &&, ;) is allowed only when every part is. Pure, so it is unit-tested.
 */
export function allowedBy(rules: string[], tool: string, input: Record<string, unknown>): boolean {
  const parsed = rules.map((r) => /^([\w-]+)(?:\((.*)\))?$/.exec(r.trim())).filter((m): m is RegExpExecArray => !!m)
  if (parsed.some(([, name, spec]) => spec === undefined && (name === tool || (name!.startsWith('mcp__') && tool.startsWith(`${name}__`))))) return true
  const specs = parsed.filter(([, name, spec]) => name === tool && spec !== undefined).map(([, , spec]) => spec!)
  if (!specs.length) return false
  if (tool === 'Bash' && typeof input.command === 'string') {
    const parts = input.command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((p) => p.trim()).filter(Boolean)
    return parts.length > 0 && parts.every((part) => specs.some((s) => (s.endsWith(':*') ? part === s.slice(0, -2) || part.startsWith(`${s.slice(0, -2)} `) : part === s)))
  }
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    let host = ''
    try { host = new URL(input.url).hostname } catch { return false }
    return specs.some((s) => s.startsWith('domain:') && (host === s.slice(7) || host.endsWith(`.${s.slice(7)}`)))
  }
  return false
}

async function permission(c: Chat, p: Record<string, unknown>) {
  const tc = (p.toolCall ?? {}) as ToolCall
  const options = (p.options ?? []) as { optionId: string; kind: string }[]
  const pick = (kind: string) => ({ outcome: { outcome: 'selected', optionId: options.find((o) => o.kind === kind)?.optionId ?? kind } })
  const { name, input } = transcriberFor(c, tc as unknown as Record<string, unknown>).describe(tc)
  // A question asks through its form right after (elicitation/create): letting the tool run is what lets it ask.
  if (name === 'AskUserQuestion') return pick('allow_once')
  const l = c.launch
  const policy = policyDecision(l.toolPolicy, name, input)
  if (policy === 'deny') return pick('reject_once')
  if (c.guest && !guestMay(name, input, {
    cwd: l.cwd, tailnet: !!l.reachTailnet, caps: l.guestCaps, tailnetMcps: (l.tailnetMcps ?? []).map((m) => m.name), sessionId: l.id,
  })) {
    const r = await ask(c, name, input, { askedBy: c.guest })
    return pick(r.behavior === 'allow' ? 'allow_once' : 'reject_once')
  }
  const key = alwaysKey(name, input)
  if (policy === 'allow') return pick('allow_once')
  // "Don't ask" (a team role's shift, which nobody watches): what isn't allowed up front is denied, as in Claude Code.
  if (l.permissionMode === 'dontAsk') return pick('reject_once')
  if (autoAllowed(l.permissionMode, name) || c.always.has(key)) return pick('allow_once')
  const r = await ask(c, name, input, { always: key })
  if (r.behavior === 'allow' && r.updatedPermissions?.length) saveAlways(c, key)
  return pick(r.behavior === 'allow' ? 'allow_once' : 'reject_once')
}

async function question(c: Chat, p: Record<string, unknown>) {
  const schema = (p.requestedSchema ?? {}) as Form
  const qs = formQuestions(schema, typeof p.message === 'string' ? p.message : undefined)
  if (!qs.length) return { action: 'decline' }
  const r = await ask(c, 'AskUserQuestion', { questions: qs.map(({ question, header, multiSelect, options }) => ({ question, header, multiSelect, options: options.map(({ label, description }) => ({ label, description })) })) })
  if (r.behavior !== 'allow') return { action: 'decline' }
  const answers = ((r.updatedInput ?? {}).answers ?? {}) as Record<string, string>
  return { action: 'accept', content: formAnswer(qs, answers, schema) }
}

async function runTurns(c: Chat) {
  if (c.turn) return
  c.turn = true
  try {
    while (c.queue.length && !c.rpc.closed) {
      const next = c.queue.shift()!
      c.lastTaken = Date.now()
      setStatus(c, c.launch.id, 'working')
      const started = Date.now()
      try {
        const prompt = next.guest ? notACommand(toPrompt(next.content)) : toPrompt(next.content)
        const r = await c.rpc.request<{ stopReason: string; usage?: Usage }>('session/prompt', { sessionId: c.sessionId, prompt })
        for (const t of c.children.values()) t.flush()
        c.t.end({ stopReason: r.stopReason, durationMs: Date.now() - started, costUsd: c.cost, usage: r.usage, fresh: c.fresh })
      } catch (err) {
        if (c.stopping) return void c.t.end({ stopReason: 'cancelled', durationMs: Date.now() - started, costUsd: c.cost, fresh: c.fresh })
        const msg = (err as Error).message
        const auth = /auth/i.test(msg) ? ` Connect the model's provider on the Agent setup page.` : ''
        c.t.end({ stopReason: 'error', durationMs: Date.now() - started, costUsd: c.cost, error: `${msg}${auth}`.slice(0, 500), fresh: c.fresh })
      }
      c.children.clear()
    }
  } finally {
    c.turn = false
    if (!c.pending.size) setStatus(c, c.launch.id, 'idle')
    endGuest(c)
  }
}

/** A teammate's turn is over once nothing is queued, waiting or running, and well after the last message was taken. */
function endGuest(c: Chat) {
  if (c.guest && !c.queue.length && !c.pending.size && !c.turn && Date.now() - c.lastTaken > 3000) c.guest = null
}

function closed(c: Chat) {
  const id = c.launch.id
  if (chats.get(id) === c) chats.delete(id)
  teardownTailnet(id)
  for (const p of c.pending.values()) {
    emit({ ev: 'claude.permission_done', id, requestId: p.requestId })
    p.resolve({ behavior: 'deny', message: 'Session closed' })
  }
  c.pending.clear()
  const crashed = c.status === 'working' && !c.stopping
  if (c.status !== 'idle') setStatus(c, id, crashed ? 'error' : 'idle', crashed ? `${c.agent.name} stopped unexpectedly.` : undefined)
  emit({ ev: 'claude.closed', id })
}

// One start/send/stop at a time per session, like claude.ts: a double tap must not start two processes.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
  queues.set(id, next)
  void next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => {})
  return next
}

export const send = (l: Launch, content: unknown[], uuid: string, guest: Guest | null = null) => serial(l.id, async () => {
  if (await hasSession(cliSession(l.id))) throw new Error('This session is open in the CLI. Switch to Chat to send from here.')
  const c = chats.get(l.id) ?? (await startChat(l))
  c.launch = { ...c.launch, guestCaps: l.guestCaps ?? [] }
  if (guest) c.guest = guest
  else if (!c.turn) endGuest(c)
  // A command is kept as Claude Code keeps one, so the conversation shows it as a command, not as words to the model.
  const command = guest ? null : commandText(content, c.commands)
  keep(l.id, [{ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: command ?? content } }])
  c.queue.push({ content, uuid, guest: !!guest })
  c.lastActive = Date.now()
  setStatus(c, l.id, 'working')
  void runTurns(c)
})

export function answer(id: string, requestId: string, result: PermissionResult, by?: { owner?: boolean }) {
  const c = chats.get(id)
  const p = c?.pending.get(requestId)
  if (!c || !p) throw new Error('This request is no longer waiting for an answer.')
  if (p.ownerOnly && !by?.owner) throw new Error(`Only ${c.launch.ownerName ?? 'the owner'} can answer this: it would use their access.`)
  c.pending.delete(requestId)
  p.resolve(result)
  emit({ ev: 'claude.permission_done', id, requestId })
  setStatus(c, id, 'working')
}

export async function interrupt(id: string) {
  const c = chats.get(id)
  if (!c) return
  c.queue.length = 0
  c.rpc.notify('session/cancel', { sessionId: c.sessionId })
  for (const p of c.pending.values()) {
    emit({ ev: 'claude.permission_done', id, requestId: p.requestId })
    p.resolve({ behavior: 'deny', message: 'Cancelled' })
  }
  c.pending.clear()
}

export async function setOption(id: string, key: string, value: string | boolean | string[] | null) {
  const c = chats.get(id)
  if (!c) return
  if (key === 'guestCaps') c.launch = { ...c.launch, guestCaps: Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [] }
  else if (key === 'model') {
    await applyModel(c, (value as string | null) ?? null)
    await applyEffort(c, c.launch.effort ?? null) // the new model's own level of the same name, if it has one
    reportEfforts(c)
  } else if (key === 'effort') {
    c.launch = { ...c.launch, effort: (value as string | null) ?? null }
    await applyEffort(c, c.launch.effort ?? null)
  }
  else if (key === 'permissionMode' && typeof value === 'string') {
    c.launch = { ...c.launch, permissionMode: value as Launch['permissionMode'] }
    await applyMode(c)
  }
}

async function stopChat(c: Chat) {
  c.stopping = true
  await interrupt(c.launch.id)
  c.child.stdin?.end() // the agent exits when its input closes
  const gone = await Promise.race([c.done.then(() => true), new Promise((r) => setTimeout(r, 5000, false))])
  if (!gone) c.child.kill('SIGTERM')
  await c.done
}

export const stop = (id: string) => serial(id, async () => {
  const c = chats.get(id)
  if (c) await stopChat(c)
})

/** CLI mode: the agent's own terminal app on the same session, in tmux; the Chat process goes first. */
export const openCli = (l: Launch, cols: number, rows: number) => serial(l.id, async () => {
  validate(l)
  const agent = agentOf(l.harness!)
  let c = chats.get(l.id)
  let nativeId = c?.sessionId || l.nativeId
  // A session that starts in the CLI is created over ACP first, so DevDash knows its id.
  if (!nativeId) {
    c = await startChat(l)
    nativeId = c.sessionId
  }
  if (c) await stopChat(c)
  if (await hasSession(cliSession(l.id))) return
  const tn = await setupTailnet(l).catch(() => null)
  const dir = join(homedir(), '.cache', 'devdash', 'sessions', l.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const rulesFile = join(dir, 'devdash-rules.md')
  writeFileSync(rulesFile, systemAppend(l), { mode: 0o600 })
  const mcp: Parameters<Agent['sessionEnv']>[0]['mcp'] = {
    devdash: { type: 'local', command: [process.execPath, join(PLUGIN_DIR, 'mcp', 'devdash.mjs')], environment: { DEVDASH_AGENT_SOCKET: process.env.DEVDASH_AGENT_SOCKET ?? '', DEVDASH_SESSION_ID: l.id } },
  }
  for (const [name, s] of Object.entries(tn?.mcpServers ?? {})) mcp[name] = { type: 'remote', url: (s as { url: string }).url }
  const env = { ...agent.profileEnv(l.profile), DEVDASH_SESSION_ID: l.id, ...(tn?.env ?? {}), ...agent.sessionEnv({ rulesFile, mcp, cliMode: l.permissionMode, nativeId }) }
  try {
    await tmux('new-session', '-d', '-s', cliSession(l.id), '-c', l.cwd, '-x', String(cols), '-y', String(rows),
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), agent.bin, ...agent.cliArgs(nativeId))
  } catch (err) {
    if (!/duplicate session/.test((err as Error).message)) throw new Error(`Could not start ${agent.name}'s terminal app. Try again in a moment.`)
  }
  emit({ ev: 'claude.status', id: l.id, status: 'idle', mode: 'cli' })
  watchCli(l.id)
})

/**
 * What an agent's terminal app reports through its DevDash plugin (packages/opencode-plugin): its status, as Claude
 * Code's hook names (claude.ts hook), and its title. Chat mode reports its own, so a running Chat process wins.
 */
const CLI_STATUS: Record<string, Status> = { UserPromptSubmit: 'working', PreToolUse: 'working', Notification: 'waiting', Stop: 'idle' }
export function cliHook(p: { session_id?: unknown; hook_event_name?: unknown; title?: unknown }) {
  const id = p.session_id
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || chats.has(id)) return
  if (typeof p.title === 'string' && p.title.trim()) {
    titles.set(id, p.title.trim().slice(0, 120))
    emit({ ev: 'claude.title', id, title: p.title.trim().slice(0, 120) })
  }
  const status = typeof p.hook_event_name === 'string' ? CLI_STATUS[p.hook_event_name] : undefined
  if (status) emit({ ev: 'claude.status', id, status })
}

/**
 * Claude Code's CLI says when it exits (its SessionEnd hook); the agents' terminal apps don't, so their tmux session is
 * watched: once it's gone, the session is back in Chat ("stopped" tells the server so).
 */
const watched = new Set<string>()
function watchCli(id: string) {
  if (watched.has(id)) return
  watched.add(id)
  const timer = setInterval(() => void hasSession(cliSession(id)).then((alive) => {
    if (alive) return
    clearInterval(timer)
    watched.delete(id)
    if (!chats.has(id)) emit({ ev: 'claude.status', id, status: 'stopped' }) // a Chat turn already took over: it reports itself
  }, () => {}), 3000)
  timer.unref()
}

/** A page of the session's history, from DevDash's own transcript: the last `turns` prompts before `before`. */
export function history(l: Launch, o: { before?: string; turns?: number } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(l.id)) throw new Error('invalid session')
  const all = readTranscript(l.id)
  const { start, end } = pageOf(all, o)
  return { messages: all.slice(start, end), more: start > 0 }
}

const titles = new Map<string, string>()
export const title = (l: Launch) => ({ title: titles.get(l.id) ?? null })
export const rename = (l: Launch, t: string) => void titles.set(l.id, t.slice(0, 120))

export const snapshot = () => [...chats.values()].map((c) => ({
  id: c.launch.id, mode: 'chat', status: c.status, remote: null, tasks: [],
  pending: [...c.pending.values()].map(({ resolve: _, ...p }) => p),
}))
export const pendingFor = (id: string) => [...(chats.get(id)?.pending.values() ?? [])].map(({ resolve: _, ...p }) => p)
export const busy = () => [...chats.values()].some((c) => c.status === 'working' || c.status === 'waiting')

const commandCache = new Map<string, Command[]>()
const modelCache = new Map<string, { at: number; models: { value: string; displayName: string; description?: string; group?: string }[] }>()
/** Commands and models for a profile of an agent: its models from every provider the profile has connected. */
export async function commandsAndModels(harness: string, profile: string) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const agent = agentOf(harness)
  const key = `${harness}:${profile}`
  const hit = modelCache.get(key)
  if (!hit || Date.now() - hit.at > 5 * 60_000) {
    const ids = await agent.models(profile)
    const listed = ids.map((v) => ({ value: v, displayName: v.split('/').slice(1).join('/'), description: v, group: v.split('/')[0] }))
    modelCache.set(key, { at: Date.now(), models: [{ value: '', displayName: 'Default', description: `${agent.name}'s own default` }, ...listed] })
  }
  return { commands: commandCache.get(key) ?? agent.commands, models: modelCache.get(key)!.models }
}

/** Each ACP agent, whether it's installed, and its profiles with the providers each has connected. */
const providerCache = new Map<string, { at: number; list: Promise<string[]> }>()
const providersOf = (harness: string, a: Agent, profile: string) => {
  const key = `${harness}:${profile}`
  const hit = providerCache.get(key)
  if (hit && Date.now() - hit.at < 15_000) return hit.list
  const list = a.providers(profile)
  providerCache.set(key, { at: Date.now(), list })
  return list
}
export async function agents() {
  return Promise.all(Object.entries(AGENTS).map(async ([harness, a]) => {
    if (!a.installed()) return { harness, installed: false, version: null, profiles: [] }
    const profiles = await Promise.all(a.profileNames().map(async (name) => ({ name, providers: await providersOf(harness, a, name) })))
    return { harness, installed: true, version: await a.version(), profiles, providers: profiles.find((p) => p.name === 'default')?.providers ?? [] }
  }))
}

/**
 * One answer to one prompt, for small jobs DevDash does with an agent (a digest, drafted instructions): every tool
 * denied, no MCP, and the session it needed deleted afterwards so it never shows in the member's own lists.
 */
export async function complete(harness: string, profile: string, prompt: string, o: { model?: string; system?: string } = {}) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const agent = agentOf(harness)
  const dir = join(homedir(), '.cache', 'devdash', 'complete')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const rulesFile = join(dir, `${randomUUID()}.md`)
  writeFileSync(rulesFile, o.system ?? '', { mode: 0o600 })
  const child = spawn(agent.bin, agent.acpArgs, {
    cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...agent.profileEnv(profile), ...agent.sessionEnv({ rulesFile, mcp: {}, noTools: true }) },
  })
  let text = ''
  const rpc = new Rpc(child, {
    notify: (method, p) => {
      const u = (p.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } }
      if (method === 'session/update' && u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text ?? ''
    },
    request: async (method) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: 'reject' } }
      throw notFound(method)
    },
  })
  try {
    await rpc.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const s = await rpc.request<{ sessionId: string; configOptions?: Config[] }>('session/new', { cwd: homedir(), mcpServers: [] })
    const model = s.configOptions?.find((x) => x.category === 'model')
    if (o.model && model) await rpc.request('session/set_config_option', { sessionId: s.sessionId, configId: model.id, value: o.model }).catch(() => {})
    const r = await rpc.request<{ stopReason: string }>('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] })
    await rpc.request('session/delete', { sessionId: s.sessionId }).catch(() => {})
    if (r.stopReason !== 'end_turn' || !text.trim()) throw new Error(`${agent.name} could not answer.`)
    return text.trim()
  } finally {
    child.stdin?.end()
    setTimeout(() => child.kill(), 5000).unref()
    rmSync(rulesFile, { force: true })
  }
}

export function createProfile(harness: string, name: string) {
  agentOf(harness).createProfile(name)
}

/** The agent's own sign-in of a kind (its `signIns`), run in a terminal tab (oc-<kind>-<profile>). */
export function loginCommand(harness: string, profile: string, kind = 'login') {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const a = agentOf(harness)
  if (!Object.hasOwn(a.signIns, kind)) throw new Error('unknown sign-in')
  return { env: a.profileEnv(profile), args: [a.bin, ...a.loginArgs(a.signIns[kind]!)] }
}

/**
 * A browser sign-in started on this server (Sign in with ChatGPT) sends the browser back to http://127.0.0.1:<port>/…,
 * which is the server, not the person's device, so that page never opens. They paste the address their browser ended
 * on; this checks it is such a local sign-in address (and nothing else on the machine). Pure, so it is unit-tested.
 */
export function signInCallback(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error("That isn't an address. Copy the whole address from your browser's address bar.")
  }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || Number(u.port) < 1024) {
    throw new Error('That isn\'t a sign-in on this server: the address starts with http://127.0.0.1: or http://localhost: and a port.')
  }
  if (!u.search) throw new Error('That address has no sign-in code in it. Copy it again from the page your browser couldn\'t open.')
  return u
}
/** Delivers that last step to the sign-in waiting in the member's terminal tab, as the member. */
export async function finishSignIn(raw: string) {
  const u = signInCallback(raw)
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new Error('No sign-in is waiting at that address any more. Start it again from Agent setup.')
  })
  if (res.status >= 400) throw new Error(`The sign-in didn't take it (${res.status}). Start it again from Agent setup.`)
  return { ok: true }
}

setInterval(() => {
  for (const c of chats.values()) if (c.status === 'idle' && !c.pending.size && !c.turn && Date.now() - c.lastActive > IDLE_CLOSE_MS) void stopChat(c)
}, 60_000).unref()
