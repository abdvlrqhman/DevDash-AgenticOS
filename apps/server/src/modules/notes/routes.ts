import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { NOTE_STATUS, type NotesService } from './service.ts'

const Fields = {
  body: z.string().max(200_000).optional(), project: z.string().max(40).nullable().optional(),
  pinned: z.boolean().optional(), private: z.boolean().optional(), status: z.enum(NOTE_STATUS).optional(),
}

export function notesRoutes(notes: NotesService, mw: ReturnType<typeof authMiddleware>) {
  const id = (v: string) => Number.parseInt(v, 10)
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ project: z.string().max(40).optional() })), (c) => c.json({ notes: notes.list(c.get('user'), c.req.valid('query').project || undefined) }))
    .post('/', json(z.object({ title: z.string().min(1).max(200), ...Fields })), (c) => c.json({ note: notes.create({ user: c.get('user') }, c.req.valid('json')) }))
    .get('/:id', (c) => c.json({ note: notes.get(c.get('user'), id(c.req.param('id'))) }))
    .patch('/:id', json(z.object({ title: z.string().min(1).max(200).optional(), ...Fields })), (c) =>
      c.json({ note: notes.update({ user: c.get('user') }, id(c.req.param('id')), c.req.valid('json')) }))
    .delete('/:id', (c) => {
      notes.remove(c.get('user'), id(c.req.param('id')))
      return c.json({ ok: true })
    })
}
