import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { EFFORTS, PERMISSION_MODES, type ClaudeService } from './service.ts'

const MB = 1024 * 1024
const ImageInput = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().max(7 * MB), // base64 of up to ~5 MB
})
const Images = z.array(ImageInput).max(6).default([])
const Files = z.array(z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().max(120),
  data: z.string().max(14 * MB), // base64 of up to 10 MB
})).max(6).default([])
const Model = z.string().max(80).nullable()
const Effort = z.enum(EFFORTS).nullable()
const Mode = z.enum(PERMISSION_MODES)
const Size = z.number().int().min(10).max(500)

const CreateInput = z.object({
  prompt: z.string().max(200_000).default(''),
  images: Images,
  cwd: z.string().max(500).default('~'),
  profile: z.string().max(21).default('default'),
  model: Model.default(null),
  effort: Effort.default(null),
  permissionMode: Mode.default('bypassPermissions'),
  mode: z.enum(['chat', 'cli']).default('chat'),
  project: z.string().max(40).optional(),
  worktree: z.boolean().optional(),
  cols: Size.optional(),
  rows: z.number().int().min(4).max(200).optional(),
  // Left out: the project's default for new sessions.
  shared: z.boolean().optional(),
  sharedCanSend: z.boolean().optional(),
})
// Big files are uploaded beforehand in pieces (POST /sessions/:id/uploads) and named here.
const UploadId = z.string().regex(/^[a-f0-9]{16,64}$/)
const Uploads = z.array(z.object({ upload: UploadId, name: z.string().min(1).max(255), size: z.number().int().min(0) })).max(6).default([])
const PIECE = 32 * MB // Cloudflare caps a request at 100 MB, so a big attachment arrives in pieces.
const SendInput = z.object({ text: z.string().max(200_000), images: Images, files: Files, uploads: Uploads })
  .refine((v) => v.text.trim() || v.images.length || v.files.length || v.uploads.length, 'Write a message or attach a file')
const AnswerInput = z.object({
  requestId: z.uuid(),
  result: z.discriminatedUnion('behavior', [
    z.object({ behavior: z.literal('allow'), updatedInput: z.record(z.string(), z.unknown()).optional(), updatedPermissions: z.array(z.unknown()).optional() }),
    z.object({ behavior: z.literal('deny'), message: z.string().max(5000), interrupt: z.boolean().optional() }),
  ]),
})
const PatchInput = z.object({
  title: z.string().max(120).optional(),
  shared: z.boolean().optional(),
  sharedCanSend: z.boolean().optional(),
  archived: z.boolean().optional(),
  model: Model.optional(),
  effort: Effort.optional(),
  permissionMode: Mode.optional(),
  fastMode: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
  reachTailnet: z.boolean().optional(),
  tailnetMcp: z.string().max(300).nullable().optional(),
  tailnetMcps: z.array(z.object({ name: z.string().max(60), url: z.string().max(300) })).max(8).nullable().optional(),
})
const SharingInput = z.object({
  audience: z.enum(['private', 'everyone', 'people']),
  everyoneCanSend: z.boolean().optional(),
  people: z.array(z.object({ id: z.number().int().positive(), canSend: z.boolean() })).max(200).optional(),
})
const ModeInput = z.object({ mode: z.enum(['chat', 'cli']), cols: Size.default(100), rows: z.number().int().min(4).max(200).default(30) })
const DefaultsInput = z.object({
  profile: z.string().max(21), model: Model, effort: Effort, permission_mode: Mode, open_in: z.enum(['chat', 'cli']),
})

export function claudeRoutes(claude: ClaudeService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/sessions', query(z.object({ archived: z.enum(['0', '1']).default('0') })), (c) =>
      c.json({ sessions: claude.list(c.get('user'), c.req.valid('query').archived === '1') }))
    .get('/projects/:slug/sessions', query(z.object({ archived: z.enum(['0', '1']).default('0') })), (c) =>
      c.json(claude.inProject(c.get('user'), c.req.param('slug'), c.req.valid('query').archived === '1')))
    .post('/sessions', json(CreateInput), async (c) => c.json({ session: await claude.create(c.get('user'), c.req.valid('json')) }))
    .get('/sessions/:id', async (c) => c.json(await claude.get(c.get('user'), c.req.param('id'))))
    .patch('/sessions/:id', json(PatchInput), async (c) => c.json({ session: await claude.update(c.get('user'), c.req.param('id'), c.req.valid('json')) }))
    .get('/sessions/:id/messages', query(z.object({ before: z.string().max(64).optional() })), async (c) =>
      c.json(await claude.history(c.get('user'), c.req.param('id'), c.req.valid('query').before)))
    .get('/sessions/:id/usage', (c) => c.json({ usage: claude.sessionUsage(c.get('user'), c.req.param('id')) }))
    .get('/sessions/:id/subagent', query(z.object({ toolUseId: z.string().min(1).max(100) })), async (c) =>
      c.json(await claude.subagent(c.get('user'), c.req.param('id'), c.req.valid('query').toolUseId)))
    .post('/sessions/:id/tasks/:taskId/stop', async (c) => {
      await claude.stopTask(c.get('user'), c.req.param('id'), c.req.param('taskId'))
      return c.json({ ok: true })
    })
    .post('/sessions/:id/messages', json(SendInput), async (c) => {
      const { text, images, files, uploads } = c.req.valid('json')
      return c.json({ uuid: await claude.send(c.get('user'), c.req.param('id'), text, images, files, uploads) })
    })
    .post('/sessions/:id/uploads', query(z.object({ upload: UploadId, name: z.string().min(1).max(255), offset: z.coerce.number().int().min(0), total: z.coerce.number().int().min(1) })), async (c) => {
      const data = Buffer.from(await c.req.arrayBuffer())
      if (data.length > PIECE) throw new AppError(400, 'too_big', 'Upload pieces must be 32 MB or smaller.')
      return c.json(await claude.uploadPiece(c.get('user'), c.req.param('id'), c.req.valid('query'), data))
    })
    .get('/sessions/:id/files', query(z.object({ q: z.string().max(200).default('') })), async (c) =>
      c.json(await claude.files(c.get('user'), c.req.param('id'), c.req.valid('query').q)))
    .post('/sessions/:id/join', (c) => {
      claude.askToJoin(c.get('user'), c.req.param('id'))
      return c.json({ ok: true })
    })
    .put('/sessions/:id/sharing', json(SharingInput), (c) => c.json(claude.setSharing(c.get('user'), c.req.param('id'), c.req.valid('json'))))
    .put('/sessions/:id/writers/:userId', json(z.object({ allowed: z.boolean() })), (c) =>
      c.json(claude.setWriter(c.get('user'), c.req.param('id'), Number(c.req.param('userId')), c.req.valid('json').allowed)))
    .get('/sessions/:id/comments', (c) => c.json(claude.comments(c.get('user'), c.req.param('id'))))
    .post('/sessions/:id/comments', json(z.object({ body: z.string().trim().min(1).max(5000) })), (c) =>
      c.json({ comment: claude.comment(c.get('user'), c.req.param('id'), c.req.valid('json').body) }))
    .post('/sessions/:id/answer', json(AnswerInput), async (c) => {
      const { requestId, result } = c.req.valid('json')
      await claude.answer(c.get('user'), c.req.param('id'), requestId, result)
      return c.json({ ok: true })
    })
    .post('/sessions/:id/interrupt', async (c) => {
      await claude.interrupt(c.get('user'), c.req.param('id'))
      return c.json({ ok: true })
    })
    .post('/sessions/:id/mode', json(ModeInput), async (c) => {
      const { mode, cols, rows } = c.req.valid('json')
      return c.json({ session: await claude.switchMode(c.get('user'), c.req.param('id'), mode, cols, rows) })
    })
    .get('/commands', query(z.object({ profile: z.string().max(21).default('default') })), async (c) =>
      c.json(await claude.commands(c.get('user'), c.req.valid('query').profile)))
    .get('/profiles', async (c) => c.json(await claude.profiles(c.get('user'))))
    .get('/usage/:profile', async (c) => c.json({ usage: await claude.usage(c.get('user'), c.req.param('profile')) }))
    .post('/profiles', json(z.object({ name: z.string().max(21) })), async (c) => {
      await claude.createProfile(c.get('user'), c.req.valid('json').name)
      return c.json({ ok: true })
    })
    .get('/memory', async (c) => c.json({ health: await claude.memoryHealth(c.get('user')) }))
    .post('/memory/restart', async (c) => {
      await claude.restartMemory(c.get('user'))
      return c.json({ ok: true })
    })
    .put('/profiles/:name/memory', json(z.object({ enabled: z.boolean() })), async (c) => {
      return c.json(await claude.setMemory(c.get('user'), c.req.param('name'), c.req.valid('json').enabled))
    })
    .put('/defaults', json(DefaultsInput), (c) => c.json({ defaults: claude.saveDefaults(c.get('user'), c.req.valid('json')) }))
}
