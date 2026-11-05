import type { Socket } from 'node:net'
import { AppError } from '../../core/http.ts'

/**
 * Reads a file the agent streams (apps/agent/src/files.ts: a header line, base64 chunks, {end:true}) as a web
 * ReadableStream, pausing the socket while the reader is slow so nothing piles up in memory.
 */
export function agentFile(sock: Socket): Promise<{ name: string; size: number; body: ReadableStream<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    sock.setEncoding('utf8')
    let buf = ''
    let header = false
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (ctrl = c),
      pull: () => void sock.resume(),
      cancel: () => void sock.destroy(),
    }, { highWaterMark: 4 })
    sock.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: { ok?: boolean; error?: string; name?: string; size?: number; b?: string; end?: boolean }
        try { m = JSON.parse(line) } catch { continue }
        if (!header) {
          header = true
          if (m.error) { sock.destroy(); return reject(new AppError(400, 'file_error', m.error)) }
          resolve({ name: m.name!, size: m.size!, body })
        } else if (m.b) {
          ctrl.enqueue(Buffer.from(m.b, 'base64'))
          if ((ctrl.desiredSize ?? 1) <= 0) sock.pause()
        } else if (m.end) {
          ctrl.close()
        } else if (m.error) {
          ctrl.error(new Error(m.error))
        }
      }
    })
    sock.on('error', (err) => (header ? ctrl.error(err) : reject(new AppError(409, 'agent_unavailable', 'Your server account is not reachable right now. Try again in a minute.'))))
    sock.on('close', () => { if (!header) reject(new AppError(409, 'agent_unavailable', 'Your server account is not reachable right now.')) })
  })
}

/** A file's bytes as text, or null when it looks binary (a NUL byte early on, or not UTF-8). */
export function asText(buf: Uint8Array) {
  if (buf.subarray(0, 8000).includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return null }
}

/** A whole (already size-checked) body in memory. */
export async function readAll(body: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = []
  for await (const chunk of body) parts.push(chunk)
  return Buffer.concat(parts)
}

/**
 * The part of a file a Range header asks for: "bytes=0-" or "bytes=500-999" (end included). Anything else (several
 * ranges, the last N bytes) is null, and the whole file is sent, which HTTP allows. Pure, tested.
 */
export function parseRange(h: string | undefined): { start: number; end?: number } | null {
  const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(h?.trim() ?? '')
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : undefined
  return end === undefined || end >= start ? { start, end } : null
}

/** Videos browsers play, by extension. A .mov is labelled MP4: Chrome won't try "video/quicktime", and most are H.264 inside. */
const VIDEO: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' }
export const videoType = (name: string) => VIDEO[/\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? null

/** RFC 6266 attachment header that survives any file name. */
export const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
