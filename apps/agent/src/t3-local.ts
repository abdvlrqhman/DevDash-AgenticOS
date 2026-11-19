// A T3 connection must stay inside the DevDash member's Linux authority. A token's label is not user isolation.
import { readFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { Readable } from 'node:stream'

/** Require a literal loopback endpoint; DNS, proxies and remote servers cannot establish the Linux user boundary. */
export function validateMemberUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('T3 Code needs a local MCP URL.') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
    throw new Error('T3 Code must use http://127.0.0.1:<port>/mcp on this member’s own local instance.')
  }
  return url
}

export function assertRegularMemberUid(uid: number | undefined): number {
  if (uid === undefined || !Number.isInteger(uid) || uid < 1000 || uid >= 65534) {
    throw new Error('T3 Code connections must run as a regular DevDash member, never root or a system account.')
  }
  return uid
}

/** LISTEN sockets which can accept 127.0.0.1:port, including dual-stack wildcard/IPv4-mapped listeners. */
export function listenerUids(tcp: string, tcp6: string, port: number): number[] {
  const addresses = new Set(['0100007F', '00000000', '00000000000000000000000000000000', '0000000000000000FFFF00000100007F'])
  const owners: number[] = []
  for (const line of `${tcp}\n${tcp6}`.split('\n')) {
    const row = line.trim().split(/\s+/)
    const local = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(row[1] ?? '')
    if (row[3] !== '0A' || !local || Number.parseInt(local[2]!, 16) !== port || !addresses.has(local[1]!.toUpperCase())) continue
    if (!/^\d+$/.test(row[7] ?? '')) throw new Error('Cannot verify the T3 Code listener owner.')
    owners.push(Number(row[7]))
  }
  return owners
}

export function assertOwnedListener(tcp: string, tcp6: string, port: number, uid: number): void {
  assertRegularMemberUid(uid)
  const owners = listenerUids(tcp, tcp6, port)
  if (!owners.length) throw new Error('No local T3 Code listener is running at this address.')
  if (owners.some((owner) => owner !== uid)) {
    throw new Error('The T3 Code instance belongs to root or another Linux user. Start a separate instance as this DevDash member.')
  }
}

async function socketTables(): Promise<[string, string]> {
  if (process.platform !== 'linux') throw new Error('T3 Code member isolation currently requires Linux socket ownership checks.')
  try {
    return await Promise.all([
      readFile('/proc/net/tcp', 'utf8'),
      readFile('/proc/net/tcp6', 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      }),
    ])
  } catch { throw new Error('Cannot verify the local T3 Code socket owner. The connection was refused.') }
}

/** Recheck before every request carrying credentials, not just once when a config is saved. */
export async function assertMemberEndpoint(raw: string): Promise<void> {
  const url = validateMemberUrl(raw)
  const uid = assertRegularMemberUid(process.getuid?.())
  const [tcp, tcp6] = await socketTables()
  assertOwnedListener(tcp, tcp6, Number(url.port || 80), uid)
}

/** Check the connected server's reverse tuple, so rebinding the port after preflight cannot steal credentials. */
export function assertOwnedConnection(tcp: string, tcp6: string, serverPort: number, clientPort: number, uid: number): void {
  assertRegularMemberUid(uid)
  const addresses = new Set(['0100007F', '0000000000000000FFFF00000100007F'])
  const owners: number[] = []
  for (const line of `${tcp}\n${tcp6}`.split('\n')) {
    const row = line.trim().split(/\s+/)
    const local = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(row[1] ?? '')
    const remote = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(row[2] ?? '')
    if (row[3] !== '01' || !local || !remote || !addresses.has(local[1]!.toUpperCase()) || !addresses.has(remote[1]!.toUpperCase())) continue
    if (Number.parseInt(local[2]!, 16) !== serverPort || Number.parseInt(remote[2]!, 16) !== clientPort) continue
    if (!/^\d+$/.test(row[7] ?? '')) throw new Error('Cannot verify the connected T3 Code peer owner.')
    owners.push(Number(row[7]))
  }
  if (!owners.length || owners.some((owner) => owner !== uid)) throw new Error('The connected T3 Code peer is not owned by this Linux member. No credentials were sent.')
}

export async function assertMemberConnection(socket: Socket): Promise<void> {
  const uid = assertRegularMemberUid(process.getuid?.())
  if (socket.remoteAddress !== '127.0.0.1' || !socket.remotePort || !socket.localPort) throw new Error('T3 Code requires a verified member-owned loopback connection.')
  const [tcp, tcp6] = await socketTables()
  assertOwnedConnection(tcp, tcp6, socket.remotePort, socket.localPort, uid)
}

type MemberRequest = { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
/** HTTP with ownership checked after TCP connect and before the Agent can send any headers or body. */
export async function memberFetch(raw: string, init: MemberRequest): Promise<Response> {
  const url = new URL(raw)
  if (url.search || url.hash || !(url.pathname === '/mcp' || url.pathname.startsWith('/oauth/mcp/'))) throw new Error('Unsupported local T3 Code endpoint.')
  return ownedFetch(url, init)
}

/** Only the stateless text and model catalog operations of a locally spawned OpenCode server. */
export function openCodeMemberFetch(url: URL, init: MemberRequest): Promise<Response> {
  if (!['/api/experimental/generate/text', '/api/model'].includes(url.pathname) || url.search || url.hash) throw new Error('Unsupported supervisor operation.')
  return ownedFetch(url, init, true)
}

async function ownedFetch(url: URL, init: MemberRequest, deferredAccept = false): Promise<Response> {
  const endpoint = new URL('/mcp', url).href
  await assertMemberEndpoint(endpoint)
  if (init.signal?.aborted) throw init.signal.reason
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = (_options, callback) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port || 80) })
    let handedOff = false
    const aborted = () => finish(new DOMException('The operation was aborted.', 'AbortError'))
    const finish = (error: Error | null) => {
      if (handedOff) return
      handedOff = true
      init.signal?.removeEventListener('abort', aborted)
      socket.removeListener('error', failed)
      if (error) socket.destroy()
      callback!(error, socket)
    }
    const failed = (error: Error) => finish(error)
    socket.once('error', failed)
    init.signal?.addEventListener('abort', aborted, { once: true })
    socket.once('connect', () => {
      // OpenCode's Linux listener defers accept until the first byte. One empty HTTP line lets the
      // kernel establish the reverse tuple; ownership is still checked before any headers or body.
      if (deferredAccept) socket.write('\r\n')
      void assertMemberConnection(socket).then(() => finish(null), (error: Error) => finish(error))
    })
    if (init.signal?.aborted) aborted()
    // Returning the socket here would let http write credentials before asynchronous ownership verification.
    return undefined
  }
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init.method, headers: init.headers, agent, signal: init.signal }, (incoming) => {
      const headers = new Headers()
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!)
      const abort = () => incoming.destroy(new DOMException('The operation was aborted.', 'AbortError'))
      init.signal?.addEventListener('abort', abort, { once: true })
      incoming.once('close', () => { init.signal?.removeEventListener('abort', abort); agent.destroy() })
      const status = incoming.statusCode ?? 500
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ConstructorParameters<typeof Response>[0]
      resolve(new Response(body, { status, headers }))
    })
    req.once('error', (error) => { agent.destroy(); reject(error) })
    req.end(init.body)
  })
}
