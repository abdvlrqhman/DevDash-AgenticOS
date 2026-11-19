// T3 Code's Streamable HTTP MCP transport. Credentials belong to this Linux member,
// never to the shared DevDash server or another user's T3 data directory.
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { memberFetch, validateMemberUrl } from './t3-local.ts'

export type T3Config = { url: string; token: string; baseDir?: string }
export const configPath = () => process.env.DEVDASH_T3_CONFIG ?? join(homedir(), '.config', 'devdash', 't3code.json')

export function validateConfig(value: unknown): T3Config {
  const c = value as Partial<T3Config> | null
  const url = validateMemberUrl(typeof c?.url === 'string' ? c.url : '')
  if (typeof c?.token !== 'string' || !c.token.trim() || /[\r\n]/.test(c.token)) throw new Error('T3 Code needs a bearer token.')
  return { url: url.toString(), token: c.token.trim(), ...(typeof c.baseDir === 'string' && isAbsolute(c.baseDir) ? { baseDir: c.baseDir } : {}) }
}

export function readConfig(): T3Config {
  let raw: unknown
  try {
    const file = lstatSync(configPath())
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new Error('unsafe config permissions')
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch { throw new Error(`Connect T3 Code in ${configPath()} with its MCP URL and bearer token.`) }
  return validateConfig(raw)
}

export class T3RequestError extends Error {
  mayHaveExecuted: boolean
  constructor(message: string, mayHaveExecuted = true) { super(message); this.mayHaveExecuted = mayHaveExecuted }
}

type RpcReply = { id?: number; result?: unknown; error?: { code?: number; message?: string } }
type ToolResult = { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean }

export class T3Client {
  serverVersion: string | null = null
  private config: T3Config
  private timeoutMs: number
  private signal?: AbortSignal
  private session: string | null = null
  private protocol = '2025-06-18'
  private nextId = 1
  private connecting: Promise<void> | null = null
  private connected = false

  constructor(config: T3Config = readConfig(), options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    this.config = validateConfig(config)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signal = options.signal
  }

  private clean(message: string): string {
    return message.replaceAll(this.config.token, '[redacted]').slice(0, 500)
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`, Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json', 'mcp-protocol-version': this.protocol,
      ...(this.session ? { 'mcp-session-id': this.session } : {}),
    }
  }

  /** No retries: a lost response may already have created a project or sent a prompt. */
  private async request(method: string, params: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++
    try {
      const response = await memberFetch(this.config.url, {
        method: 'POST', headers: this.headers(), signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]),
        body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new T3RequestError(`T3 Code MCP returned HTTP ${response.status}.`, response.status >= 500 || response.status === 408) }
      const session = response.headers.get('mcp-session-id')
      if (session) this.session = session
      if (notification) { await response.body?.cancel(); return undefined }
      const reply = response.headers.get('content-type')?.includes('text/event-stream')
        ? await this.eventReply(response, id!)
        : await response.json() as RpcReply
      if (reply.id !== id) throw new Error('T3 Code returned a mismatched MCP response.')
      if (reply.error) throw new T3RequestError(`T3 Code MCP: ${this.clean(reply.error.message ?? 'request failed')}`, false)
      return reply.result
    } catch (err) {
      if (err instanceof Error && /^(TimeoutError|AbortError)$/.test(err.name)) throw new T3RequestError('T3 Code MCP request timed out. Check the thread in T3 Code before retrying.')
      if (err instanceof Error && err.message.startsWith('T3 Code')) throw err
      throw new T3RequestError('Could not connect to T3 Code MCP. Check its URL, token and server status.')
    }
  }

  /** MCP may keep the SSE stream open after replying; consume only our matching JSON-RPC response. */
  private async eventReply(response: Response, id: number): Promise<RpcReply> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('T3 Code returned an empty MCP response.')
    const decoder = new TextDecoder()
    let pending = '', size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        pending = (pending + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n')
        size += chunk.value?.length ?? 0
        if (size > 8 * 1024 * 1024) throw new Error('T3 Code MCP response was too large.')
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end); pending = pending.slice(end + 2)
          const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
          if (!data) continue
          let reply: RpcReply
          try { reply = JSON.parse(data) as RpcReply } catch { continue }
          if (reply.id === id) return reply
        }
        if (chunk.done) break
      }
      throw new Error('T3 Code MCP stream ended without a response.')
    } finally { await reader.cancel().catch(() => {}) }
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const initialized = await this.request('initialize', {
        protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'DevDash', version: '1' },
      }) as { protocolVersion?: string; serverInfo?: { version?: string } }
      if (initialized?.protocolVersion) this.protocol = initialized.protocolVersion
      this.serverVersion = initialized?.serverInfo?.version ?? null
      await this.request('notifications/initialized', {}, true)
      this.connected = true
    })()
    try { await this.connecting } finally { this.connecting = null }
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.connect()
    const result = await this.request('tools/call', { name, arguments: args }) as ToolResult
    if (result?.isError) {
      const detail = result.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
      throw new T3RequestError(`T3 Code tool ${name} failed${detail ? `: ${this.clean(detail)}` : '.'}`, false)
    }
    if (result && Object.hasOwn(result, 'structuredContent')) return result.structuredContent as T
    const text = result?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    try { return JSON.parse(text ?? '') as T } catch { throw new Error(`T3 Code tool ${name} returned no structured result.`) }
  }

  async close(): Promise<void> {
    const session = this.session
    if (!session) { this.connected = false; return }
    try {
      const response = await memberFetch(this.config.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 250)) })
      await response.body?.cancel()
    } catch { /* A stopped server or expired session is already closed. */ }
    this.session = null
    this.connected = false
  }
}
