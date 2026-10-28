import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { PIN_KINDS, type PinsService } from './service.ts'

const Pin = z.object({ kind: z.enum(PIN_KINDS), ref: z.string().min(1).max(200) })

/** The signed-in member's own sidebar pins. */
export function pinsRoutes(pins: PinsService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json({ pins: pins.list(c.get('user')) }))
    .post('/', json(Pin), (c) => {
      const { kind, ref } = c.req.valid('json')
      return c.json({ pins: pins.pin(c.get('user'), kind, ref) })
    })
    .post('/remove', json(Pin), (c) => {
      const { kind, ref } = c.req.valid('json')
      return c.json({ pins: pins.unpin(c.get('user'), kind, ref) })
    })
    .put('/order', json(z.object({ order: z.array(Pin).max(100) })), (c) => c.json({ pins: pins.reorder(c.get('user'), c.req.valid('json').order) }))
}
