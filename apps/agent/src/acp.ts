// The Agent Client Protocol (agentclientprotocol.com, protocol version 1): how DevDash drives coding agents other than
// Claude Code (OpenCode today; Gemini CLI, Codex, Goose and others speak it too). JSON-RPC 2.0 over the agent's
// stdin/stdout, one message per line. DevDash is the client: it opens sessions, sends prompts and answers permission
// requests. It offers the agent no file system or terminal of its own: the agent works with its own tools, as the member.
//
// What the agent reports is turned into the same messages Claude Code's SDK sends (assistant/user/result, stream_event
// deltas), because that is the transcript format the server and the web already store and show.
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export const PROTOCOL_VERSION = 1

type Handlers = {
  notify: (method: string, params: Record<string, unknown>) => void
  /** Requests the agent makes of DevDash (permission questions); anything else is answered "method not found". */
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}
type Message = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }

/** One JSON-RPC connection to an agent process. */
export class Rpc {
  private next = 1
  private calls = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  closed = false
  private child: ChildProcess
  private on: Handlers

  constructor(child: ChildProcess, on: Handlers) {
    this.child = child
    this.on = on
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(line))
    child.on('exit', () => {
      this.closed = true
      for (const c of this.calls.values()) c.reject(new Error('The agent stopped.'))
      this.calls.clear()
    })
  }

  receive(line: string) {
    let m: Message
    try {
      m = JSON.parse(line) as Message
    } catch {
      return // not protocol: a stray log line
    }
    if (m.method && m.id !== undefined) {
      const id = m.id
      this.on.request(m.method, m.params ?? {}).then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: Error & { code?: number }) => this.write({ jsonrpc: '2.0', id, error: { code: err.code ?? -32603, message: err.message } }),
      )
    } else if (m.method) {
      this.on.notify(m.method, m.params ?? {})
    } else if (m.id !== undefined) {
      const c = this.calls.get(m.id)
      if (!c) return
      this.calls.delete(m.id)
      if (m.error) c.reject(new Error(m.error.message || `The agent answered with error ${m.error.code ?? ''}`.trim()))
      else c.resolve(m.result)
    }
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The agent stopped.'))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(m: Message) {
    if (!this.closed && this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(m)}\n`)
  }
}

/** "Method not found", for what DevDash doesn't offer agents (fs/*, terminal/*). */
export const notFound = (method: string) => Object.assign(new Error(`DevDash does not offer ${method}`), { code: -32601 })

// ---- From ACP's session updates to Claude Code's message shapes ----------------------------------------------------

export type ToolCall = {
  toolCallId: string
  title?: string
  /** The agent's own name for the tool (ACP's tool `name`), e.g. OpenCode's "bash", "edit". */
  name?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  content?: { type: string; content?: { type: string; text?: string }; path?: string; oldText?: string | null; newText?: string }[]
  locations?: { path: string; line?: number }[]
  _meta?: Record<string, unknown>
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  return undefined
}
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * A tool call as the Claude Code tool the web knows how to show (and the guest gate how to judge): Bash, Read, Edit,
 * Write, Grep, Glob, LS, WebFetch, WebSearch, TodoWrite, Task, MCP tools as mcp__<server>__<tool>. Agents name their
 * tools their own way (OpenCode: bash, read, edit; Gemini: run_shell_command, read_file), so the agent's name and its
 * ACP kind both count. What isn't recognised keeps its own name and input, and shows as a generic step.
 * `mcpServers`: the MCP servers DevDash gave the session, whose tools agents name "<server>_<tool>".
 */
export function claudeTool(t: ToolCall, mcpServers: string[] = []): { name: string; input: Record<string, unknown> } {
  const i = (t.rawInput ?? {}) as Record<string, unknown>
  const raw = (t.name ?? '').trim()
  const n = raw.toLowerCase()
  const diff = t.content?.find((c) => c.type === 'diff')
  const path = str(pick(i, 'filePath', 'file_path', 'absolute_path', 'path', 'file')) ?? diff?.path ?? t.locations?.[0]?.path
  const server = mcpServers.find((s) => n.startsWith(`${s.toLowerCase()}_`))
  if (server) {
    // DevDash's own tools carry the name Claude Code gives them as a plugin, so they look and are gated the same.
    const prefix = server === 'devdash' ? 'mcp__plugin_devdash_devdash__' : `mcp__${server}__`
    return { name: `${prefix}${raw.slice(server.length + 1)}`, input: i }
  }
  if (['bash', 'shell', 'run_shell_command', 'execute', 'exec', 'command'].includes(n) || (!n && t.kind === 'execute')) {
    return { name: 'Bash', input: defined({ command: str(pick(i, 'command', 'cmd')) ?? t.title ?? '', description: str(pick(i, 'description')) }) }
  }
  if (['read', 'read_file', 'view', 'cat'].includes(n) || (!n && t.kind === 'read')) {
    return { name: 'Read', input: defined({ file_path: path ?? t.title ?? '', offset: pick(i, 'offset', 'line'), limit: pick(i, 'limit') }) }
  }
  if (['write', 'write_file', 'create'].includes(n)) {
    return { name: 'Write', input: { file_path: path ?? '', content: str(pick(i, 'content')) ?? diff?.newText ?? '' } }
  }
  if (['edit', 'replace', 'str_replace', 'edit_file'].includes(n) || (!n && t.kind === 'edit' && diff)) {
    return {
      name: 'Edit',
      input: defined({
        file_path: path ?? '', old_string: str(pick(i, 'oldString', 'old_string', 'old')) ?? diff?.oldText ?? '',
        new_string: str(pick(i, 'newString', 'new_string', 'new')) ?? diff?.newText ?? '', replace_all: pick(i, 'replaceAll', 'replace_all'),
      }),
    }
  }
  if (['grep', 'search_file_content', 'search', 'rg'].includes(n) || (!n && t.kind === 'search' && pick(i, 'pattern'))) {
    return { name: 'Grep', input: defined({ pattern: str(pick(i, 'pattern', 'query')) ?? t.title ?? '', path: str(pick(i, 'path', 'dir_path')), glob: str(pick(i, 'include', 'glob')) }) }
  }
  if (['glob', 'find', 'find_files'].includes(n)) return { name: 'Glob', input: defined({ pattern: str(pick(i, 'pattern')) ?? '', path: str(pick(i, 'path', 'dir_path')) }) }
  if (['list', 'ls', 'list_directory'].includes(n)) return { name: 'LS', input: { path: path ?? str(pick(i, 'path', 'dir_path')) ?? '' } }
  if (['webfetch', 'web_fetch', 'fetch'].includes(n) || (!n && t.kind === 'fetch')) return { name: 'WebFetch', input: defined({ url: str(pick(i, 'url')) ?? t.title ?? '', prompt: str(pick(i, 'prompt')) }) }
  if (['websearch', 'web_search', 'google_web_search', 'codesearch'].includes(n)) return { name: 'WebSearch', input: { query: str(pick(i, 'query')) ?? t.title ?? '' } }
  if (['todowrite', 'write_todos', 'todo_write'].includes(n) && Array.isArray(i.todos)) return { name: 'TodoWrite', input: { todos: todosOf(i.todos) } }
  if (n === 'question' && Array.isArray(i.questions)) return { name: 'AskUserQuestion', input: { questions: i.questions } }
  if (['task', 'agent', 'subagent'].includes(n)) {
    return { name: 'Task', input: defined({ description: str(pick(i, 'description')) ?? t.title ?? '', prompt: str(pick(i, 'prompt')), subagent_type: str(pick(i, 'subagent_type', 'subagentType', 'agent')) }) }
  }
  return { name: raw || t.title || 'Tool', input: Object.keys(i).length ? i : defined({ description: t.title }) }
}

/** To-do lists in Claude Code's TodoWrite shape: content, status, and the text shown while it's in progress. */
export function todosOf(list: unknown[]): { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[] {
  return list.flatMap((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    const content = str(o.content) ?? str(o.description) ?? str(o.text)
    if (!content) return []
    const s = str(o.status)
    const status = s === 'completed' || s === 'done' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending'
    return [{ content, status, activeForm: content }]
  })
}

/** What a finished tool call returned, as text: its text content, else its raw output. Long output is cut. */
export function toolOutput(t: ToolCall): string {
  const text = (t.content ?? []).flatMap((c) => (c.type === 'content' && c.content?.type === 'text' && c.content.text ? [c.content.text] : [])).join('\n')
  const diffs = (t.content ?? []).filter((c) => c.type === 'diff').map((c) => `Edited ${c.path}`)
  let out = text || diffs.join('\n')
  if (!out && t.rawOutput !== undefined) {
    const r = t.rawOutput as Record<string, unknown> | string
    out = typeof r === 'string' ? r : str(r?.output) ?? str(r?.error) ?? JSON.stringify(r)
  }
  return out.length > 60_000 ? `${out.slice(0, 60_000)}\n… (cut: ${out.length.toLocaleString('en')} characters in all)` : out
}

export type Usage = { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number }

/**
 * Builds Claude-shaped transcript messages from one session's ACP updates. Text and thinking stream as stream_event
 * deltas (live only) and are written out as one assistant message when the agent moves on (a tool call, a new message,
 * the end of the turn). A tool call becomes an assistant tool_use once its input is known, and a user tool_result when
 * it finishes. A plan becomes a TodoWrite step. `emit(msg, live)`: live-only messages aren't kept in the transcript.
 */
export class Transcriber {
  private text = ''
  private thought = ''
  private messageId: string | undefined
  private tools = new Map<string, ToolCall & { used?: boolean; done?: boolean }>()
  private plans = 0
  private claimed = new Set<string>()
  /** The turn's last words, for the result. */
  lastText = ''
  /** Tool calls this turn: the result's step count. */
  steps = 0

  private emit: (msg: Record<string, unknown>, live?: boolean) => void
  /** `parent`: a subagent's transcriber, whose messages nest under the parent's Task step with that tool id. */
  private o: { model: () => string | null; mcpServers: string[]; sessionId: string; parent?: string }

  constructor(emit: (msg: Record<string, unknown>, live?: boolean) => void, o: { model: () => string | null; mcpServers: string[]; sessionId: string; parent?: string }) {
    this.emit = emit
    this.o = o
  }

  update(u: Record<string, unknown>) {
    const kind = u.sessionUpdate
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const c = u.content as { type?: string; text?: string } | undefined
      if (c?.type !== 'text' || !c.text) return
      const id = str(u.messageId)
      if (id && this.messageId && id !== this.messageId) this.flush()
      if (id) this.messageId = id
      if (kind === 'agent_thought_chunk') {
        if (this.text) this.flush() // thinking after text starts the next message
        this.thought += c.text
        return
      }
      this.text += c.text
      if (!this.o.parent) this.emit({ type: 'stream_event', parent_tool_use_id: null, session_id: this.o.sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: c.text } } }, true)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.tool(u as unknown as ToolCall)
    } else if (kind === 'plan' && Array.isArray(u.entries)) {
      this.flush()
      const id = `plan-${this.o.sessionId.slice(0, 8)}-${++this.plans}-${randomUUID().slice(0, 8)}`
      this.assistant(`tool-${id}`, [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: todosOf(u.entries) } }])
      this.result(id, 'The to-do list is updated.', false)
    }
  }

  /** A user message replayed by session/load (a turn typed in the agent's own terminal app). */
  userText(text: string, id?: string) {
    this.flush()
    this.emit({ type: 'user', uuid: id ?? randomUUID(), parent_tool_use_id: null, session_id: this.o.sessionId, message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  private tool(t: ToolCall) {
    const was = this.tools.get(t.toolCallId)
    const now = { ...was, ...defined(t as unknown as Record<string, unknown>) } as ToolCall & { used?: boolean; done?: boolean }
    this.tools.set(t.toolCallId, now)
    if (!was) this.flush()
    // An input that only says where it runs (OpenCode's first notice of a shell call) isn't the call yet.
    const known = !!now.rawInput && Object.keys(now.rawInput).some((k) => !['cwd', 'workdir', 'directory'].includes(k))
    const finished = now.status === 'completed' || now.status === 'failed'
    if (!now.used && (known || finished || now.status === 'in_progress')) {
      now.used = true
      this.steps++
      const { name, input } = claudeTool(now, this.o.mcpServers)
      this.assistant(`tool-${now.toolCallId}`, [{ type: 'tool_use', id: now.toolCallId, name, input }])
    }
    if (finished && !now.done) {
      now.done = true
      this.result(now.toolCallId, toolOutput(now), now.status === 'failed')
    }
  }

  /** The newest Task step that no subagent has claimed yet: where a new child session's activity goes. */
  claimTask(): string | null {
    const open = [...this.tools.values()].filter((t) => t.used && !t.done && !this.claimed.has(t.toolCallId) && claudeTool(t, this.o.mcpServers).name === 'Task')
    const id = open.at(-1)?.toolCallId ?? null
    if (id) this.claimed.add(id)
    return id
  }

  /** The tool call a permission request is about, as the Claude Code tool the person is asked to allow. */
  describe(t: ToolCall) {
    const was = this.tools.get(t.toolCallId)
    return claudeTool({ ...was, ...defined(t as unknown as Record<string, unknown>) } as ToolCall, this.o.mcpServers)
  }

  /** Writes out the text and thinking so far as one assistant message. */
  flush() {
    const content: Record<string, unknown>[] = []
    if (this.thought.trim()) content.push({ type: 'thinking', thinking: this.thought })
    if (this.text.trim()) content.push({ type: 'text', text: this.text })
    if (this.text.trim()) this.lastText = this.text.trim()
    this.text = this.thought = ''
    if (!content.length) return
    this.assistant(`${this.messageId ?? 'msg'}-${randomUUID().slice(0, 8)}`, content)
    this.messageId = undefined
  }

  /** The end of a turn: anything still unsaid, unfinished tool steps closed, and the result Claude Code would send. */
  end(o: { stopReason: string; durationMs: number; costUsd: number | null; usage?: Usage | null; error?: string; fresh: boolean }) {
    this.flush()
    for (const t of this.tools.values()) {
      if (t.used && !t.done) {
        t.done = true
        this.result(t.toolCallId, o.stopReason === 'cancelled' ? 'Stopped.' : 'No result.', true)
      }
    }
    this.tools.clear()
    const ok = !o.error && o.stopReason !== 'refusal' && o.stopReason !== 'cancelled'
    const u = o.usage ?? {}
    this.emit({
      type: 'result', uuid: randomUUID(), session_id: this.o.sessionId,
      subtype: ok ? 'success' : 'error_during_execution', is_error: !ok && o.stopReason !== 'cancelled',
      result: o.error ?? (o.stopReason === 'refusal' ? 'The model refused to answer.' : this.lastText),
      ...(o.stopReason === 'cancelled' ? { terminal_reason: 'aborted_by_user' } : {}),
      duration_ms: o.durationMs, num_turns: this.steps,
      ...(o.costUsd !== null ? { total_cost_usd: o.costUsd } : {}),
      usage: {
        input_tokens: u.inputTokens ?? 0, output_tokens: (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0),
        cache_read_input_tokens: u.cachedReadTokens ?? 0, cache_creation_input_tokens: u.cachedWriteTokens ?? 0,
      },
      devdash_fresh: o.fresh,
    })
    this.lastText = ''
    this.steps = 0
  }

  private assistant(uuid: string, content: Record<string, unknown>[]) {
    this.emit({ type: 'assistant', uuid, parent_tool_use_id: this.o.parent ?? null, session_id: this.o.sessionId, message: { id: uuid, role: 'assistant', model: this.o.model() ?? undefined, content } })
  }

  private result(id: string, text: string, isError: boolean) {
    this.emit({ type: 'user', uuid: `result-${id}`, parent_tool_use_id: this.o.parent ?? null, session_id: this.o.sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } })
  }
}
