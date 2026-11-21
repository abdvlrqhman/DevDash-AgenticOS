// T3 Code's own MCP integration. Credentials belong to the DevDash member; the configured T3 server runs the tools.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { supervisorModels } from './t3-supervisor.ts'
import { T3Client, configPath, readConfig } from './t3-client.ts'

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
export async function connectedCapabilities(client: T3Client, search?: string): Promise<Capabilities> {
  const capabilities = await client.call<Capabilities>('orchestrator_capabilities', search ? { search } : {})
  return { ...capabilities, providers: capabilities.providers.filter((p) => p.canRunChildTask === true) }
}
export async function inspect(budgetMs = 5000, search?: string, full = false) {
  const client = new T3Client(undefined, { timeoutMs: budgetMs, signal: AbortSignal.timeout(budgetMs) })
  try {
    await client.connect()
    const capabilities = await connectedCapabilities(client, search)
    if (full && !search) await expandShortlists(client, capabilities)
    return { version: client.serverVersion, capabilities }
  } finally { await client.close() }
}
/** Reuse only an OpenCode instance whose account and executable the member's local settings identify.
 * Custom environments or server connections may select a different account and require a separate adapter. */
function supervisorBins(providers: Capabilities['providers']): Map<string, string> {
  const bins = new Map<string, string>()
  const { baseDir } = readConfig()
  if (!baseDir) return bins
  try {
    const settings = JSON.parse(readFileSync(join(baseDir, 'userdata', 'settings.json'), 'utf8'))
    for (const p of providers) {
      const instance = settings.providerInstances?.[p.providerInstanceId]
      if (p.driverKind !== 'opencode' || instance?.driver !== 'opencode' || instance.enabled === false) continue
      if (Object.keys(instance).some((k) => !['driver', 'enabled', 'config', 'displayName'].includes(k))) continue
      const config = instance.config ?? {}
      if (config.enabled === false || Object.keys(config).some((k) => !['binaryPath', 'customModels', 'enabled'].includes(k))) continue
      const bin = config.binaryPath
      if (typeof bin !== 'string' || !isAbsolute(bin)) continue
      try {
        if (!statSync(bin).isFile()) continue
        accessSync(bin, constants.X_OK)
        bins.set(p.providerInstanceId, bin)
      } catch { /* An unusable executable doesn't affect the member's other instances. */ }
    }
  } catch { /* Other T3 chat models remain available without local provider configuration. */ }
  return bins
}

// The MCP response is a shortlist. The member's T3 discovery snapshot supplies omitted IDs;
// exact live lookup confirms each before it can enter a picker.
async function expandShortlists(client: T3Client, caps: Capabilities) {
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
        const exact = await connectedCapabilities(client, id)
        const model = exact.providers.find((p) => p.providerInstanceId === provider.providerInstanceId)?.models.find((m) => m.id === id)
        if (model) provider.models.push(model)
      }))
    }
  }
}

const catalogCache = new Map<string, { at: number; models: ReturnType<typeof supervisorModels> }>()
function nativeCatalog(bin: string) {
  const hit = catalogCache.get(bin)
  if (hit && Date.now() - hit.at < 60_000) return hit.models
  const models = supervisorModels(bin)
  catalogCache.set(bin, { at: Date.now(), models })
  void models.catch(() => { if (catalogCache.get(bin)?.models === models) catalogCache.delete(bin) })
  return models
}

export async function nativeVariants(caps: Capabilities, instance: string, id: string) {
  const bin = supervisorBins(caps.providers).get(instance)
  if (!bin) return
  const models = await nativeCatalog(bin).catch(() => [])
  return models.find((m) => modelId(m.providerID, m.id) === id)?.variants
}

export async function supervisorTarget(value: string, effort?: string) {
  const { instanceId, model } = selection(value)
  const { capabilities } = await inspect(5000)
  const bin = supervisorBins(capabilities.providers).get(instanceId)
  if (!bin || !/^[^/]+\/.+/.test(model)) throw new Error('Choose an available T3 OpenCode supervisor model.')
  const { instanceId: providerID, model: id } = selection(model)
  return { bin, ref: { providerID, id, ...(effort ? { variant: effort } : {}) } }
}
export async function modelChoices(search?: string, supervisor = false) {
  const { capabilities } = await inspect(15_000, search, true)
  const bins = supervisorBins(capabilities.providers)
  const catalogs = new Map<string, Awaited<ReturnType<typeof supervisorModels>>>()
  await Promise.allSettled([...new Set(bins.values())].map(async (bin) => catalogs.set(bin, await nativeCatalog(bin))))
  const rows = capabilities.providers.flatMap((p) => {
    const native = catalogs.get(bins.get(p.providerInstanceId) ?? '')
    const models = new Map(p.models.map((m) => [m.id, m]))
    if (supervisor) for (const n of native ?? []) {
      const id = modelId(n.providerID, n.id)
      if (!models.has(id)) models.set(id, { id })
    }
    return [...models.values()].map((m) => {
      const value = modelId(p.providerInstanceId, m.id)
      const match = native?.find((n) => modelId(n.providerID, n.id) === m.id)
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
export const invalidateInfo = () => { generation++; catalogCache.clear(); cached = undefined; probing = undefined }
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
