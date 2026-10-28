import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { VaultService } from './service.ts'

const Sealed = z.object({ iv: z.string().max(100), data: z.string().max(20_000) })
const Wrapped = z.object({ epk: z.string().max(400), iv: z.string().max(100), data: z.string().max(400) })

export function vaultRoutes(vault: VaultService, mw: ReturnType<typeof authMiddleware>) {
  const n = (v: string) => Number.parseInt(v, 10)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/me', (c) => c.json(vault.me(c.get('user'))))
    .post('/setup', json(z.object({ salt: z.string().max(100), iterations: z.number().int(), publicKey: z.string().max(400), privateKey: Sealed })),
      (c) => c.json(vault.setup(c.get('user'), c.req.valid('json'))))
    .post('/vaults/:id/init', json(z.object({ wrapped: Wrapped })), (c) => {
      vault.init(c.get('user'), n(c.req.param('id')), c.req.valid('json').wrapped)
      return c.json({ ok: true })
    })
    .put('/me/password', json(z.object({ salt: z.string().max(100), iterations: z.number().int().min(300_000), privateKey: Sealed })), (c) => {
      vault.changePassword(c.get('user'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .get('/vaults', (c) => c.json(vault.vaults(c.get('user'))))
    .post('/vaults/:id/keys', json(z.object({ userId: z.number().int(), keyVersion: z.number().int(), wrapped: Wrapped })), (c) => {
      vault.grant(c.get('user'), n(c.req.param('id')), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .get('/vaults/:id/items', (c) => c.json({ items: vault.items(c.get('user'), n(c.req.param('id'))) }))
    .put('/vaults/:id/items/:item', json(z.object({ keyVersion: z.number().int(), iv: z.string().max(100), data: z.string().max(200_000) })), (c) => {
      vault.putItem(c.get('user'), n(c.req.param('id')), c.req.param('item'), c.req.valid('json'))
      return c.json({ ok: true })
    })
    .delete('/vaults/:id/items/:item', (c) => {
      vault.removeItem(c.get('user'), n(c.req.param('id')), c.req.param('item'))
      return c.json({ ok: true })
    })
    .post('/vaults/:id/rotate', json(z.object({
      keyVersion: z.number().int(), keys: z.array(z.object({ userId: z.number().int(), wrapped: Wrapped })).max(500),
      items: z.array(z.object({ id: z.string().max(36), iv: z.string().max(100), data: z.string().max(200_000) })).max(20_000),
    })), (c) => {
      vault.rotate(c.get('user'), n(c.req.param('id')), c.req.valid('json'))
      return c.json({ ok: true })
    })
}
