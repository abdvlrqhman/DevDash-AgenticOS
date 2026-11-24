// T3 Code's own MCP integration. Credentials belong to the DevDash member; the configured T3 server runs the tools.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { T3Client, configPath } from './t3-client.ts'

type Model = { id: string; label?: string | null; options?: { id: string; values: (string | boolean)[] }[] | null }
export type Capabilities = {
  runtimeMode: string
  providers: { providerInstanceId: string; canRunChildTask: boolean; displayName: string | null; runtimeModes?: string[]; models: Model[]; omittedModels?: number }[]
}
export const installed = () => existsSync(configPath())
export const modelId = (instance: string, model: string) => `${instance}/${model}`
export function selection(value: string) {
  const split = value.indexOf('/')
  if (split < 1 || !value.slice(split + 1)) throw new Error('Choose a T3 Code provider/model from the model list.')
  return { instanceId: value.slice(0, split), model: value.slice(split + 1) }
}
/** The MCP catalog exposes native option IDs and values. Each driver names its reasoning control. */
export function effortOption(model: Model | undefined) {
  const opt = model?.options?.find((o) => /reasoning.*effort|thinking[_-]?level|thought[_-]?level|^(effort|variant)$/i.test(o.id))
  if (!opt) return undefined
  return { id: opt.id, levels: opt.values.filter((v): v is string => typeof v === 'string' && v !== 'default') }
}
/** T3's runnable flag includes enabled state, executable availability and authentication checks.
 * Its catalog also contains disabled providers and their models, which must not be offered as connected. */
export async function connectedCapabilities(client: T3Client, search?: string): Promise<Capabilities> {
  const capabilities = await client.call<Capabilities>('orchestrator_capabilities', search ? { search } : {})
  return { ...capabilities, providers: capabilities.providers.filter((p) => p.canRunChildTask === true) }
}
export async function inspect(budgetMs = 5000, search?: string) {
  const client = new T3Client(undefined, { timeoutMs: budgetMs, signal: AbortSignal.timeout(budgetMs) })
  try {
    await client.connect()
    const capabilities = await connectedCapabilities(client, search)
    return { version: client.serverVersion, capabilities }
  } finally { await client.close() }
}
export async function modelChoices(search?: string) {
  const { capabilities } = await inspect(5000, search)
  // The service catalog does not identify which model a new project will use for Default.
  return [
    { value: '', displayName: 'Default', description: "T3 Code's own default" },
    ...capabilities.providers.flatMap((p) => p.models.map((m) => {
      const value = modelId(p.providerInstanceId, m.id)
      return { value, displayName: m.label || m.id, description: value, group: p.providerInstanceId, supportedEffortLevels: effortOption(m)?.levels ?? [] }
    })),
  ]
}
let cached: { key: string; at: number; value: Awaited<ReturnType<typeof probeInfo>> } | undefined
let probing: { key: string; value: Promise<Awaited<ReturnType<typeof probeInfo>>> } | undefined
let generation = 0
export const invalidateInfo = () => { generation++; cached = undefined; probing = undefined }
async function probeInfo() {
  try {
    const { version, capabilities } = await inspect(1500)
    return { harness: 't3code', installed: true, version, profiles: [{ name: 'default', providers: capabilities.providers.filter((p) => p.models.length).map((p) => p.displayName ?? p.providerInstanceId) }] }
  } catch {
    return { harness: 't3code', installed: false, version: null, profiles: [], error: 'Cannot connect to your member-owned T3 Code instance. Check its service and connection configuration.' }
  }
}
export async function info() {
  if (!installed()) return { harness: 't3code', installed: false, version: null, profiles: [], error: 'No member-owned T3 Code connection configured for your account.' }
  let key: string
  try { key = `${configPath()}:${statSync(configPath()).mtimeMs}` } catch { return probeInfo() }
  if (cached?.key === key && Date.now() - cached.at < 15_000) return cached.value
  if (probing?.key === key) return probing.value
  const started = generation
  const value = probeInfo().then((value) => { if (generation === started) cached = { key, at: Date.now(), value }; return value }).finally(() => { if (probing?.value === value) probing = undefined })
  probing = { key, value }
  return value
}

const execFileAsync = promisify(execFile)
const SETUP_SCRIPT = fileURLToPath(new URL('../../../deploy/t3-setup.mjs', import.meta.url))

export type T3SetupKind = 'connect' | 'pair' | 'status'

/** Command launched inside a DevDash terminal tab (t3-connect / t3-pair / t3-status) as this member. */
export function setupCommand(kind: T3SetupKind) {
  return { env: {} as Record<string, string>, args: [process.execPath, SETUP_SCRIPT, kind, '--interactive'] }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

async function pickMemberPort(): Promise<number> {
  const uid = process.getuid?.() ?? 1000
  const span = 3899 - 3781 + 1
  const offset = Math.abs(uid) % span
  for (let i = 0; i < span; i++) {
    const port = 3781 + ((offset + i) % span)
    if (await portFree(port)) return port
  }
  throw new Error('No free local port available for devdash-t3 (3781-3899).')
}

/**
 * Prepares this member's private T3 Code directories and ~/.config/devdash/t3-service.env
 * strictly as the unprivileged member (so the root helper never touches paths in /home/<user>).
 */
export async function prepareService(): Promise<{ port: number; baseDir: string; url: string }> {
  const home = homedir()
  const baseDir = join(home, '.local', 'share', 'devdash-t3')
  const cfgDir = join(home, '.config', 'devdash')
  const envFile = join(cfgDir, 't3-service.env')
  mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 })

  let port: number | null = null
  if (existsSync(envFile)) {
    const st = lstatSync(envFile)
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error('~/.config/devdash/t3-service.env must be a regular file.')
    }
    const m = readFileSync(envFile, 'utf8').match(/^\s*DEVDASH_T3_PORT\s*=\s*(\d{4,5})\s*$/m)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n >= 1024 && n <= 65535) port = n
    }
  }
  if (!port) {
    port = await pickMemberPort()
    const tmp = `${envFile}.tmp-${randomBytes(6).toString('hex')}`
    writeFileSync(tmp, `DEVDASH_T3_PORT=${port}\n`, { mode: 0o600 })
    renameSync(tmp, envFile)
  }
  return { port, baseDir, url: `http://127.0.0.1:${port}/mcp` }
}

/** Connects or renews this member's own T3 Code credential via deploy/t3-setup.mjs and refreshes capabilities. */
export async function connectMember(opts: { url?: string; baseDir?: string; t3Bin?: string } = {}) {
  const args = [SETUP_SCRIPT, 'connect', '--json']
  if (opts.url) args.push('--url', opts.url)
  if (opts.baseDir) args.push('--base-dir', opts.baseDir)
  if (opts.t3Bin) args.push('--t3-bin', opts.t3Bin)
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }))
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr || e.message || 'Could not connect T3 Code.').trim()
    throw new Error(msg.split('\n')[0] || 'Could not connect T3 Code.')
  }
  const parsed = JSON.parse(stdout.trim()) as { config: string; expiresAt: string; renewed: boolean; revokedOld: boolean }
  const agent = await info()
  return { agent, expiresAt: parsed.expiresAt, renewed: parsed.renewed, revokedOld: parsed.revokedOld }
}

/** Revokes this member's DevDash OAuth session in T3 Code and removes ~/.config/devdash/t3code.json. */
export async function disconnectMember() {
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync(process.execPath, [SETUP_SCRIPT, 'disconnect', '--json'], { timeout: 20_000, maxBuffer: 1024 * 1024 }))
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr || e.message || 'Could not disconnect T3 Code.').trim()
    throw new Error(msg.split('\n')[0] || 'Could not disconnect T3 Code.')
  }
  return JSON.parse(stdout.trim()) as { removed: boolean; revoked: boolean }
}
