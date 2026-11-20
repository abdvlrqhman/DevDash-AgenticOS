// OpenCode v2's stateless generation operation accepts a prompt and model reference. It creates no agent session.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { assertRegularMemberUid, openCodeMemberFetch } from './t3-local.ts'

type ModelRef = { providerID: string; id: string; variant?: string }
type Model = { providerID: string; id: string; variants: string[] }
type OpenCodeRequest = (path: string, body?: object) => Promise<Response>

/** The server chooses the port and reports it on stdout. Each invocation has its own password and lifetime. */
async function withOpenCode<T>(bin: string, use: (request: OpenCodeRequest, models: Model[]) => Promise<T>) {
  assertRegularMemberUid(process.getuid?.())
  const password = randomBytes(32).toString('base64url')
  const config = {
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    policies: ['tool.use', 'mcp.use', 'skill.use', 'websearch.use'].map((action) => ({ action, resource: '*', effect: 'deny' })),
    update: 'disable',
    mcp: { timeout: { startup: 500, catalog: 500, execution: 500 } },
  }
  const child = spawn(bin, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, OPENCODE_USERNAME: 'opencode', OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  })
  const ended = new AbortController()
  const stopped = new Promise<void>((resolve) => {
    child.once('error', () => ended.abort(new Error('Could not start the T3 OpenCode supervisor.')))
    child.once('close', () => { ended.abort(new Error('The T3 OpenCode supervisor stopped.')); resolve() })
  })
  const signal = AbortSignal.any([ended.signal, AbortSignal.timeout(155_000)])
  const starting = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: starting })
    let endpoint: unknown
    try { endpoint = JSON.parse(line).url } catch { /* unsupported OpenCode launcher */ }
    if (typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(endpoint)) throw new Error('The T3 OpenCode executable did not report a local supervisor endpoint.')
    const catalog = new URL('/api/model', endpoint)
    const anonymous = await openCodeMemberFetch(catalog, { method: 'GET', headers: {}, signal: starting })
    await anonymous.body?.cancel()
    if (anonymous.status !== 401) throw new Error('The local OpenCode supervisor requires password authentication.')
    const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'Content-Type': 'application/json' }
    const request: OpenCodeRequest = (path, body) => openCodeMemberFetch(new URL(path, endpoint), {
      method: body ? 'POST' : 'GET', headers, signal: body ? signal : starting, ...(body && { body: JSON.stringify(body) }),
    })
    let response = await request('/api/model')
    while (response.status === 503) { // The server is listening while the member's provider plugins are starting.
      await response.body?.cancel()
      await delay(500, undefined, { signal: starting })
      response = await request('/api/model')
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('The local OpenCode supervisor model catalog is unavailable.') }
    const json = await response.json() as { data: { providerID: string; id: string; enabled: boolean; variants: { id: string }[] }[] }
    const models = json.data.filter((m) => m.enabled).map((m) => ({ providerID: m.providerID, id: m.id, variants: m.variants.map((v) => v.id) }))
    return await use(request, models)
  } finally {
    lines.close()
    child.stdin.end()
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500)
    try { await stopped } finally { clearTimeout(kill) }
  }
}

export const supervisorModels = (bin: string) => withOpenCode(bin, async (_request, models) => models)

export function supervisorText(bin: string, model: ModelRef, prompt: string): Promise<string> {
  return withOpenCode(bin, async (request, models) => {
    const selected = models.find((m) => m.providerID === model.providerID && m.id === model.id)
    if (!selected) throw new Error('This supervisor model is unavailable in the local T3 OpenCode catalog.')
    if (model.variant && !selected.variants.includes(model.variant)) throw new Error('This thinking level is unavailable in the local T3 OpenCode supervisor.')
    const response = await request('/api/experimental/generate/text', { model, prompt })
    if (!response.ok) {
      // OpenCode may wrap an upstream 429 in a 502 ProviderError. Forward only its category.
      const error = await response.json().catch(() => null) as { status?: number; reason?: string } | null
      const limited = response.status === 429 || error?.status === 429 || error?.reason === 'rate_limit'
      throw new Error(limited ? 'The T3 OpenCode supervisor reached its rate limit.' : `The T3 OpenCode supervisor could not generate text (HTTP ${response.status}).`)
    }
    const result = await response.json() as { data: { text: string } }
    if (typeof result.data?.text !== 'string' || !result.data.text.trim()) throw new Error('The T3 OpenCode supervisor returned no text.')
    return result.data.text
  })
}
