import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import type { ProvisioningService } from '../provisioning/service.ts'
import type { TerminalsService } from './service.ts'

const ServerPasswordInput = z.object({
  password: z.string().min(1).max(256),
  currentPassword: z.string().min(1).max(256),
  code: z.string().max(10),
})

export function terminalsRoutes(terms: TerminalsService, auth: AuthService, mw: ReturnType<typeof authMiddleware>, provisioning: ProvisioningService, ip: (c: import('hono').Context) => string) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', async (c) => c.json({ terminals: await terms.list(c.get('user').username) }))
    // This member's GitHub connection on the server (gh, used for cloning, fetching and pushing as them).
    .get('/github', async (c) => c.json(await terms.github(c.get('user').username)))
    .delete('/:name', async (c) => {
      await terms.kill(c.get('user').username, c.req.param('name'))
      return c.json({ ok: true })
    })
    .post('/admin/unlock', mw.requireAdmin, json(z.object({ code: z.string().max(10) })), (c) => {
      if (!auth.verifyFreshTotp(c.get('user').id, c.req.valid('json').code.trim())) {
        throw new AppError(400, 'bad_code', 'That code is not valid. Wait for the next one and try again.')
      }
      terms.unlockAdmin(c.get('sessionToken'))
      return c.json({ ok: true })
    })
    // The Linux password sudo asks for in the admin shell.
    .post('/admin/password', mw.requireAdmin, json(ServerPasswordInput), async (c) => {
      const { password, currentPassword, code } = c.req.valid('json')
      const user = c.get('user')
      await auth.confirm(user.id, currentPassword, code.trim(), ip(c))
      try {
        await provisioning.setServerPassword(user.username, password)
      } catch (err) {
        throw new AppError(400, 'server_password', (err as Error).message)
      }
      auth.audit(user.id, 'server_password.set', ip(c))
      return c.json({ ok: true })
    })
}
