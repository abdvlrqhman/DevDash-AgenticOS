// T3 Code's own MCP integration. Credentials belong to the DevDash member; the configured T3 server runs the tools.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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
export async function inspect(budgetMs = 5000, search?: string) {
  const client = new T3Client(undefined, { timeoutMs: budgetMs, signal: AbortSignal.timeout(budgetMs) })
  try {
    await client.connect()
    const capabilities = await connectedCapabilities(client, search)
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
      if (typeof bin !== 'string' || !isAbsolute(bin) || !statSync(bin, { throwIfNoEntry: false })?.isFile()) continue
      try { accessSync(bin, constants.X_OK); bins.set(p.providerInstanceId, bin) } catch { /* unusable executable */ }
    }
  } catch { /* Other T3 chat models remain available without local provider configuration. */ }
  return bins
}

export async function supervisorTarget(value: string, effort?: string) {
  const { instanceId, model } = selection(value)
  const { capabilities } = await inspect(5000, model)
  const provider = capabilities.providers.find((p) => p.providerInstanceId === instanceId)
  const selected = provider?.models.find((m) => m.id === model)
  const bin = supervisorBins(capabilities.providers).get(instanceId)
  if (!bin || !selected || !/^[^/]+\/.+/.test(model)) throw new Error('Choose an available T3 OpenCode supervisor model.')
  if (effort && !effortOption(selected)?.levels.includes(effort)) throw new Error('This T3 Code supervisor model does not offer that thinking level.')
  const { instanceId: providerID, model: id } = selection(model)
  return { bin, ref: { providerID, id, ...(effort ? { variant: effort } : {}) } }
}
export async function modelChoices(search?: string) {
  const { capabilities } = await inspect(5000, search)
  const bins = supervisorBins(capabilities.providers)
  // The service catalog does not identify which model a new project will use for Default.
  return [
    { value: '', displayName: 'Default', description: "T3 Code's own default" },
    ...capabilities.providers.flatMap((p) => p.models.map((m) => {
      const value = modelId(p.providerInstanceId, m.id)
      return { value, displayName: m.label || m.id, description: value, group: p.providerInstanceId, ...(bins.has(p.providerInstanceId) && /^[^/]+\/.+/.test(m.id) ? { supportsSupervisor: true } : {}), supportedEffortLevels: effortOption(m)?.levels ?? [] }
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
