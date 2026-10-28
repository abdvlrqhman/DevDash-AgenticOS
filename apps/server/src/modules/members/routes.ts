import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import { MAX_AVATAR_BYTES, type AvatarsService } from './avatars.ts'

const InviteInput = z.object({
  email: z.email().max(254),
  username: z.string().min(2).max(31),
  role: z.enum(['admin', 'member']),
})

export function membersRoutes(auth: AuthService, mw: ReturnType<typeof authMiddleware>, ip: (c: Context) => string, origin: string, onRemoved: (userId: number) => void, avatars: AvatarsService) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => {
      const m = auth.members()
      const pics = avatars.versions()
      // avatarAt: when their picture last changed, for its address (/api/members/<id>/avatar?v=…); null: initials.
      return c.json({ ...m, users: m.users.map((u) => ({ ...u, avatarAt: pics.get(u.id) ?? null })) })
    })
    // Your own picture: the cropped image's bytes as the body (apps/web/src/lib/avatar.ts).
    .put('/me/avatar', async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_AVATAR_BYTES) throw new AppError(400, 'too_big', 'That picture is too big. Choose a smaller one.')
      return c.json(avatars.set(c.get('user').id, Buffer.from(await c.req.arrayBuffer())))
    })
    .delete('/me/avatar', (c) => c.json(avatars.remove(c.get('user').id)))
    .get('/:id/avatar', (c) => {
      const a = avatars.get(Number(c.req.param('id')))
      return new Response(new Uint8Array(a.data), {
        headers: {
          'content-type': a.mime,
          // The address carries the version, so it never changes in place.
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      })
    })
    .post('/invites', mw.requireAdmin, json(InviteInput), (c) => {
      const { token } = auth.createInvite(c.req.valid('json'), c.get('user').id, ip(c))
      return c.json({ link: `${origin}/invite/${token}` })
    })
    .post('/:id/remove', mw.requireAdmin, (c) => {
      const id = Number(c.req.param('id'))
      auth.removeMember(c.get('user'), id, ip(c))
      onRemoved(id)
      return c.json({ ok: true })
    })
}
