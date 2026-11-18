import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { VoiceService } from './service.ts'

const Patch = z.object({
  enabled: z.boolean().optional(),
  stt: z.string().max(40).optional(),
  tts: z.string().max(40).optional(),
  perLanguage: z.boolean().optional(),
  languages: z.array(z.string().max(8)).max(20).optional(),
  monthlyCapUsd: z.number().min(0).max(10_000).nullable().optional(),
  speed: z.number().min(0.7).max(1.5).optional(),
  waitTalk: z.boolean().optional(),
  endWait: z.enum(['quick', 'normal', 'patient']).optional(),
})
// The key itself never comes back: every answer has it masked.
const Key = z.object({ key: z.string().min(1).max(600) })
// A voice from the list, or a library voice's id or link.
const Voice = z.object({ voice: z.string().min(1).max(300).nullable(), language: z.string().max(8).optional() })
const Search = z.object({ q: z.string().max(80).optional(), language: z.string().max(12).optional(), page: z.coerce.number().int().min(1).max(50).optional() })
const Preview = z.object({ voice: z.string().max(300).optional(), language: z.string().max(8), long: z.boolean().optional() })

/** The signed-in member's own voice settings and keys. The conversation itself is a WebSocket (sockets.ts). */
export function voiceRoutes(voice: VoiceService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(voice.state(c.get('user'))))
    .get('/events', (c) => c.json({ events: voice.events(c.get('user')) }))
    .patch('/', json(Patch), (c) => c.json(voice.update(c.get('user'), c.req.valid('json'))))
    .put('/voice', json(Voice), async (c) => c.json(await voice.setVoice(c.get('user'), c.req.valid('json'))))
    .get('/voices', query(Search), async (c) => c.json(await voice.searchVoices(c.get('user'), c.req.valid('query'))))
    // A WAV file: the browser plays it as it is.
    .post('/preview', json(Preview), async (c) => {
      const wav = await voice.preview(c.get('user'), c.req.valid('json'))
      return c.body(new Uint8Array(wav), 200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
    })
    .put('/keys/:provider', json(Key), async (c) => c.json(await voice.setKey(c.get('user'), c.req.param('provider'), c.req.valid('json').key)))
    .delete('/keys/:provider', (c) => c.json(voice.removeKey(c.get('user'), c.req.param('provider'))))
    .post('/keys/:provider/check', async (c) => c.json(await voice.checkKey(c.get('user'), c.req.param('provider'))))
}
