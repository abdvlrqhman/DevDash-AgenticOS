import type { Context, MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { z } from 'zod'

export class AppError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429
  code: string
  constructor(status: AppError['status'], code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** JSON body validation with zod; keeps input types for the typed RPC client. */
export const json = <T extends z.ZodType>(schema: T) =>
  validator('json', (value) => {
    const r = schema.safeParse(value)
    if (!r.success) throw new AppError(400, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return r.data as z.infer<T>
  })

/** Query-string validation with zod (same idea as `json`). */
export const query = <T extends z.ZodType>(schema: T) =>
  validator('query', (value) => {
    const r = schema.safeParse(value)
    if (!r.success) throw new AppError(400, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return r.data as z.infer<T>
  })

/** Rejects state-changing requests that don't come from our own origin (CSRF). */
export const sameOrigin = (origin: string): MiddlewareHandler => async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== origin) {
    throw new AppError(403, 'bad_origin', 'Request origin not allowed')
  }
  await next()
}

/** Client IP. CF-Connecting-IP is trusted only when the origin is firewalled to Cloudflare. */
export function clientIp(c: Context, trustCfIp: boolean): string {
  if (trustCfIp) {
    const cf = c.req.header('cf-connecting-ip')
    if (cf) return cf
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown' // no socket, e.g. app.request() in tests
  }
}

// ponytail: in-memory fixed window, single process. Move to SQLite if the server ever runs as several processes.
const windows = new Map<string, { count: number; resetAt: number }>()
export function rateLimit(key: string, max: number, windowMs: number): void {
  const t = Date.now()
  const w = windows.get(key)
  if (!w || w.resetAt <= t) {
    windows.set(key, { count: 1, resetAt: t + windowMs })
    return
  }
  if (++w.count > max) throw new AppError(429, 'rate_limited', 'Too many attempts. Try again later.')
}
setInterval(() => {
  const t = Date.now()
  for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k)
}, 60_000).unref()
