// T3 Code's own MCP integration. Credentials belong to the DevDash member; the configured T3 server runs the tools.
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { assertRegularMemberUid } from './t3-local.ts'
import {
  assertMemberOwnedRegularFile,
  disposeSupervisorWorkers,
  supervisorModels,
  validateAntigravitySettingsFile,
  type SupervisorModel,
  type SupervisorProvider,
  type SupervisorTarget,
} from './t3-supervisor.ts'
import { T3Client, configPath, readConfig, type T3CallOptions } from './t3-client.ts'

type Model = { id: string; label?: string | null; options?: { id: string; values: (string | boolean)[] }[] | null }
export type Capabilities = {
  runtimeMode: string
  providers: { providerInstanceId: string; driverKind?: string; canRunChildTask: boolean; displayName: string | null; runtimeModes?: string[]; models: Model[]; omittedModels?: number }[]
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
export function configRevision(): string {
  try {
    const file = configPath()
    const st = statSync(file)
    return `${file}:${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

const SHARED_CLIENT_IDLE_MS = 5 * 60_000
type SharedClientEntry = { key: string; generation: number; client: T3Client; ready: boolean; idleTimer?: ReturnType<typeof setTimeout> }
let sharedClient: SharedClientEntry | undefined

function closeSharedClient(entry = sharedClient) {
  if (!entry) return
  if (sharedClient === entry) sharedClient = undefined
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
  void entry.client.close()
}

function touchSharedClient(entry: SharedClientEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  if (sharedClient !== entry) return
  entry.idleTimer = setTimeout(() => closeSharedClient(entry), SHARED_CLIENT_IDLE_MS)
  entry.idleTimer.unref?.()
}

function acquireSharedClient(): { entry: SharedClientEntry; reused: boolean } {
  const key = configRevision()
  if (sharedClient && sharedClient.key === key && sharedClient.generation === generation) {
    return { entry: sharedClient, reused: sharedClient.ready }
  }
  closeSharedClient()
  const entry: SharedClientEntry = { key, generation, client: new T3Client(), ready: false }
  sharedClient = entry
  return { entry, reused: false }
}

process.once('exit', () => {
  if (sharedClient?.idleTimer) clearTimeout(sharedClient.idleTimer)
  sharedClient = undefined
})

export async function connectedCapabilities(client: T3Client, search?: string, options?: T3CallOptions): Promise<Capabilities> {
  const capabilities = await client.call<Capabilities>('orchestrator_capabilities', search ? { search } : {}, options)
  return { ...capabilities, providers: capabilities.providers.filter((p) => p.canRunChildTask === true) }
}

let fullCapsCache: { key: string; at: number; version: string | null; capabilities: Capabilities } | undefined

export async function inspect(budgetMs = 5000, search?: string, full = false) {
  const started = generation
  const rev = configRevision()
  const cacheKey = `${started}:${rev}`
  if (full && !search && fullCapsCache && fullCapsCache.key === cacheKey && Date.now() - fullCapsCache.at < 60_000) {
    return { version: fullCapsCache.version, capabilities: fullCapsCache.capabilities }
  }
  const deadline = Date.now() + budgetMs
  const runOnce = async (entry: SharedClientEntry) => {
    const remaining = Math.max(1, deadline - Date.now())
    const opts: T3CallOptions = { timeoutMs: remaining, signal: AbortSignal.timeout(remaining) }
    await entry.client.connect(opts)
    const capabilities = await connectedCapabilities(entry.client, search, opts)
    if (full && !search) await expandShortlists(entry.client, capabilities, opts)
    entry.ready = true
    touchSharedClient(entry)
    return { version: entry.client.serverVersion, capabilities }
  }
  const { entry, reused } = acquireSharedClient()
  let result: { version: string | null; capabilities: Capabilities }
  try {
    result = await runOnce(entry)
  } catch (err) {
    closeSharedClient(entry)
    if (!reused || Date.now() >= deadline - 100) throw err
    // A warm MCP session can expire if T3 Code restarts; retry once on a fresh session for read-only discovery.
    const fresh = acquireSharedClient().entry
    try {
      result = await runOnce(fresh)
    } catch (retryErr) {
      closeSharedClient(fresh)
      throw retryErr
    }
  }
  if (generation === started && !search) {
    capsCache = { key: cacheKey, at: Date.now(), capabilities: result.capabilities }
    if (full) fullCapsCache = { key: cacheKey, at: Date.now(), version: result.version, capabilities: result.capabilities }
  }
  return result
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveAntigravityBinary(baseDir: string, config: Record<string, unknown>, uid: number): { bin: string; harnessPath?: string } | undefined {
  let bin: string | undefined
  if (config.binaryPath !== undefined) {
    if (typeof config.binaryPath !== 'string' || !isAbsolute(config.binaryPath)) return undefined
    bin = config.binaryPath
  } else {
    const toolRoot = join(baseDir, 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`)
    const activePath = join(toolRoot, 'active.json')
    try {
      assertMemberOwnedRegularFile(activePath, uid)
      const active = JSON.parse(readFileSync(activePath, 'utf8')) as unknown
      if (!isPlainObject(active)) return undefined
      const releaseId = active.releaseId
      if (typeof releaseId !== 'string' || !/^[a-f0-9]{16,128}$/i.test(releaseId)) return undefined
      bin = join(toolRoot, 'versions', releaseId, 'agy_acp_server.par')
    } catch {
      return undefined
    }
  }
  if (!isExecutableFile(bin)) return undefined
  const siblingHarness = join(dirname(bin), 'localharness_external')
  const harnessPath = isExecutableFile(siblingHarness) ? siblingHarness : undefined
  return { bin, harnessPath }
}

/** Reuse only member-owned provider instances whose driver can guarantee hard tool-free execution:
 * - OpenCode: stateless /api/experimental/generate/text with deny-all policies & per-run auth
 * - Antigravity: ephemeral ACP server with clientCapabilities fs/terminal=false, mcpServers=[], enabledTools=[], isolated HOME/GEMINI_HOME
 * Drivers like Codex keep built-in exec/collaboration tools enabled even with read-only sandboxes and stay chat-only. */
function supervisorProviders(providers: Capabilities['providers']): Map<string, SupervisorProvider> {
  const result = new Map<string, SupervisorProvider>()
  const { baseDir } = readConfig()
  if (!baseDir) return result
  try {
    const uid = assertRegularMemberUid(process.getuid?.())
    const settingsFile = join(baseDir, 'userdata', 'settings.json')
    assertMemberOwnedRegularFile(settingsFile, uid)
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { providerInstances?: Record<string, unknown> }
    if (!isPlainObject(settings.providerInstances)) return result

    for (const p of providers) {
      const instance = settings.providerInstances[p.providerInstanceId]
      if (!isPlainObject(instance) || instance.enabled === false) continue
      if (Object.keys(instance).some((k) => !['driver', 'enabled', 'config', 'displayName'].includes(k))) continue
      const config = instance.config === undefined ? {} : instance.config
      if (!isPlainObject(config) || config.enabled === false) continue

      if (p.driverKind === 'opencode' && instance.driver === 'opencode') {
        if (Object.keys(config).some((k) => !['binaryPath', 'customModels', 'enabled'].includes(k))) continue
        const bin = config.binaryPath
        if (typeof bin !== 'string' || !isAbsolute(bin) || !isExecutableFile(bin)) continue
        result.set(p.providerInstanceId, { kind: 'opencode', key: `opencode:${bin}`, bin })
        continue
      }

      if (p.driverKind === 'antigravity' && instance.driver === 'antigravity') {
        if (Object.keys(config).some((k) => !['enabled', 'authMethod', 'binaryPath', 'customModels'].includes(k))) continue
        if (config.authMethod !== undefined && config.authMethod !== 'oauth-personal') continue
        const resolved = resolveAntigravityBinary(baseDir, config, uid)
        if (!resolved) continue
        const providerHash = createHash('sha256').update(p.providerInstanceId).digest('hex')
        const acpDir = join(baseDir, 'userdata', 'providers', 'antigravity', providerHash, 'antigravity-acp')
        const tokenPath = join(acpDir, 'acp_token.json')
        const agySettingsPath = join(acpDir, 'settings.json')
        try {
          assertMemberOwnedRegularFile(tokenPath, uid)
          let settingsPath: string | undefined
          let fileAuthType: 'oauth-personal' | undefined
          if (existsSync(agySettingsPath)) {
            fileAuthType = validateAntigravitySettingsFile(agySettingsPath, uid)
            settingsPath = agySettingsPath
          }
          if (config.authMethod === undefined && fileAuthType !== 'oauth-personal') continue
          result.set(p.providerInstanceId, {
            kind: 'antigravity',
            key: `antigravity:${resolved.bin}:${resolved.harnessPath ?? ''}:${tokenPath}`,
            bin: resolved.bin,
            ...(resolved.harnessPath ? { harnessPath: resolved.harnessPath } : {}),
            authMethod: 'oauth-personal',
            tokenPath,
            ...(settingsPath ? { settingsPath } : {}),
          })
        } catch { /* An unverified Antigravity instance doesn't affect the member's other instances. */ }
      }
    }
  } catch { /* Other T3 chat models remain available without local provider configuration. */ }
  return result
}

// The MCP response is a shortlist. The member's T3 discovery snapshot supplies omitted IDs;
// exact live lookup confirms each before it can enter a picker.
async function expandShortlists(client: T3Client, caps: Capabilities, options?: T3CallOptions) {
  const { baseDir } = readConfig()
  if (!baseDir) return
  for (const provider of caps.providers) {
    if (!provider.omittedModels || !/^[\w.-]+$/.test(provider.providerInstanceId)) continue
    let ids: string[]
    try {
      const snapshot = JSON.parse(readFileSync(join(baseDir, 'caches', provider.providerInstanceId + '.json'), 'utf8'))
      if (snapshot.instanceId !== provider.providerInstanceId || snapshot.driver !== provider.driverKind) continue
      ids = snapshot.models.map((m: { slug: string }) => m.slug).filter((id: string) => typeof id === 'string' && !provider.models.some((m) => m.id === id))
    } catch { continue }
    for (let i = 0; i < ids.length; i += 6) {
      await Promise.allSettled(ids.slice(i, i + 6).map(async (id) => {
        const exact = await connectedCapabilities(client, id, options)
        const model = exact.providers.find((p) => p.providerInstanceId === provider.providerInstanceId)?.models.find((m) => m.id === id)
        if (model) provider.models.push(model)
      }))
    }
  }
}

const CATALOG_TTL_MS = 10 * 60_000
const openCodeDiskCachePath = () => join(homedir(), '.cache', 'devdash', 't3-opencode-catalog.json')

function openCodeCacheKey(bin: string): string | undefined {
  try {
    const st = statSync(bin)
    return `${bin}:${st.mtimeMs}:${st.size}:${configRevision()}`
  } catch {
    return undefined
  }
}

function readOpenCodeDiskCache(bin: string): SupervisorModel[] | undefined {
  const expectedKey = openCodeCacheKey(bin)
  if (!expectedKey) return undefined
  try {
    const uid = assertRegularMemberUid(process.getuid?.())
    const file = openCodeDiskCachePath()
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; at?: number; models?: SupervisorModel[] }
    if (parsed.key !== expectedKey || typeof parsed.at !== 'number' || Date.now() - parsed.at >= CATALOG_TTL_MS) return undefined
    if (!Array.isArray(parsed.models)) return undefined
    return parsed.models
  } catch {
    return undefined
  }
}

function writeOpenCodeDiskCache(bin: string, models: SupervisorModel[]): void {
  const key = openCodeCacheKey(bin)
  if (!key) return
  try {
    assertRegularMemberUid(process.getuid?.())
    const file = openCodeDiskCachePath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify({ key, at: Date.now(), models }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch { /* best-effort cache */ }
}

function clearOpenCodeDiskCache(): void {
  try { unlinkSync(openCodeDiskCachePath()) } catch { /* ignore */ }
}

const catalogCache = new Map<string, { at: number; models: ReturnType<typeof supervisorModels> }>()
function nativeCatalog(provider: SupervisorProvider, allowDiskCache = false) {
  const hit = catalogCache.get(provider.key)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models
  if (allowDiskCache && provider.kind === 'opencode') {
    const disk = readOpenCodeDiskCache(provider.bin)
    if (disk) {
      const models = Promise.resolve(disk)
      catalogCache.set(provider.key, { at: Date.now(), models })
      return models
    }
  }
  const models = supervisorModels(provider).then((list) => {
    if (provider.kind === 'opencode') writeOpenCodeDiskCache(provider.bin, list)
    return list
  })
  catalogCache.set(provider.key, { at: Date.now(), models })
  void models.catch(() => { if (catalogCache.get(provider.key)?.models === models) catalogCache.delete(provider.key) })
  return models
}
let capsCache: { key: string; at: number; capabilities: Capabilities } | undefined
async function cachedSupervisorCapabilities(): Promise<Capabilities> {
  const key = `${generation}:${configRevision()}`
  if (capsCache && capsCache.key === key && Date.now() - capsCache.at < 60_000) return capsCache.capabilities
  const { capabilities } = await inspect(5000)
  return capabilities
}

export async function nativeVariants(caps: Capabilities, instance: string, id: string) {
  const provider = supervisorProviders(caps.providers).get(instance)
  if (!provider || provider.kind !== 'opencode') return
  const models = await nativeCatalog(provider, true).catch(() => [])
  return models.find((m) => m.id === id)?.variants
}

export async function supervisorTarget(value: string, effort?: string): Promise<SupervisorTarget> {
  const { instanceId, model } = selection(value)
  const capabilities = await cachedSupervisorCapabilities()
  const provider = supervisorProviders(capabilities.providers).get(instanceId)
  if (!provider) throw new Error('Choose an available T3 Code supervisor model.')
  if (provider.kind === 'opencode') {
    if (!/^[^/]+\/.+/.test(model)) throw new Error('Choose an available T3 Code supervisor model.')
    const { instanceId: providerID, model: id } = selection(model)
    return { kind: 'opencode', bin: provider.bin, providerID, id, ...(effort ? { variant: effort } : {}) }
  }
  return {
    kind: 'antigravity',
    bin: provider.bin,
    ...(provider.harnessPath ? { harnessPath: provider.harnessPath } : {}),
    authMethod: provider.authMethod,
    tokenPath: provider.tokenPath,
    ...(provider.settingsPath ? { settingsPath: provider.settingsPath } : {}),
    id: model,
    ...(effort ? { variant: effort } : {}),
  }
}
export async function modelChoices(search?: string, supervisor = false) {
  const { capabilities } = await inspect(15_000, search, true)
  const providers = supervisorProviders(capabilities.providers)
  const unique = new Map<string, SupervisorProvider>()
  for (const provider of providers.values()) {
    // Only probe Antigravity when building supervisor pickers so chat pickers avoid .par startup overhead.
    if (!supervisor && provider.kind !== 'opencode') continue
    if (!unique.has(provider.key)) unique.set(provider.key, provider)
  }
  const catalogs = new Map<string, Awaited<ReturnType<typeof supervisorModels>>>()
  await Promise.allSettled([...unique.values()].map(async (provider) => catalogs.set(provider.key, await nativeCatalog(provider, !supervisor))))
  const rows = capabilities.providers.flatMap((p) => {
    const provider = providers.get(p.providerInstanceId)
    const native = provider ? catalogs.get(provider.key) : undefined
    const models = new Map(p.models.map((m) => [m.id, m]))
    if (supervisor) for (const n of native ?? []) {
      if (!models.has(n.id)) models.set(n.id, { id: n.id, label: n.displayName })
    }
    return [...models.values()].map((m) => {
      const value = modelId(p.providerInstanceId, m.id)
      const match = native?.find((n) => n.id === m.id)
      return { value, displayName: m.label || m.id, description: value, group: p.providerInstanceId,
        ...(supervisor && { supportsSupervisor: !!match }), supportedEffortLevels: match?.variants ?? effortOption(m)?.levels ?? [] }
    })
  })
  // T3 does not identify the model chosen for Default. The supervisor always requires an explicit model.
  return supervisor ? rows : [{ value: '', displayName: 'Default', description: "T3 Code's own default" }, ...rows]
}
let cached: { key: string; at: number; value: Awaited<ReturnType<typeof probeInfo>> } | undefined
let probing: { key: string; value: Promise<Awaited<ReturnType<typeof probeInfo>>> } | undefined
let generation = 0
export const invalidateInfo = () => {
  generation++
  closeSharedClient()
  catalogCache.clear()
  clearOpenCodeDiskCache()
  capsCache = undefined
  fullCapsCache = undefined
  cached = undefined
  probing = undefined
  void disposeSupervisorWorkers()
}
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
  const key = configRevision()
  if (!key) return probeInfo()
  if (cached?.key === key && Date.now() - cached.at < (cached.value.installed ? 60_000 : 15_000)) return cached.value
  if (probing?.key === key) return probing.value
  const started = generation
  const value = probeInfo().then((value) => { if (generation === started) cached = { key, at: Date.now(), value }; return value }).finally(() => { if (probing?.value === value) probing = undefined })
  probing = { key, value }
  return value
}
