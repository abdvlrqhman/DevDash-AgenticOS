// Stateless / ephemeral tool-free completions for T3 Code supervisor models.
// Supports OpenCode v2's stateless generation endpoint and Antigravity ACP with hard runtime tool disabling.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { notFound, PROTOCOL_VERSION, Rpc } from './acp.ts'
import { assertRegularMemberUid, openCodeMemberFetch } from './t3-local.ts'

export type OpenCodeProvider = { kind: 'opencode'; key: string; bin: string }
export type AntigravityProvider = {
  kind: 'antigravity'
  key: string
  bin: string
  harnessPath?: string
  authMethod: 'oauth-personal'
  tokenPath: string
  settingsPath?: string
}
export type SupervisorProvider = OpenCodeProvider | AntigravityProvider

export type OpenCodeTarget = { kind: 'opencode'; bin: string; providerID: string; id: string; variant?: string }
export type AntigravityTarget = {
  kind: 'antigravity'
  bin: string
  harnessPath?: string
  authMethod: 'oauth-personal'
  tokenPath: string
  settingsPath?: string
  id: string
  variant?: string
}
export type SupervisorTarget = OpenCodeTarget | AntigravityTarget
export type SupervisorModel = { id: string; variants: string[]; displayName?: string }
export type SupervisorTimeouts = { startupMs?: number; requestMs?: number; idleMs?: number }

type OpenCodeRequest = (path: string, body?: object) => Promise<Response>
type OpenCodeModel = { providerID: string; id: string; variants: string[] }
type AcpOptionEntry = { value?: string; name?: string; options?: AcpOptionEntry[] }
type AcpConfigOption = { id: string; category?: string; currentValue?: string; options?: AcpOptionEntry[] }

const RATE_LIMIT_RE = /\b(?:429|rate[_ ]?limit|too many requests|resource[_ ]?exhausted|quota[_ ]?exhausted|usage limit reached)\b/i
const AGY_QUOTA_CHUNK_RE = /^(?:Usage Limit Reached\b|Error 429\b[^\n]*RESOURCE_EXHAUSTED)/i
const AGY_API_ERROR_CHUNK_RE = /^Error \d{3},\s*Message:/i

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('The supervisor operation timed out.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('The supervisor operation timed out.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return
  try { process.kill(-pid, sig) } catch { /* process group may already be gone */ }
}

/** Validate a regular non-symlink member-owned credential/config file before copying into an ephemeral home. */
export function assertMemberOwnedRegularFile(filePath: string, uid: number): void {
  const st = lstatSync(filePath)
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid) {
    throw new Error('The local Antigravity credential file must be a regular file owned by this Linux member.')
  }
}

export function validateAntigravitySettingsFile(filePath: string, uid: number): 'oauth-personal' | undefined {
  assertMemberOwnedRegularFile(filePath, uid)
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Antigravity settings.')
  if (Object.keys(parsed).some((k) => k !== 'auth')) throw new Error('Unsupported Antigravity settings keys.')
  const auth = parsed.auth as Record<string, unknown> | undefined
  if (auth !== undefined) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Invalid Antigravity auth settings.')
    if (Object.keys(auth).some((k) => k !== 'type')) throw new Error('Unsupported Antigravity auth settings keys.')
    if (auth.type !== undefined && auth.type !== 'oauth-personal') throw new Error('Unsupported Antigravity auth method.')
    return auth.type
  }
  return undefined
}

function flattenOptions(opt: AcpConfigOption | undefined): { value: string; name?: string }[] {
  if (!opt?.options) return []
  const flat: { value: string; name?: string }[] = []
  for (const entry of opt.options) {
    if (Array.isArray(entry.options)) {
      for (const sub of entry.options) if (typeof sub.value === 'string' && sub.value) flat.push({ value: sub.value, name: sub.name })
    } else if (typeof entry.value === 'string' && entry.value) {
      flat.push({ value: entry.value, name: entry.name })
    }
  }
  return flat
}

const findModelOption = (opts: AcpConfigOption[] | undefined) => opts?.find((c) => c.category === 'model' || c.id === 'model')
const findThoughtOption = (opts: AcpConfigOption[] | undefined) => opts?.find((c) => c.category === 'thought_level' || c.id === 'thinking_level')

/** The server chooses the port and reports it on stdout. Each invocation has its own password and lifetime. */
async function withOpenCode<T>(bin: string, use: (request: OpenCodeRequest, models: OpenCodeModel[]) => Promise<T>, timeouts: SupervisorTimeouts = {}) {
  assertRegularMemberUid(process.getuid?.())
  const startupMs = timeouts.startupMs ?? 45_000
  const requestMs = timeouts.requestMs ?? 155_000
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
    child.once('error', () => { ended.abort(new Error('Could not start the T3 OpenCode supervisor.')); resolve() })
    child.once('close', () => { ended.abort(new Error('The T3 OpenCode supervisor stopped.')); resolve() })
  })
  const signal = AbortSignal.any([ended.signal, AbortSignal.timeout(requestMs)])
  const starting = AbortSignal.any([signal, AbortSignal.timeout(startupMs)])
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
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500)
    try { await stopped } finally { clearTimeout(kill) }
  }
}

type AntigravityCallHooks = {
  onText: (text: string) => void
  onToolViolation: (reason: string) => void
}

type AntigravityWorker = {
  key: string
  slot: string
  workDir: string
  runDir: string
  child: ReturnType<typeof spawn>
  rpc: Rpc
  ended: AbortController
  stopped: Promise<void>
  disposed: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  queue: Promise<void>
  hooks?: AntigravityCallHooks
  dispose: (force?: boolean) => Promise<void>
  disposeSync: () => void
  touch: (idleMs: number) => void
}

const DEFAULT_IDLE_MS = 5 * 60_000
const antigravityPool = new Map<string, AntigravityWorker>()
const antigravityStarting = new Map<string, { key: string; promise: Promise<AntigravityWorker> }>()

function antigravityWorkerKey(provider: Omit<AntigravityProvider, 'key'>, uid: number) {
  assertMemberOwnedRegularFile(provider.tokenPath, uid)
  const tokenStat = lstatSync(provider.tokenPath)
  let settingsSig = ''
  if (provider.settingsPath) {
    validateAntigravitySettingsFile(provider.settingsPath, uid)
    const st = lstatSync(provider.settingsPath)
    settingsSig = `${provider.settingsPath}:${st.mtimeMs}:${st.size}`
  }
  const slot = `${provider.bin} ${provider.harnessPath ?? ''} ${provider.tokenPath}`
  const key = `${slot} ${provider.authMethod} ${tokenStat.mtimeMs}:${tokenStat.size} ${settingsSig}`
  return { slot, key }
}

async function startAntigravityWorker(
  provider: Omit<AntigravityProvider, 'key'>,
  slot: string,
  key: string,
  startupMs: number,
  idleMs: number,
): Promise<AntigravityWorker> {
  const runDir = mkdtempSync(join(tmpdir(), 'devdash-t3-agy-'))
  const workDir = join(runDir, 'work')
  const homeDir = join(runDir, 'home')
  const geminiHome = join(runDir, 'gemini')
  const acpDir = join(geminiHome, 'antigravity-acp')
  try {
    chmodSync(runDir, 0o700)
    mkdirSync(workDir, { mode: 0o700 })
    mkdirSync(homeDir, { mode: 0o700 })
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    const tokenCopy = join(acpDir, 'acp_token.json')
    copyFileSync(provider.tokenPath, tokenCopy)
    chmodSync(tokenCopy, 0o600)
    const settingsCopy = join(acpDir, 'settings.json')
    writeFileSync(settingsCopy, JSON.stringify({ auth: { type: provider.authMethod } }), { mode: 0o600 })
  } catch (err) {
    rmSync(runDir, { recursive: true, force: true })
    throw err
  }

  const sslCert = process.env.SSL_CERT_FILE && existsSync(process.env.SSL_CERT_FILE)
    ? process.env.SSL_CERT_FILE
    : existsSync('/etc/ssl/certs/ca-certificates.crt') ? '/etc/ssl/certs/ca-certificates.crt' : undefined
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir,
    GEMINI_HOME: geminiHome,
    TMPDIR: runDir,
    LANG: process.env.LANG || 'C.UTF-8',
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    BROWSER: '/bin/false',
    ...(provider.harnessPath ? { ANTIGRAVITY_HARNESS_PATH: provider.harnessPath } : {}),
    ...(sslCert ? { SSL_CERT_FILE: sslCert } : {}),
  }

  const child = spawn(provider.bin, ['--uid='], {
    cwd: workDir,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env,
  })
  const ended = new AbortController()
  const stopped = new Promise<void>((resolve) => {
    child.once('error', () => { ended.abort(new Error('Could not start the T3 Antigravity supervisor.')); resolve() })
    child.once('close', () => { ended.abort(new Error('The T3 Antigravity supervisor stopped.')); resolve() })
  })

  const worker: AntigravityWorker = {
    key, slot, workDir, runDir, child, ended, stopped, disposed: false, queue: Promise.resolve(),
    rpc: undefined as unknown as Rpc,
    dispose: async (force = false) => {
      if (worker.disposed) {
        await stopped
        return
      }
      worker.disposed = true
      if (worker.idleTimer) { clearTimeout(worker.idleTimer); worker.idleTimer = undefined }
      if (antigravityPool.get(slot) === worker) antigravityPool.delete(slot)
      try { child.stdin.end() } catch { /* already closed */ }
      if (force) {
        killGroup(child.pid, 'SIGKILL')
        child.kill('SIGKILL')
      } else {
        killGroup(child.pid, 'SIGTERM')
        child.kill('SIGTERM')
      }
      const kill = setTimeout(() => { killGroup(child.pid, 'SIGKILL'); child.kill('SIGKILL') }, 1500)
      kill.unref?.()
      try { await stopped } finally {
        clearTimeout(kill)
        rmSync(runDir, { recursive: true, force: true })
      }
    },
    disposeSync: () => {
      worker.disposed = true
      if (worker.idleTimer) { clearTimeout(worker.idleTimer); worker.idleTimer = undefined }
      if (antigravityPool.get(slot) === worker) antigravityPool.delete(slot)
      killGroup(child.pid, 'SIGKILL')
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try { rmSync(runDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
    touch: (ms: number) => {
      if (worker.idleTimer) clearTimeout(worker.idleTimer)
      if (worker.disposed || ms <= 0) return
      worker.idleTimer = setTimeout(() => { void worker.dispose(false) }, ms)
      worker.idleTimer.unref?.()
    },
  }

  void stopped.then(() => {
    if (!worker.disposed) void worker.dispose(false)
  })

  worker.rpc = new Rpc(child, {
    notify: (method, params) => {
      const u = (params.update ?? {}) as { sessionUpdate?: string; content?: { type?: string; text?: string } }
      if (method !== 'session/update') return
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const reason = 'The T3 Antigravity supervisor attempted a tool call and was stopped.'
        worker.hooks?.onToolViolation(reason)
        ended.abort(new Error(reason))
        killGroup(child.pid, 'SIGKILL')
        child.kill('SIGKILL')
        return
      }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
        worker.hooks?.onText(u.content.text)
      }
    },
    request: async (method) => {
      if (method === 'session/request_permission') {
        const reason = 'The T3 Antigravity supervisor requested tool permission and was stopped.'
        worker.hooks?.onToolViolation(reason)
        ended.abort(new Error(reason))
        killGroup(child.pid, 'SIGKILL')
        child.kill('SIGKILL')
        return { outcome: { outcome: 'cancelled' } }
      }
      throw notFound(method)
    },
  })

  const initSignal = AbortSignal.any([ended.signal, AbortSignal.timeout(startupMs)])
  try {
    const init = await withSignal(worker.rpc.request<{ authMethods?: { id: string }[] }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }), initSignal)
    if (Array.isArray(init.authMethods) && init.authMethods.length > 0) {
      if (!init.authMethods.some((a) => a.id === provider.authMethod)) {
        throw new Error('The T3 Antigravity supervisor does not support the verified member auth method.')
      }
      await withSignal(worker.rpc.request('authenticate', { methodId: provider.authMethod }), initSignal)
    }
    worker.touch(idleMs)
    return worker
  } catch (err) {
    await worker.dispose(true)
    throw err
  }
}

export async function disposeSupervisorWorkers(): Promise<void> {
  const workers = [...antigravityPool.values()]
  antigravityPool.clear()
  await Promise.allSettled(workers.map((w) => w.dispose(false)))
}

process.once('exit', () => {
  for (const w of [...antigravityPool.values()]) w.disposeSync()
})

/**
 * Antigravity ACP with hard runtime/protocol-level tool disabling:
 * - clientCapabilities advertises fs=false and terminal=false (no client callback tools)
 * - every call uses a fresh ephemeral session/new with mcpServers: [] and _meta.antigravity.enabledTools: [] and deletes it in finally
 * - runs in an isolated 0700 HOME / GEMINI_HOME / cwd containing only the member's verified oauth-personal token
 * - keeps the initialized ACP process warm between calls to avoid ~12s .par cold starts, and kills/wipes immediately on violation, timeout, or idle expiry
 */
async function withAntigravity<T>(
  provider: Omit<AntigravityProvider, 'key'>,
  use: (ctx: {
    sessionId: string
    configOptions: AcpConfigOption[]
    call: <R>(method: string, params: Record<string, unknown>, sig?: AbortSignal) => Promise<R>
    promptSignal: AbortSignal
    startupSignal: AbortSignal
    consumeOutput: () => { text: string; toolViolation: boolean }
  }) => Promise<T>,
  timeouts: SupervisorTimeouts = {},
): Promise<T> {
  const uid = assertRegularMemberUid(process.getuid?.())
  const { slot, key } = antigravityWorkerKey(provider, uid)
  const startupMs = timeouts.startupMs ?? 45_000
  const requestMs = timeouts.requestMs ?? 155_000
  const idleMs = timeouts.idleMs ?? DEFAULT_IDLE_MS

  const acquireWorker = async (): Promise<AntigravityWorker> => {
    let w = antigravityPool.get(slot)
    if (w && (w.key !== key || w.disposed || w.rpc.closed || w.ended.signal.aborted)) {
      antigravityPool.delete(slot)
      await w.dispose(false)
      w = undefined
    }
    if (w) return w
    if (idleMs > 0) {
      const inflight = antigravityStarting.get(slot)
      if (inflight && inflight.key === key) {
        const started = await inflight.promise
        if (!started.disposed && !started.rpc.closed && !started.ended.signal.aborted) return started
      }
      const promise = startAntigravityWorker(provider, slot, key, startupMs, idleMs).then((started) => {
        if (!started.disposed) antigravityPool.set(slot, started)
        return started
      }).finally(() => {
        if (antigravityStarting.get(slot)?.promise === promise) antigravityStarting.delete(slot)
      })
      antigravityStarting.set(slot, { key, promise })
      return await promise
    }
    return startAntigravityWorker(provider, slot, key, startupMs, idleMs)
  }
  let worker = await acquireWorker()

  const runOnWorker = async (w: AntigravityWorker): Promise<T> => {
    if (w.disposed || w.rpc.closed || w.ended.signal.aborted) {
      throw new Error('The T3 Antigravity supervisor stopped.')
    }
    if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = undefined }

    const callAbort = new AbortController()
    const promptSignal = AbortSignal.any([w.ended.signal, callAbort.signal, AbortSignal.timeout(requestMs)])
    const startupSignal = AbortSignal.any([promptSignal, AbortSignal.timeout(startupMs)])

    let output = ''
    let toolViolation = false
    let poisoned = false
    w.hooks = {
      onText: (chunk) => { output += chunk },
      onToolViolation: (reason) => {
        toolViolation = true
        poisoned = true
        callAbort.abort(new Error(reason))
      },
    }
    const call = <R>(method: string, params: Record<string, unknown>, sig = startupSignal) =>
      withSignal(w.rpc.request<R>(method, params), sig).catch((err) => {
        if (sig.aborted || w.rpc.closed || w.ended.signal.aborted) poisoned = true
        throw err
      })

    let sessionId: string | undefined
    try {
      const created = await call<{ sessionId: string; configOptions?: AcpConfigOption[] }>('session/new', {
        cwd: w.workDir,
        mcpServers: [],
        _meta: { antigravity: { enabledTools: [] } },
      })
      if (!created.sessionId) throw new Error('The T3 Antigravity supervisor did not create a session.')
      sessionId = created.sessionId
      return await use({
        sessionId,
        configOptions: created.configOptions ?? [],
        call,
        promptSignal,
        startupSignal,
        consumeOutput: () => ({ text: output, toolViolation }),
      })
    } finally {
      w.hooks = undefined
      if (poisoned || toolViolation || w.disposed || w.rpc.closed || w.ended.signal.aborted || idleMs <= 0) {
        await w.dispose(true)
      } else {
        if (sessionId) {
          await Promise.race([w.rpc.request('session/delete', { sessionId }).catch(() => {}), delay(500)])
        }
        if (w.rpc.closed || w.ended.signal.aborted) await w.dispose(true)
        else w.touch(idleMs)
      }
    }
  }

  // Serialize calls on the warm worker so session/update chunks never interleave.
  const previous = worker.queue
  let release!: () => void
  worker.queue = new Promise<void>((r) => { release = r })
  await previous
  try {
    if (worker.disposed || worker.rpc.closed || worker.ended.signal.aborted) {
      worker = await acquireWorker()
    }
    return await runOnWorker(worker)
  } finally {
    release()
  }
}

export async function supervisorModels(provider: SupervisorProvider, timeouts?: SupervisorTimeouts): Promise<SupervisorModel[]> {
  if (provider.kind === 'opencode') {
    const models = await withOpenCode(provider.bin, async (_request, list) => list, timeouts)
    return models.map((m) => ({ id: `${m.providerID}/${m.id}`, variants: m.variants }))
  }
  return withAntigravity(provider, async ({ sessionId, configOptions, call, startupSignal }) => {
    const modelOpt = findModelOption(configOptions)
    const choices = flattenOptions(modelOpt)
    if (!modelOpt || !choices.length) return []
    const models: SupervisorModel[] = []
    let currentOptions = configOptions
    let currentModel = modelOpt.currentValue
    for (const choice of choices) {
      if (currentModel !== choice.value) {
        const updated = await call<{ configOptions?: AcpConfigOption[] }>(
          'session/set_config_option',
          { sessionId, configId: modelOpt.id, value: choice.value },
          startupSignal,
        )
        currentOptions = updated.configOptions ?? currentOptions
        currentModel = findModelOption(currentOptions)?.currentValue
        if (currentModel !== choice.value) continue
      }
      const thoughtOpt = findThoughtOption(currentOptions)
      const variants = flattenOptions(thoughtOpt).map((v) => v.value)
      models.push({ id: choice.value, displayName: choice.name || choice.value, variants })
    }
    return models
  }, timeouts)
}

export function supervisorText(target: SupervisorTarget, prompt: string, timeouts?: SupervisorTimeouts): Promise<string> {
  if (target.kind === 'opencode') {
    return withOpenCode(target.bin, async (request, models) => {
      const selected = models.find((m) => m.providerID === target.providerID && m.id === target.id)
      if (!selected) throw new Error('This supervisor model is unavailable in the local T3 OpenCode catalog.')
      if (target.variant && !selected.variants.includes(target.variant)) throw new Error('This thinking level is unavailable in the local T3 OpenCode supervisor.')
      const model = { providerID: target.providerID, id: target.id, ...(target.variant ? { variant: target.variant } : {}) }
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
    }, timeouts)
  }

  return withAntigravity(target, async ({ sessionId, configOptions, call, promptSignal, startupSignal, consumeOutput }) => {
    const modelOpt = findModelOption(configOptions)
    const modelChoices = flattenOptions(modelOpt)
    if (!modelOpt || !modelChoices.some((m) => m.value === target.id)) {
      throw new Error('This supervisor model is unavailable in the local T3 Antigravity catalog.')
    }
    let activeOptions = configOptions
    const setModel = await call<{ configOptions?: AcpConfigOption[] }>(
      'session/set_config_option',
      { sessionId, configId: modelOpt.id, value: target.id },
      startupSignal,
    )
    activeOptions = setModel.configOptions ?? activeOptions
    if (findModelOption(activeOptions)?.currentValue !== target.id) {
      throw new Error('This supervisor model is unavailable in the local T3 Antigravity catalog.')
    }
    if (target.variant) {
      const thoughtOpt = findThoughtOption(activeOptions)
      const levels = flattenOptions(thoughtOpt).map((v) => v.value)
      if (!thoughtOpt || !levels.includes(target.variant)) {
        throw new Error('This thinking level is unavailable in the local T3 Antigravity supervisor.')
      }
      const setThought = await call<{ configOptions?: AcpConfigOption[] }>(
        'session/set_config_option',
        { sessionId, configId: thoughtOpt.id, value: target.variant },
        startupSignal,
      )
      activeOptions = setThought.configOptions ?? activeOptions
      if (findThoughtOption(activeOptions)?.currentValue !== target.variant) {
        throw new Error('This thinking level is unavailable in the local T3 Antigravity supervisor.')
      }
    }

    let result: { stopReason?: string; usage?: { used?: number } }
    try {
      result = await call<{ stopReason?: string; usage?: { used?: number } }>(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] },
        promptSignal,
      )
    } catch (err) {
      const { toolViolation } = consumeOutput()
      if (toolViolation) throw new Error('The T3 Antigravity supervisor attempted a tool call and was stopped.')
      const msg = err instanceof Error ? err.message : ''
      if (RATE_LIMIT_RE.test(msg)) throw new Error('The T3 Antigravity supervisor reached its rate limit.')
      if (err instanceof Error && (err.name === 'TimeoutError' || /timed out/i.test(msg))) {
        throw new Error('The T3 Antigravity supervisor timed out.')
      }
      throw new Error('The T3 Antigravity supervisor could not generate text.')
    }

    const { text, toolViolation } = consumeOutput()
    if (toolViolation) throw new Error('The T3 Antigravity supervisor attempted a tool call and was stopped.')
    const trimmed = text.trim()
    if (result.stopReason === 'refusal') {
      if (RATE_LIMIT_RE.test(trimmed)) throw new Error('The T3 Antigravity supervisor reached its rate limit.')
      throw new Error('The T3 Antigravity supervisor refused the request.')
    }
    if (result.stopReason !== 'end_turn') {
      throw new Error('The T3 Antigravity supervisor did not complete the turn.')
    }
    // Antigravity ACP catches backend quota/429 errors and emits them as a text chunk with zero turn usage.
    if (AGY_QUOTA_CHUNK_RE.test(trimmed) || (result.usage?.used === 0 && RATE_LIMIT_RE.test(trimmed))) {
      throw new Error('The T3 Antigravity supervisor reached its rate limit.')
    }
    if (result.usage?.used === 0 && AGY_API_ERROR_CHUNK_RE.test(trimmed)) {
      throw new Error('The T3 Antigravity supervisor could not generate text.')
    }
    if (!trimmed) throw new Error('The T3 Antigravity supervisor returned no text.')
    return text
  }, timeouts)
}
