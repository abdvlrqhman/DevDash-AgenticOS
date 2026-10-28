import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'

export type AgentEvent = { ev: string; id?: string; [k: string]: unknown }

/**
 * Connections to members' agents (apps/agent). Requests are short-lived; each member also has one long-lived
 * event connection. The server picks which socket to open, so an event's member is known without any token.
 */
export function agentsService({ runDir }: { runDir: string }) {
  const path = (username: string) => {
    if (!runDir) throw new AppError(409, 'no_host', 'This needs DevDash running on its Linux server.')
    return join(runDir, `agent-${username}.sock`)
  }
  const handlers = new Set<(username: string, ev: AgentEvent) => void>()
  // Calls from a member's own processes (e.g. the `devdash service` command), relayed by their agent.
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  async function answerRpc(username: string, sock: Socket, ev: AgentEvent) {
    let reply: object
    try {
      const fn = rpcs.get(String(ev.method))
      if (!fn) throw new AppError(400, 'unknown_method', `Unknown request ${String(ev.method)}.`)
      reply = { rpc: ev.rpc, result: (await fn(username, ev.params)) ?? {} }
    } catch (err) {
      if (!(err instanceof AppError)) console.error(`rpc ${String(ev.method)} for ${username}:`, err)
      reply = { rpc: ev.rpc, error: err instanceof AppError ? err.message : 'Something went wrong on the DevDash server.' }
    }
    if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n')
  }
  const watched = new Map<string, { sock?: Socket; stop: boolean }>()

  async function request<T = Record<string, unknown>>(username: string, msg: object, timeoutMs = 60_000): Promise<T> {
    let res: { error?: string } & T
    try {
      res = await requestLine(path(username), msg, timeoutMs)
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(409, 'agent_unavailable', 'Your server account is not reachable right now. Try again in a minute.')
    }
    if (res.error) throw new AppError(400, 'agent_error', res.error)
    return res
  }

  /** Keeps an event connection to this member's agent, reconnecting with backoff. */
  function watch(username: string) {
    if (!runDir || watched.has(username)) return
    const w: { sock?: Socket; stop: boolean } = { stop: false }
    watched.set(username, w)
    let delay = 1000
    const open = () => {
      if (w.stop) return
      const sock = connect(path(username))
      w.sock = sock
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        delay = 1000
        sock.write(JSON.stringify({ op: 'subscribe' }) + '\n')
      })
      sock.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try {
            const ev = JSON.parse(line) as AgentEvent
            if (ev.ev === 'rpc') void answerRpc(username, sock, ev)
            else for (const h of handlers) h(username, ev)
          } catch (err) {
            console.error(`agent ${username} event:`, (err as Error).message)
          }
        }
      })
      sock.on('error', () => {})
      sock.on('close', () => {
        if (w.stop) return
        setTimeout(open, delay)
        delay = Math.min(30_000, delay * 2)
      })
    }
    open()
  }

  return {
    request,
    /** Streaming connection (attach); the caller writes and reads JSON lines. */
    open(username: string, msg: object): Socket {
      const sock = connect(path(username))
      sock.write(JSON.stringify(msg) + '\n')
      return sock
    },
    onEvent: (fn: (username: string, ev: AgentEvent) => void) => void handlers.add(fn),
    onRpc: (method: string, fn: (username: string, params: unknown) => unknown) => void rpcs.set(method, fn),
    watch,
    /** After a deploy: agents restart once no Chat turn is running (apps/agent/src/main.ts). */
    async upgradeAll(usernames: string[]) {
      for (const u of usernames) await request(u, { op: 'upgrade' }, 10_000).catch(() => {})
    },
  }
}

export type AgentsService = ReturnType<typeof agentsService>
