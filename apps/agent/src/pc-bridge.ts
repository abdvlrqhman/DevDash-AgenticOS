import { socksConnect } from './tailnet-session.ts'
import * as tailscale from './tailscale.ts'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024 // 16 MiB (screenshots + UIA trees)
const STATUS_CACHE_MS = 2_000

/** True only for RFC 6598 CGNAT IPv4 addresses used by Tailscale (100.64.0.0/10). */
export function isTailscaleIp(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  if (nums.some((n) => n < 0 || n > 255)) return false
  return nums[0] === 100 && nums[1]! >= 64 && nums[1]! <= 127
}

export type PcRequestInput = {
  targetIp: string
  port: number
  token: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  timeoutMs?: number
  fresh?: boolean
}

export type PcRequestResult = {
  httpStatus: number
  data: unknown
}

let cachedStatus: { at: number; status: tailscale.Status } | null = null

async function liveTailscaleStatus(fresh = false): Promise<tailscale.Status> {
  const now = Date.now()
  if (!fresh && cachedStatus && now - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.status
  }
  const status = await tailscale.status()
  cachedStatus = { at: now, status }
  return status
}

export function clearTailscaleStatusCache() {
  cachedStatus = null
}

/**
 * Pure parser for a single HTTP/1.1 response received over a SOCKS5 TCP socket (`Connection: close`).
 * Supports both Content-Length and chunked transfer encoding.
 */
export function parseHttpResponse(raw: Buffer): PcRequestResult {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep < 0) throw new Error('PC agent returned an incomplete HTTP response.')
  const head = raw.subarray(0, sep).toString('latin1')
  const lines = head.split('\r\n')
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(lines[0] ?? '')
  if (!statusMatch) throw new Error('PC agent returned an unreadable HTTP status.')
  const httpStatus = Number(statusMatch[1])
  const headers: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(':')
    if (idx > 0) {
      headers[lines[i]!.slice(0, idx).trim().toLowerCase()] = lines[i]!.slice(idx + 1).trim()
    }
  }
  let bodyBuf = raw.subarray(sep + 4)
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    const chunks: Buffer[] = []
    let pos = 0
    while (pos < bodyBuf.length) {
      const crlf = bodyBuf.indexOf('\r\n', pos)
      if (crlf < 0) break
      const sizeStr = bodyBuf.subarray(pos, crlf).toString('latin1').split(';')[0]!.trim()
      const size = Number.parseInt(sizeStr, 16)
      if (!Number.isFinite(size) || size <= 0) break
      pos = crlf + 2
      chunks.push(bodyBuf.subarray(pos, pos + size))
      pos += size + 2
    }
    bodyBuf = Buffer.concat(chunks)
  } else if (headers['content-length']) {
    const len = Number(headers['content-length'])
    if (Number.isFinite(len) && len >= 0 && bodyBuf.length > len) {
      bodyBuf = bodyBuf.subarray(0, len)
    }
  }
  const text = bodyBuf.toString('utf8')
  const ct = (headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return { httpStatus, data: JSON.parse(text) }
    } catch {
      return { httpStatus, data: { error: text || `HTTP ${httpStatus}` } }
    }
  }
  return { httpStatus, data: text }
}

/**
 * Tailscale-only HTTP/1.1 request to the member's Windows PC Computer Use agent.
 * Refuses immediately if Tailscale is stopped or the target PC peer is offline.
 */
export async function pcRequest(input: PcRequestInput): Promise<PcRequestResult> {
  const targetIp = String(input.targetIp ?? '').trim()
  const port = Number(input.port)
  const token = String(input.token ?? '')
  const method = input.method === 'GET' ? 'GET' : 'POST'
  const path = String(input.path ?? '/health')
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30_000, 2_000), 120_000)

  if (!isTailscaleIp(targetIp)) {
    throw new Error('PC target must be a Tailscale IPv4 address (100.64.0.0/10).')
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PC port must be between 1024 and 65535.')
  }
  if (!token) {
    throw new Error('Missing PC authentication token.')
  }
  if (!path.startsWith('/') || /[\r\n\s]/.test(path)) {
    throw new Error('Invalid PC request path.')
  }

  let ts = await liveTailscaleStatus(input.fresh === true)
  let peer = ts.devices.find((d) => d.ip === targetIp)
  // If cached status showed offline, do one live check before refusing.
  if ((!ts.running || ts.backendState !== 'Running' || !peer?.online) && !input.fresh) {
    ts = await liveTailscaleStatus(true)
    peer = ts.devices.find((d) => d.ip === targetIp)
  }
  if (!ts.running || ts.backendState !== 'Running' || !ts.socksPort) {
    throw new Error('Your DevDash Tailscale node is offline. Connect Tailscale in Network first.')
  }
  if (!peer) {
    throw new Error(`Device ${targetIp} is not on your Tailscale tailnet.`)
  }
  if (!peer.online) {
    throw new Error(`${peer.name || targetIp} is offline on Tailscale. Connect Tailscale on your PC to use it.`)
  }

  const payload = method === 'POST' && input.body !== undefined ? Buffer.from(JSON.stringify(input.body), 'utf8') : null
  const reqLines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${targetIp}:${port}`,
    `Authorization: Bearer ${token}`,
    'Accept: application/json',
    'Connection: close',
  ]
  if (payload) {
    reqLines.push('Content-Type: application/json; charset=utf-8')
    reqLines.push(`Content-Length: ${payload.length}`)
  }
  const headBuf = Buffer.from(reqLines.join('\r\n') + '\r\n\r\n', 'latin1')
  const wire = payload ? Buffer.concat([headBuf, payload]) : headBuf

  const sock = await Promise.race([
    socksConnect(ts.socksPort, targetIp, port),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Timed out connecting to PC over Tailscale.')), Math.min(timeoutMs, 10_000))),
  ])
  return await new Promise<PcRequestResult>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    const finish = (err?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      if (err) {
        clearTailscaleStatusCache()
        reject(err)
      } else {
        try {
          resolve(parseHttpResponse(Buffer.concat(chunks)))
        } catch (e) {
          reject(e as Error)
        }
      }
    }
    const timer = setTimeout(() => finish(new Error('PC agent timed out over Tailscale.')), timeoutMs)
    sock.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_RESPONSE_BYTES) return finish(new Error('PC agent response exceeded 16 MiB limit.'))
      chunks.push(chunk)
    })
    sock.on('error', (err) => finish(new Error(`Could not reach PC agent over Tailscale: ${err.message}`)))
    sock.on('end', () => finish())
    sock.write(wire)
  })
}
