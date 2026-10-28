import type { IncomingMessage, Server } from 'node:http'
import { STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import { parse as parseCookies } from 'hono/utils/cookie'
import { WebSocketServer, type WebSocket } from 'ws'
import type { User } from '../modules/auth/repo.ts'
import type { AuthService } from '../modules/auth/service.ts'
import { AppError } from './http.ts'

export type WsContext = { user: User; sessionToken: string; url: URL; match: RegExpExecArray }
type Route = { re: RegExp; handle: (ws: WebSocket, ctx: WsContext) => void; check?: (ctx: WsContext) => void | Promise<void> }

/**
 * All WebSocket endpoints go through here. Before an upgrade is accepted: exact Origin match (cross-site WebSocket
 * hijacking) and a valid session cookie; then the route's own check. Every socket gets a ping every 30 s, because
 * Cloudflare closes idle WebSockets after ~100 s.
 */
export function wsRouter(server: Server, deps: { auth: AuthService; origin: string; other?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const routes: Route[] = []

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {}) // a client hanging up mid-handshake must never take the server down
    if (deps.other?.(req, socket, head)) return // e.g. a service preview's own WebSocket
    const reject = (code: number) =>
      socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let route: Route | undefined
      let match: RegExpExecArray | null = null
      for (const r of routes) if ((match = r.re.exec(url.pathname))) { route = r; break }
      if (!route || !match) return reject(404)
      if (req.headers.origin !== deps.origin) return reject(403)
      const token = parseCookies(req.headers.cookie ?? '', '__Host-devdash')['__Host-devdash']
      const session = deps.auth.sessionUser(token)
      if (!session) return reject(401)
      const ctx: WsContext = { user: session.user, sessionToken: token!, url, match }
      try {
        await route.check?.(ctx)
      } catch (err) {
        return reject(err instanceof AppError ? err.status : 500)
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const ping = setInterval(() => ws.ping(), 30_000)
        ws.on('close', () => clearInterval(ping))
        route.handle(ws, ctx)
      })
    })()
  })

  return {
    route(re: RegExp, handle: Route['handle'], check?: Route['check']) {
      routes.push({ re, handle, check })
    },
  }
}

export type WsRouter = ReturnType<typeof wsRouter>

/** Pipes a browser WebSocket to an agent attach stream (JSON lines), re-serializing client frames. */
export function bridgeToAgent(ws: WebSocket, agent: import('node:net').Socket) {
  let buf = ''
  agent.setEncoding('utf8')
  agent.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      ws.send(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  agent.on('error', () => ws.close(1011, 'agent unavailable'))
  agent.on('close', () => ws.close(1000))
  ws.on('message', (data) => {
    let m: { d?: unknown; r?: unknown }
    try {
      m = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof m.d === 'string') agent.write(JSON.stringify({ d: m.d }) + '\n')
    else if (Array.isArray(m.r) && m.r.length === 2 && m.r.every(Number.isInteger)) agent.write(JSON.stringify({ r: m.r }) + '\n')
  })
  ws.on('close', () => agent.destroy())
}
