// Provider configuration is read and updated by the member's agent. Return only safe summaries.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyEdits, modify, parse as jsonc, type ParseError } from 'jsonc-parser'
import { parse as toml, stringify as encodeToml } from 'smol-toml'
import { parseTOML, type AST } from 'toml-eslint-parser'
import { profileDir, profileNames } from './claude.ts'
import { readConfig } from './t3-client.ts'

type ObjectMap = Record<string, unknown>
const object = (v: unknown): v is ObjectMap => !!v && typeof v === 'object' && !Array.isArray(v)
type Format = 'opencode' | 'codex' | 'claude' | 'gemini' | 'cursor' | 'antigravity'
type Source = { id: string; format: Format; file: string; label: string; path?: string[] }
export type McpSource = { id: string; label: string; revision: string; canToggle?: boolean; error?: string }
export type McpEntry = { source: string; name: string; transport: string; host: string | null; enabled: boolean }
export type McpInventory = { sources: McpSource[]; entries: McpEntry[] }

function sources(): Source[] {
  const home = homedir()
  const result: Source[] = []
  const add = (format: Format, id: string, label: string, file: string, path?: string[]) => {
    if (!result.some((s) => s.file === file && s.path?.join('\0') === path?.join('\0'))) result.push({ format, id, label, file, path })
  }
  const oc = join(home, '.config/opencode/opencode.json')
  const openCodeFiles = [oc, oc + 'c'].filter((f) => existsSync(f))
  for (const [i, file] of (openCodeFiles.length ? openCodeFiles : [oc]).entries()) {
    const id = i ? 'opencode-jsonc' : 'opencode'
    const label = i ? 'OpenCode · JSONC' : 'OpenCode'
    let legacy = false
    if (existsSync(file)) try {
      const config = jsonc(readFileSync(file, 'utf8'))
      legacy = object(config?.mcp) && Object.values(config.mcp).some((e) => object(e) && ['local', 'remote'].includes(String(e.type)))
    } catch { /* load() reports unreadable configuration. */ }
    if (legacy) add('opencode', id + '-legacy', label + ' · legacy entries', file, ['mcp'])
    add('opencode', id, label, file)
  }
  add('codex', 'codex', 'Codex', join(home, '.codex/config.toml'))
  for (const p of profileNames()) {
    const file = p === 'default' ? join(home, '.claude.json') : join(profileDir(p), '.claude.json')
    add('claude', 'claude-' + p, 'Claude Code · ' + p, file)
    try {
      const projects = jsonc(readFileSync(file, 'utf8'))?.projects
      if (object(projects)) for (const [project, config] of Object.entries(projects)) {
        if (!object(config) || !object(config.mcpServers) || !Object.keys(config.mcpServers).length) continue
        const id = createHash('sha256').update(project).digest('hex').slice(0, 24)
        add('claude', 'claude-' + p + '-' + id, 'Claude Code · ' + p + ' · ' + project, file, ['projects', project, 'mcpServers'])
      }
    } catch { /* The profile can be new. */ }
  }
  add('gemini', 'gemini', 'Gemini CLI', join(home, '.gemini/settings.json'))
  add('cursor', 'cursor', 'Cursor', join(home, '.cursor/mcp.json'))
  add('antigravity', 'antigravity', 'Antigravity', join(home, '.gemini/config/mcp_config.json'))
  try {
    const base = readConfig().baseDir
    if (base) {
      const settings = JSON.parse(readFileSync(join(base, 'userdata/settings.json'), 'utf8'))
      for (const [id, instance] of Object.entries(settings.providerInstances ?? {})) {
        if (!object(instance) || !object(instance.config) || instance.driver !== 'codex') continue
        const dir = instance.config.homePath
        if (typeof dir === 'string' && dir.startsWith('/')) add('codex', 't3-' + id, 'T3 · ' + id, join(dir, 'config.toml'))
      }
      const dir = join(base, 'userdata/providers/antigravity')
      for (const id of readdirSync(dir)) {
        const file = join(dir, id, 'config/mcp_config.json')
        if (/^[a-f0-9]{64}$/.test(id)) add('antigravity', 't3-ag-' + id, 'T3 Antigravity · ' + id.slice(0, 8), file)
      }
    }
  } catch { /* T3 is optional. */ }
  return result
}
const legacySource = (source: Source) => source.format === 'opencode' && source.path?.length === 1

async function load(source: Source) {
  let raw = ''
  try {
    const stat = await lstat(source.file)
    if (!stat.isFile() || stat.size > 8_000_000) throw new Error()
    raw = await readFile(source.file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Provider configuration cannot be read.')
  }
  const errors: ParseError[] = []
  let data: unknown
  try { data = !raw.trim() ? {} : source.format === 'codex' ? toml(raw) : jsonc(raw, errors, { allowTrailingComma: true }) } catch { throw new Error('Invalid provider configuration.') }
  if (errors.length || !object(data)) throw new Error('Invalid provider configuration.')
  const path = source.path ?? (source.format === 'opencode' ? ['mcp', 'servers'] : [source.format === 'codex' ? 'mcp_servers' : 'mcpServers'])
  let table = data
  for (const key of path) {
    const next = table[key]
    if (next !== undefined && !object(next)) throw new Error('Unsupported provider configuration.')
    table = next ?? {}
  }
  if (legacySource(source)) table = Object.fromEntries(Object.entries(table).filter(([, e]) => object(e) && ['local', 'remote'].includes(String(e.type))))
  return { raw, data, path, table, revision: createHash('sha256').update(raw).digest('hex') }
}
export async function inventory(): Promise<McpInventory> {
  const out: McpInventory = { sources: [], entries: [] }
  for (const s of sources()) {
    try {
      const { revision, table } = await load(s)
      out.sources.push({ id: s.id, label: s.label, revision, canToggle: ['opencode', 'codex', 'antigravity'].includes(s.format) })
      for (const [name, entry] of Object.entries(table)) {
        if (!object(entry)) continue
        const url = entry.url ?? entry.serverUrl ?? entry.httpUrl
        let host: string | null = null
        if (typeof url === 'string') { try { host = new URL(url).host } catch { /* templated URL */ } }
        out.entries.push({ source: s.id, name, transport: url ? 'HTTP' : entry.command ? 'stdio' : 'provider', host,
          enabled: entry.disabled !== true && entry.enabled !== false })
      }
    } catch (e) { out.sources.push({ id: s.id, label: s.label, revision: '', error: (e as Error).message }) }
  }
  return out
}

// Remove just the target assignments/tables, including nested environment tables. A provider
// may also store all MCPs in one inline object, in which case reserialize that object alone.
function editToml(raw: string, name: string, entry: ObjectMap | undefined, table: ObjectMap) {
  const ranges: [number, number][] = []
  let servers: ObjectMap = entry ? { [name]: entry } : {}
  function visit(pair: AST.TOMLKeyValue, parent: (string | number)[]) {
    const keys = [...parent, ...pair.key.keys.map((key) => key.type === 'TOMLBare' ? key.name : key.value)]
    if (keys[0] !== 'mcp_servers') return
    if (keys.length === 1) servers = table
    if (keys.length === 1 || keys[1] === name) ranges.push(pair.range)
  }
  for (const node of parseTOML(raw).body[0].body) {
    if (node.type === 'TOMLKeyValue') visit(node, [])
    else if (node.resolvedKey[0] === 'mcp_servers') {
      if (node.resolvedKey[1] === name) ranges.push(node.range)
      else if (node.resolvedKey.length === 1) for (const pair of node.body) visit(pair, node.resolvedKey)
    }
  }
  let result = raw
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(end)
  if (Object.keys(servers).length) result += '\n' + encodeToml({ mcp_servers: servers })
  return result
}

// Serialize read/modify/write operations in the single per-member agent. The revision also detects
// edits made in another tab, or in the provider's own configuration since the inventory was shown.
let writing = Promise.resolve()
export function change(input: ObjectMap) {
  const job = writing.then(() => save(input))
  writing = job.catch(() => {})
  return job
}
async function save(r: ObjectMap) {
  const source = sources().find((s) => s.id === r.source)
  const name = r.name
  if (!source || typeof name !== 'string' || !/^[a-zA-Z0-9][\w.-]{0,127}$/.test(name) || name in Object.prototype) throw new Error('Choose a provider and valid server name.')
  const { data, raw, path, table, revision } = await load(source)
  if (revision !== r.revision) throw new Error('Provider settings changed. Refresh and try again.')
  if (legacySource(source) && (['servers', 'timeout'].includes(name) || (object(data.mcp) && Object.hasOwn(data.mcp, name) && !Object.hasOwn(table, name)))) throw new Error('This name is reserved by OpenCode.')
  const existing = table[name]
  if (r.action === 'create' ? existing !== undefined : !object(existing)) throw new Error('Server name already used or missing. Refresh the inventory.')
  let entry: ObjectMap | undefined
  if (r.action === 'remove') entry = undefined
  else if (r.action === 'create' || r.action === 'edit') {
    entry = object(existing) ? { ...existing } : {}
    if (r.url || r.command) {
      if (r.url && r.command) throw new Error('Choose one transport.')
      // A new destination must never inherit the previous endpoint’s secret headers or environment.
      entry = {}
      if (typeof r.url === 'string') {
        let url: URL
        try { url = new URL(r.url) } catch { throw new Error('Enter an HTTP or HTTPS URL.') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Enter an HTTP or HTTPS URL without embedded credentials.')
        if (source.format === 'opencode') entry.type = 'remote'
        if (source.format === 'claude') entry.type = 'http'
        entry[source.format === 'antigravity' ? 'serverUrl' : source.format === 'gemini' ? 'httpUrl' : 'url'] = url.href
      } else {
        const args = r.command
        if (!Array.isArray(args) || !args.length || !args[0] || args.length > 100 || !args.every((a) => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) throw new Error('Supply the executable and its arguments as a string array.')
        if (source.format === 'opencode') { entry.type = 'local'; entry.command = args }
        else { entry.command = args[0]; entry.args = args.slice(1) }
      }
    } else if (!existing) throw new Error('Supply a URL or command.')
    const enabled = r.enabled ?? (!existing || object(existing) && existing.disabled !== true && existing.enabled !== false)
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled setting.')
    if (source.format === 'codex' || legacySource(source)) entry.enabled = enabled
    else if (source.format === 'opencode' || source.format === 'antigravity') entry.disabled = !enabled
    else if (!enabled) throw new Error('This provider manages enabled state separately.')
  } else throw new Error('Unknown action.')
  let output: string
  try {
    if (source.format === 'codex') {
      const values = { ...table }
      if (entry) values[name] = entry
      else delete values[name]
      const updated = { ...data, mcp_servers: values }
      output = editToml(raw, name, entry, values)
      const parsed = toml(output)
      if (!Object.keys(values).length && !parsed.mcp_servers) parsed.mcp_servers = {}
      if (!isDeepStrictEqual(toml(encodeToml(parsed)), toml(encodeToml(updated)))) throw new Error()
    } else {
      const prior = raw.trim() ? raw : '{}\n'
      output = applyEdits(prior, modify(prior, [...path, name], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    }
  } catch { throw new Error('Could not preserve the existing provider configuration.') }
  await mkdir(dirname(source.file), { recursive: true, mode: 0o700 })
  const temp = source.file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, output, { flag: 'wx', mode: 0o600 })
    if ((await load(source)).revision !== revision) throw new Error('Provider settings changed. Refresh and try again.')
    await rename(temp, source.file)
  } finally { await rm(temp, { force: true }) }
}

// An explicit connection check can launch a configured stdio process. Listing the inventory never does.
export async function check(input: ObjectMap) {
  const source = sources().find((s) => s.id === input.source)
  if (!source || typeof input.name !== 'string') throw new Error('Choose a configured server.')
  const { table, revision } = await load(source)
  if (revision !== input.revision) throw new Error('Refresh the connections before checking.')
  const entry = Object.hasOwn(table, input.name) ? table[input.name] : undefined
  if (!object(entry) || entry.disabled === true || entry.enabled === false) throw new Error('This connection is unavailable.')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'devdash-connection-check', version: '1' })
  const url = entry.url ?? entry.serverUrl ?? entry.httpUrl
  const signal = AbortSignal.timeout(10_000)
  try {
    if (typeof url === 'string') {
      // OAuth grants, templates and injected secrets belong to the provider process.
      if (entry.headers || entry.http_headers || entry.env_http_headers || entry.bearer_token_env_var || entry.oauth)
        return { status: 'Check with provider credentials' }
      const target = new URL(url)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return { status: 'Check in provider' }
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const transport = new StreamableHTTPClientTransport(target, { fetch: (u, init) => fetch(u, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) })
      await client.connect(transport, { signal })
      await transport.terminateSession().catch(() => {})
    } else {
      const args = Array.isArray(entry.command) ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
      if (entry.env || entry.environment || entry.cwd || !args.length || !args.every((a) => typeof a === 'string')) return { status: 'Check in provider' }
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      await client.connect(new StdioClientTransport({ command: args[0]!, args: args.slice(1), stderr: 'ignore', cwd: homedir() }), { signal })
    }
    return { status: 'Connected' }
  } catch (error) {
    return { status: object(error) && (error.code === 401 || error.code === 403 || error.name === 'UnauthorizedError') ? 'Sign in through provider' : 'Connection check failed' }
  } finally { await client.close().catch(() => {}) }
}
