import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { PcService } from './service.ts'

const Pair = z.object({
  name: z.string().min(1).max(80),
  tailscaleIp: z.string().min(7).max(40),
  port: z.number().int().min(1024).max(65535).optional(),
  allowShell: z.boolean().optional(),
})

const Settings = z.object({
  enabled: z.boolean().optional(),
  allowShell: z.boolean().optional(),
  rotateToken: z.boolean().optional(),
})

const Action = z.object({
  tool: z.string().min(1).max(60),
  args: z.record(z.string(), z.unknown()).optional(),
})

const InstallMcp = z.object({
  sources: z.array(z.string().min(1).max(80)).optional(),
})

export function pcRoutes(pc: PcService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/status', async (c) => c.json(await pc.status(c.get('user'))))
    .post('/pair', json(Pair), async (c) => c.json(await pc.pair(c.get('user'), c.req.valid('json'))))
    .patch('/settings', json(Settings), async (c) => c.json(await pc.updateSettings(c.get('user'), c.req.valid('json'))))
    .delete('/device', (c) => c.json(pc.unpair(c.get('user'))))
    .get('/installer.ps1', async (c) => {
      const { filename, script } = await pc.installerScript(c.get('user'))
      c.header('Content-Type', 'text/plain; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="${filename}"`)
      c.header('Cache-Control', 'no-store')
      return c.body(script)
    })
    .post('/action', json(Action), async (c) => {
      const body = c.req.valid('json')
      return c.json(await pc.executeTool(c.get('user'), body.tool, body.args ?? {}, 'ui'))
    })
    .post('/mcp/install', json(InstallMcp), async (c) => c.json(await pc.installMcp(c.get('user'), c.req.valid('json').sources)))
}
