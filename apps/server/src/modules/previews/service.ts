import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Context, MiddlewareHandler } from 'hono'
import { setCookie } from 'hono/cookie'
import { parse as parseCookies } from 'hono/utils/cookie'
import type { Db } from '../../core/db.ts'
import type { AuthService } from '../auth/service.ts'

/** Set only by Caddy's services site (port 8443); stripped from requests to DevDash itself. */
const MARK = 'x-devdash-services'
const SESSION = '__Host-devdash'
const LAST = 'dd_svc'
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']
const PATH_RE = /^\/service\/([a-z][a-z0-9-]{0,30})(\/.*)?$/

/**
 * Lets DevDash's own pages frame a service, for the in-app view (/services/<name>/view), without opening it to anyone
 * else. A service that says nothing about framing is left as it was. One that refuses it (X-Frame-Options, or a CSP
 * frame-ancestors) keeps refusing every other site and lets DevDash in: X-Frame-Options can't name another origin, so
 * it becomes frame-ancestors 'self' plus DevDash. Mutates `headers`.
 */
export function letDevDashFrame(headers: Headers, devdash: string) {
  const xfo = headers.get('x-frame-options')
  headers.delete('x-frame-options')
  const csp = headers.get('content-security-policy')
  let named = false
  const policies = (csp ? csp.split(',') : []).map((policy) => policy.split(';').map((d) => {
    const [name, ...sources] = d.trim().split(/\s+/).filter(Boolean)
    if (name?.toLowerCase() !== 'frame-ancestors') return d.trim()
    named = true
    const kept = sources.filter((x) => x.toLowerCase() !== "'none'")
    return `frame-ancestors ${(kept.includes('*') || kept.includes(devdash) ? kept : [...kept, devdash]).join(' ')}`
  }).filter(Boolean).join('; '))
  if (xfo && !named) policies.push(`frame-ancestors 'self' ${devdash}`)
  if (policies.length) headers.set('content-security-policy', policies.join(', '))
}

/**
 * Services open at https://<space>:8443/service/<name>/, proxied to their port on 127.0.0.1. The separate port makes
 * it a separate origin for browsers, so a service's pages can't act on DevDash as whoever opens them; the DevDash
 * session cookie still comes along (cookies ignore ports), so signed-in members get in without another login.
 * Public services open for anyone with the link (testers). Apps that request absolute paths (/assets/app.js) still
 * work: such requests go to the service the page came from (Referer, else the last service opened).
 */
export function servicePages({ db, auth, origin, port }: { db: Db; auth: AuthService; origin: string; port: number }) {
  const base = `${origin.replace(/:\d+$/, '')}:${port}`
  const q = { service: db.prepare('select port, public from services where name = ?') }

  function resolve(path: string, referer: string | undefined, cookies: Record<string, string>) {
    const m = PATH_RE.exec(path)
    if (m) return { name: m[1]!, rest: m[2] ?? '', direct: true }
    let from: string | undefined
    try { from = referer ? PATH_RE.exec(new URL(referer).pathname)?.[1] : undefined } catch { /* bad referer */ }
    const name = from ?? cookies[LAST]
    return name && /^[a-z][a-z0-9-]{0,30}$/.test(name) ? { name, rest: path, direct: false } : null
  }
  function allowed(name: string, cookies: Record<string, string>) {
    const s = q.service.get(name) as { port: number; public: number } | undefined
    if (!s) return { s: null, ok: false }
    return { s, ok: s.public === 1 || !!auth.sessionUser(cookies[SESSION]) }
  }
  const forwardCookies = (header: string | undefined) =>
    (header ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${SESSION}=`) && !c.startsWith(`${LAST}=`)).join('; ')

  const page = (c: Context, status: 401 | 404 | 502, title: string, text: string) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color-scheme:light dark"><main style="max-width:26rem;padding:1rem"><h1 style="font-size:1.2rem">${title}</h1><p style="opacity:.7">${text}</p></main></body>`, status)

  return {
    urlOf: (name: string) => `${base}/service/${name}/`,
    basePathOf: (name: string) => `/service/${name}/`,

    middleware: (async (c: Context, next) => {
      if (c.req.header(MARK) !== '1') return next()
      const url = new URL(c.req.url)
      const cookies = parseCookies(c.req.header('cookie') ?? '')
      const r = resolve(url.pathname, c.req.header('referer'), cookies)
      if (!r) return page(c, 404, 'No service here', 'Service addresses look like /service/&lt;name&gt;/. Open one from the Services page in DevDash.')
      if (r.direct && !r.rest) return c.redirect(`/service/${r.name}/${url.search}`) // relative URLs need the slash
      const { s, ok } = allowed(r.name, cookies)
      if (!s) return page(c, 404, 'No such service', `There is no service called ${r.name}.`)
      if (!ok) return page(c, 401, 'Sign in to DevDash first', `${r.name} is for members. <a href="${origin}/" target="_top">Sign in to DevDash</a>, then open this link again.`)

      const headers = new Headers()
      c.req.raw.headers.forEach((v, k) => { if (!HOP.includes(k) && k !== MARK) headers.set(k, v) })
      const kept = forwardCookies(c.req.header('cookie'))
      if (kept) headers.set('cookie', kept); else headers.delete('cookie')
      headers.set('x-forwarded-host', url.host)
      headers.set('x-forwarded-proto', 'https')
      headers.set('x-forwarded-prefix', `/service/${r.name}`)
      let res: Response
      try {
        res = await fetch(`http://127.0.0.1:${s.port}${r.rest}${url.search}`, {
          method: c.req.method, headers, redirect: 'manual',
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body, duplex: 'half',
        } as RequestInit)
      } catch {
        return page(c, 502, `${r.name} isn't answering`, 'Is it running? Check its logs on the Services page in DevDash.')
      }
      const out = new Headers(res.headers)
      letDevDashFrame(out, origin) // the in-app view frames it; no other site gains anything
      out.delete('content-encoding') // fetch already decompressed the body
      out.delete('content-length')
      // Redirects to "/x" stay inside the service.
      const loc = out.get('location')
      if (r.direct && loc?.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`/service/${r.name}/`)) out.set('location', `/service/${r.name}${loc}`)
      const response = new Response(res.body, { status: res.status, headers: out })
      if (r.direct && (out.get('content-type') ?? '').includes('text/html')) {
        response.headers.append('set-cookie', `${LAST}=${r.name}; Path=/; Secure; SameSite=Lax`)
      }
      return response
    }) as MiddlewareHandler,

    /** WebSockets (e.g. a dev server's live reload): resolved and checked the same way, then piped to the service. */
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      if (req.headers[MARK] !== '1') return false
      const cookies = parseCookies(req.headers.cookie ?? '')
      const url = new URL(req.url ?? '/', 'http://x')
      const r = resolve(url.pathname, req.headers.referer ?? (req.headers.origin ? `${req.headers.origin}/service/${cookies[LAST] ?? ''}/` : undefined), cookies)
      const { s, ok } = r ? allowed(r.name, cookies) : { s: null, ok: false }
      if (!r || !s || !ok) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return true
      }
      socket.on('error', () => upstream.destroy())
      const upstream = connect(s.port, '127.0.0.1', () => {
        const lines = [`${req.method} ${r.rest || '/'}${url.search} HTTP/1.1`, `Host: 127.0.0.1:${s.port}`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]!.toLowerCase()
          if (k === 'host' || k === MARK) continue
          if (k === 'cookie') { const kept = forwardCookies(req.rawHeaders[i + 1]); if (kept) lines.push(`Cookie: ${kept}`); continue }
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
      return true
    },
  }
}

export type ServicePages = ReturnType<typeof servicePages>
