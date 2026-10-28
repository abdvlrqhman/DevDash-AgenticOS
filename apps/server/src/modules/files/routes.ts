import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query, rateLimit } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { EXPIRY, type ShareRow, type SharesService } from './shares.ts'
import { agentFile, asText, attachment, readAll } from './stream.ts'

const CHUNK = 8 * 1024 * 1024
/** Biggest file the viewer shows as text; past that it offers a download. */
const TEXT_MAX = 2 * 1024 * 1024
const Path = z.string().min(1).max(4096)
const ShareInput = z.object({
  path: Path, password: z.string().max(256).optional(), expires: z.enum(Object.keys(EXPIRY) as [keyof typeof EXPIRY]).default('7d'),
  maxDownloads: z.number().int().min(1).max(100_000).nullable().optional(),
})

/** Files in the member's own roots (all done by their agent, as them) and their share links. */
export function filesRoutes(agents: AgentsService, shares: SharesService, mw: ReturnType<typeof authMiddleware>) {
  const as = (c: { get: (k: 'user') => { username: string } }) => c.get('user').username
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ path: Path.optional() })), async (c) => {
      const [{ roots }, listing] = await Promise.all([
        agents.request<{ roots: { id: string; label: string; path: string }[] }>(as(c), { op: 'fs.roots' }),
        agents.request<{ path: string; entries: { name: string; dir: boolean; link: boolean; size: number | null; mtime: number }[] }>(as(c), { op: 'fs.list', path: c.req.valid('query').path }),
      ])
      return c.json({ roots, ...listing })
    })
    .get('/download', query(z.object({ path: Path, view: z.literal('1').optional() })), async (c) => {
      const f = await agentFile(agents.open(as(c), { op: 'fs.read', path: c.req.valid('query').path }))
      // view=1 opens a PDF in the browser's own viewer (a new tab); everything else always downloads.
      if (c.req.valid('query').view && /\.pdf$/i.test(f.name)) {
        return new Response(f.body, { headers: { 'content-type': 'application/pdf', 'content-length': String(f.size), 'content-disposition': attachment(f.name).replace(/^attachment/, 'inline') } })
      }
      return new Response(f.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(f.size), 'content-disposition': attachment(f.name) } })
    })
    // A file Claude named can be relative to more than one folder (it moves with cd, or into a worktree): the first that exists.
    .post('/first', json(z.object({ paths: z.array(Path).min(1).max(8) })), async (c) =>
      c.json(await agents.request<{ path: string | null }>(as(c), { op: 'fs.first', paths: c.req.valid('json').paths })))
    // Where a file Claude named without its folder is: files with that name under the session's and project's folders.
    .post('/find', json(z.object({ name: z.string().min(1).max(255), dirs: z.array(Path).min(1).max(6) })), async (c) =>
      c.json(await agents.request<{ paths: string[] }>(as(c), { op: 'fs.find', ...c.req.valid('json') }, 10_000)))
    // For the file viewer: a text file's contents (read-only, size-capped); binary or bigger files come back without text.
    .get('/read', query(z.object({ path: Path })), async (c) => {
      const f = await agentFile(agents.open(as(c), { op: 'fs.read', path: c.req.valid('query').path }))
      const tooBig = f.size > TEXT_MAX
      if (tooBig) await f.body.cancel()
      const text = tooBig ? null : asText(await readAll(f.body))
      return c.json({ name: f.name, size: f.size, text, binary: !tooBig && text === null, tooBig })
    })
    // Chunked upload: the browser sends ≤ 8 MB pieces in order (Cloudflare caps a request at 100 MB).
    .post('/upload', query(z.object({ path: Path, offset: z.coerce.number().int().min(0) })), async (c) => {
      const data = Buffer.from(await c.req.arrayBuffer())
      if (data.length > CHUNK) throw new AppError(400, 'too_big', 'Upload pieces must be 8 MB or smaller.')
      const { path, offset } = c.req.valid('query')
      return c.json(await agents.request(as(c), { op: 'fs.write', path, offset, data: data.toString('base64') }, 120_000))
    })
    .post('/mkdir', json(z.object({ path: Path })), async (c) => c.json(await agents.request(as(c), { op: 'fs.mkdir', path: c.req.valid('json').path })))
    .post('/rename', json(z.object({ from: Path, to: Path })), async (c) => c.json(await agents.request(as(c), { op: 'fs.rename', ...c.req.valid('json') })))
    .post('/delete', json(z.object({ path: Path })), async (c) => {
      const { path } = c.req.valid('json')
      const done = await agents.request(as(c), { op: 'fs.remove', path }, 120_000) as { path?: string }
      // Its share links go with it.
      const links = await shares.revokeSource(c.get('user'), path) + (done.path && done.path !== path ? await shares.revokeSource(c.get('user'), done.path) : 0)
      return c.json({ ok: true, links })
    })

    .get('/shares', (c) => c.json({ shares: shares.list(c.get('user')) }))
    .post('/shares', json(ShareInput), async (c) => {
      const input = c.req.valid('json')
      const f = await agentFile(agents.open(as(c), { op: 'fs.read', path: input.path }))
      return c.json({ share: await shares.create(c.get('user'), { ...input, name: f.name, source: input.path, body: f.body }) })
    })
    .delete('/shares/:id', async (c) => {
      await shares.revoke(c.get('user'), Number(c.req.param('id')))
      return c.json({ ok: true })
    })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

/** The public download page. A button (POST) downloads, so link previews in chat apps never use up a download. */
function page(r: ShareRow | null, error?: string) {
  const body = r
    ? `<h1>${esc(r.name)}</h1><p class="meta">${size(r.size)}, shared by ${esc(r.creator_name)}${r.expires_at ? `, link works until ${new Date(r.expires_at * 1000).toUTCString().replace(' GMT', ' UTC')}` : ''}</p>
       <form method="post">${r.password_hash ? '<label for="p">Password</label><input id="p" name="password" type="password" required autofocus>' : ''}
       ${error ? `<p class="err">${esc(error)}</p>` : ''}<button type="submit">Download</button></form>`
    : '<h1>This link doesn\'t work</h1><p class="meta">It may have expired, reached its download limit or been turned off. Ask the person who sent it for a new one.</p>'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${r ? esc(r.name) : 'Link unavailable'}</title><style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(26rem,calc(100% - 2rem))}h1{font-size:1.25rem;margin:0 0 .25rem;word-break:break-word}.meta{opacity:.65;margin:0 0 1.5rem;font-size:.9rem}
label{display:block;font-size:.85rem;margin-bottom:.35rem}input{width:100%;box-sizing:border-box;height:2.5rem;padding:0 .75rem;border:1px solid #8886;border-radius:.5rem;background:transparent;color:inherit;font-size:1rem;margin-bottom:.75rem}
button{width:100%;height:2.75rem;border:0;border-radius:.5rem;background:CanvasText;color:Canvas;font-size:1rem;font-weight:600;cursor:pointer}.err{color:#e5484d;font-size:.9rem}
.by{margin-top:2rem;font-size:.75rem;opacity:.45}</style></head><body><main>${body}<p class="by">Shared with DevDash</p></main></body></html>`
}

export function publicShareRoutes(shares: SharesService, ip: (c: import('hono').Context) => string) {
  const html = (c: import('hono').Context, markup: string, status: 200 | 401 | 404 = 200) => {
    c.header('x-robots-tag', 'noindex')
    c.header('cache-control', 'no-store')
    c.header('referrer-policy', 'no-referrer')
    return c.html(markup, status)
  }
  return new Hono()
    .get('/:token', async (c) => {
      const r = await shares.available(c.req.param('token'))
      return html(c, page(r), r ? 200 : 404)
    })
    .post('/:token', async (c) => {
      rateLimit(`share:${ip(c)}`, 30, 10 * 60_000)
      const r = await shares.available(c.req.param('token'))
      if (!r) return html(c, page(null), 404)
      const form = await c.req.parseBody()
      if (!(await shares.checkPassword(r, typeof form.password === 'string' ? form.password : ''))) return html(c, page(r, 'That password is not right.'), 401)
      return new Response(shares.open(r), {
        headers: {
          'content-type': 'application/octet-stream', 'content-length': String(r.size), 'content-disposition': attachment(r.name),
          'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        },
      })
    })
}
