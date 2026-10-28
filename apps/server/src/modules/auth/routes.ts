import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { User } from './repo.ts'
import type { AuthService } from './service.ts'

export type AuthEnv = { Variables: { user: User; sessionToken: string } }
type Ip = (c: Context) => string

const COOKIE = 'devdash' // sent as __Host-devdash: Secure, Path=/, no Domain
const REMEMBER_MAX_AGE = 30 * 86_400

function setSessionCookie(c: Context, token: string, remember: boolean) {
  setCookie(c, COOKIE, token, {
    prefix: 'host', httpOnly: true, secure: true, sameSite: 'Lax', path: '/',
    ...(remember ? { maxAge: REMEMBER_MAX_AGE } : {}),
  })
}

export function authMiddleware(auth: AuthService) {
  const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const token = getCookie(c, COOKIE, 'host')
    const s = auth.sessionUser(token)
    if (!s) throw new AppError(401, 'unauthenticated', 'Please sign in.')
    if (s.refreshCookie) setSessionCookie(c, token!, true)
    c.set('user', s.user)
    c.set('sessionToken', token!)
    await next()
  }
  const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.get('user').role !== 'admin') throw new AppError(403, 'forbidden', 'Admins only.')
    await next()
  }
  /** The signed-in member, or null (for endpoints that also accept other credentials). */
  const signedIn = (c: Context) => auth.sessionUser(getCookie(c, COOKIE, 'host'))?.user ?? null
  return { requireUser, requireAdmin, signedIn }
}

const LoginInput = z.object({
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
  code: z.string().min(6).max(32),
  remember: z.boolean(),
})

const AcceptInput = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
})

const EmailInput = z.object({
  password: z.string().min(1).max(256),
  email: z.email().max(254),
})

const PasswordInput = z.object({
  current: z.string().min(1).max(256),
  next: z.string().min(1).max(256),
})

export function authRoutes(auth: AuthService, mw: ReturnType<typeof authMiddleware>, ip: Ip, onUserChanged: (u: User) => void) {
  const meta = (c: Context) => ({ ip: ip(c), ua: (c.req.header('user-agent') ?? '').slice(0, 300) })
  return new Hono<AuthEnv>()
    .post('/login', json(LoginInput), async (c) => {
      const r = await auth.login(c.req.valid('json'), meta(c))
      setSessionCookie(c, r.token, r.remember)
      return c.json({ user: r.user })
    })
    .post('/logout', (c) => {
      auth.logout(getCookie(c, COOKIE, 'host'))
      deleteCookie(c, COOKIE, { prefix: 'host', path: '/', secure: true })
      return c.json({ ok: true })
    })
    .get('/me', mw.requireUser, (c) => c.json({ user: c.get('user') }))
    .post('/password', mw.requireUser, json(PasswordInput), async (c) => {
      const { current, next } = c.req.valid('json')
      const signedOut = await auth.changePassword(c.get('user').id, current, next, c.get('sessionToken'), meta(c).ip)
      return c.json({ ok: true, signedOutSessions: signedOut })
    })
    .post('/email', mw.requireUser, json(EmailInput), async (c) => {
      const { password, email } = c.req.valid('json')
      const user = await auth.changeEmail(c.get('user').id, password, email, meta(c).ip)
      onUserChanged(user)
      return c.json({ user })
    })
    .get('/invites/:token', (c) => c.json(auth.getInvite(c.req.param('token'))))
    .post('/invites/:token', json(AcceptInput), async (c) => {
      const r = await auth.acceptInvite(c.req.param('token'), c.req.valid('json'), meta(c))
      onUserChanged(r.user)
      setSessionCookie(c, r.token, false)
      return c.json({ user: r.user, backupCodes: r.backupCodes })
    })
}
