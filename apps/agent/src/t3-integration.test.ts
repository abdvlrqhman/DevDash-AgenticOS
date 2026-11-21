import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer as unixServer } from 'node:net'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { supervisorText } from './t3-supervisor.ts'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Launch } from './claude.ts'
import type { Capabilities } from './t3code.ts'

// Exercise the real member harness and its child ACP bridge against an HTTP MCP server.
// No provider process, production token or production conversation is used.
const home = mkdtempSync(join(tmpdir(), 'dd-t3-integration-'))
const token = 'fake-integration-token'
const config = join(home, 't3code.json')
Object.assign(process.env, { HOME: home, DEVDASH_T3_CONFIG: config })
type Item = { itemId: string; messageId?: string; position: number; runId: string; type: string; createdBy: string; text: string; title: string | null; status: string }
type ModelSelection = { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] }
type Thread = { options?: ModelSelection['options']; threadId: string; projectId: string; model: string; providerInstanceId: string; status: string; title: string; runtimeMode: string; interactionMode: string; items: Item[]; runId?: string; reads: number; behavior: string; runs: { runId: string; status: string }[] }
const threads = new Map<string, Thread>()
const calls: { name: string; args: Record<string, unknown> }[] = []
const selectionWrites = () => calls.filter((c) => c.name === 't3_thread_configure' && c.args.modelSelection !== undefined)
const events: Record<string, unknown>[] = []
const waiters = new Set<() => void>()
const live = new Set<string>()
let initialized = 0, deleted = 0
let defaultModel = 'one'
let supervisorProviders: Capabilities['providers'] | undefined
let stalledDiscovery = false
let discoveryHold: { entered: () => void; released: Promise<void> } | undefined
let delayed: { name: string; threadId: string; entered: () => void; released: Promise<void> } | undefined
function delayNext(name: string, threadId: string) {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => { enter = r })
  const released = new Promise<void>((r) => { release = r })
  delayed = { name, threadId, entered: enter, released }
  return { entered, release }
}
async function hold(name: string, threadId: string) {
  if (delayed?.name !== name || delayed.threadId !== threadId) return
  const current = delayed; delayed = undefined
  current.entered(); await current.released
}
const caps = {
  runtimeMode: 'full-access',
  providers: [{ providerInstanceId: 'fake', canRunChildTask: true, displayName: 'Fake T3 provider', runtimeModes: ['full-access', 'approval-required'], models: [
    { id: 'one', options: [{ id: 'reasoningEffort', default: 'medium', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }] },
    { id: 'two', options: [{ id: 'variant', default: 'low', values: ['low', 'high'] }] },
    { id: 'three', options: [{ id: 'thinking_level', default: 'high', values: ['low', 'high', 'xhigh'] }, { id: 'serviceTier', default: 'default', values: ['default', 'priority'] }] },
    { id: 'four', options: [{ id: 'serviceTier', default: 'default', values: ['default', 'priority'] }] },
  ] }, { providerInstanceId: 'disabled', canRunChildTask: false, displayName: 'Disabled provider', runtimeModes: ['full-access'], models: [{ id: 'unconnected' }] }],
}
function externalRun(t: Thread) {
  const runId = randomUUID()
  t.runId = runId; t.status = 'running'; t.behavior = 'external'; t.reads = 0
  t.runs.unshift({ runId, status: 'running' })
  t.items.push({ itemId: `user-${runId}`, messageId: `outside:${runId}`, position: t.items.length, runId, type: 'user_message', createdBy: 'user', text: 'Another T3 app turn', title: null, status: 'completed' })
  t.items.push({ itemId: `assistant-${runId}`, position: t.items.length, runId, type: 'assistant_message', createdBy: 'agent', text: 'External work', title: null, status: 'running' })
  return runId
}
const http = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`)
  res.setHeader('content-type', 'application/json')
  if (req.method === 'DELETE') { deleted++; res.end('{}'); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const message = JSON.parse(raw) as { id: number; method: string; params: { name: string; arguments: Record<string, unknown> } }
  const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  if (message.method === 'initialize') {
    initialized++; res.setHeader('mcp-session-id', `fake-session-${initialized}`)
    reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'T3 test', version: 'test' } }); return
  }
  if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return }
  assert.equal(message.method, 'tools/call')
  const { name, arguments: args } = message.params
  calls.push({ name, args })
  const t = threads.get(String(args.threadId))
  let data: unknown
  if (name === 'orchestrator_capabilities') {
    if (stalledDiscovery) return
    const result = structuredClone(caps)
    if (defaultModel === 'outside-short-list') {
      if (args.search === defaultModel) result.providers[0]!.models = [{ id: defaultModel, options: [{ id: 'thinking_level', default: 'low', values: ['low', 'adaptive'] }] }]
      else Object.assign(result.providers[0]!, { omittedModels: 1 })
    }
    data = supervisorProviders ? { ...result, providers: supervisorProviders } : result
    if (discoveryHold) { const pause = discoveryHold; discoveryHold = undefined; pause.entered(); await pause.released }
  }
  else if (name === 't3_project_list') data = { projects: [{ id: 'project', workspaceRoot: home }], nextCursor: null }
  else if (name === 't3_project_read') data = { id: String(args.projectId), workspaceRoot: args.projectId === 'wrong-project' ? tmpdir() : home }
  else if (name === 't3_thread_launch') {
    const id = `thread-${threads.size + 1}`
    const selected = args.modelSelection as ModelSelection | undefined
    threads.set(id, { threadId: id, projectId: 'project', options: selected?.options, model: selected?.model ?? defaultModel, providerInstanceId: selected?.instanceId ?? 'fake', title: 'Test', status: 'idle', runtimeMode: String(args.runtimeMode), interactionMode: String(args.interactionMode), items: [], reads: 0, behavior: '', runs: [] })
    data = { threadId: id }
  } else if (name === 't3_thread_configure') {
    assert.ok(t)
    const s = args.modelSelection as ModelSelection | undefined
    if (s) {
      t.model = s.model; t.providerInstanceId = s.instanceId; t.options = s.options
      data = { sequence: 1 }
    } else data = { threadId: t.threadId, modelSelection: { instanceId: t.providerInstanceId, model: t.model, options: t.options } }
  } else if (name === 't3_thread_send') {
    assert.ok(t)
    const prompt = String(args.message)
    if (prompt.endsWith('fail-send')) { res.writeHead(503).end('private error body'); return }
    if (prompt.endsWith('clean-rejection')) { res.writeHead(400).end('rejected'); return }
    if (prompt.endsWith('rejected-with-external')) { externalRun(t); res.writeHead(503).end('rejected before our turn'); return }
    assert.equal(args.mode, 'queue')
    const raced = prompt.endsWith('raced-external')
    if (raced) externalRun(t)
    const runId = randomUUID()
    t.runId = runId; t.status = 'running'; t.reads = 0
    t.behavior = prompt.endsWith('stream') ? 'stream' : prompt.endsWith('cancel') ? 'cancel' : prompt.endsWith('long-text') ? 'long' : prompt.endsWith('long-stall') ? 'longstall' : prompt.endsWith('waiting') ? 'waiting' : prompt.endsWith('fail-poll') ? 'pollfail' : prompt.endsWith('transient-wait') ? 'transient' : 'quick'
    t.runs.unshift({ runId, status: 'running' })
    const pos = t.items.length
    t.items.push({ itemId: `user-${runId}`, messageId: `message:mcp:client:test:thread-send:${String(args.clientRequestId)}`, position: pos, runId, type: 'user_message', createdBy: 'agent', text: prompt, title: null, status: 'completed' })
    t.items.push({ itemId: `assistant-${runId}`, position: pos + 1, runId, type: 'assistant_message', createdBy: 'agent', text: '', title: null, status: 'running' })
    if (prompt.endsWith('provider-error')) t.items.push({ itemId: `error-${runId}`, position: pos + 2, runId, type: 'error', createdBy: 'agent', text: 'Provider request failed with HTTP 503', title: null, status: 'running' })
    data = { runId, delivery: raced ? 'queued' : 'started' }
    await hold(name, t.threadId)
    if (prompt.endsWith('lost-send-response')) { res.writeHead(503).end('accepted, but response lost'); return }
  } else if (name === 't3_thread_interrupt') {
    assert.ok(t)
    assert.equal(typeof args.runId, 'string', 'the bridge must never issue a thread-wide interrupt')
    const run = t.runs.find((r) => r.runId === args.runId)
    if (run) { run.status = 'interrupted'; t.status = 'interrupted' }
    await hold(name, t.threadId)
    data = { runId: run?.runId ?? null, status: run ? 'interrupt_requested' : 'no_active_run' }
  } else if (name === 't3_thread_read') {
    assert.ok(t)
    await hold(name, t.threadId)
    assert.ok(args.afterPosition === undefined || Number(args.afterPosition) >= 0, 'real T3 cursors are nonnegative; omit the initial cursor')
    const current = t.runs[0]
    if (t.behavior === 'pollfail' && current?.status === 'running') { res.writeHead(503).end('private poll error'); return }
    if (current?.status === 'running' || (t.behavior === 'waiting' && current?.status === 'waiting')) {
      t.reads++
      const item = t.items.find((i) => i.itemId === `assistant-${current.runId}`)!
      item.text = t.behavior === 'stream' ? (t.reads < 3 ? 'Hel' : 'Hello') : t.behavior === 'cancel' ? 'Working' : ['long', 'longstall'].includes(t.behavior) ? 'L'.repeat(60010) : t.behavior === 'waiting' ? (t.reads < 3 ? '' : 'Approved') : 'Done'
      if (t.behavior === 'transient') { current.status = t.reads < 2 ? 'running' : 'completed'; t.status = t.reads < 2 ? 'waiting' : 'completed'; item.text = 'Final reply'; if (current.status === 'completed') item.status = 'completed' }
      if (t.behavior === 'waiting') { current.status = t.reads < 3 ? 'waiting' : 'running'; t.status = current.status }
      if (['quick', 'long'].includes(t.behavior) || (t.behavior === 'stream' && t.reads >= 3) || (t.behavior === 'waiting' && t.reads >= 4)) {
        current.status = 'completed'; t.status = 'completed'; item.status = 'completed'
        if (t.behavior === 'stream') t.items.push({ itemId: `tool-${current.runId}`, position: t.items.length, runId: current.runId, type: 'command_execution', createdBy: 'agent', title: 'echo checked', text: 'checked', status: 'completed' })
      }
    }
    const available = t.items.filter((i) => (args.itemId === undefined || i.itemId === args.itemId) && (args.afterPosition === undefined || i.position > Number(args.afterPosition)))
    const offset = Number(args.textOffset ?? 0)
    const page = available.slice(0, Number(args.limit ?? 100))
    const items = page.map((i) => ({ ...i, updatedAt: `revision:${i.text.length}:${i.status}`, text: i.text.slice(offset, offset + 50000), textTruncated: i.text.length > offset + 50000, nextTextOffset: i.text.length > offset + 50000 ? offset + 50000 : null }))
    data = { thread: { ...t, items: undefined, runs: undefined, activeRunId: t.runs.find((r) => !['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'].includes(r.status))?.runId ?? null, latestRunId: t.runs[0]?.runId ?? null, pendingRequestCount: t.behavior === 'waiting' && t.status === 'waiting' ? 1 : 0, link: 'https://t3.example/thread' }, items, recentRuns: t.runs, hasMore: available.length > page.length, nextPosition: items.at(-1)?.position ?? null }
  } else throw new Error(`Unexpected fake MCP tool: ${name}`)
  reply({ structuredContent: data })
}).listen(0, '127.0.0.1')
await new Promise<void>((r) => http.once('listening', r))
writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, token }), { mode: 0o600 })
const H = await import('./harness.ts')
H.setEmitter((event) => { events.push(event); for (const fn of waiters) fn() })

function eventAfter(index: number, predicate: (e: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Timed out waiting for the T3 integration event.')) }, 12_000)
    const check = () => {
      const found = events.slice(index).find(predicate)
      if (found) { clearTimeout(timer); waiters.delete(check); resolve(found) }
    }
    waiters.add(check); check()
  })
}
const launch = (): Launch => {
  const l: Launch = { id: randomUUID(), harness: 't3code', nativeId: null, cwd: home, profile: 'default', model: 'fake/one', permissionMode: 'bypassPermissions', started: false, ownerName: 'Test' }
  live.add(l.id); return l
}
const isResult = (id: string) => (e: Record<string, unknown>) => e.id === id && e.ev === 'claude.msg' && (e.msg as { type?: string }).type === 'result'
async function turn(l: Launch, text: string) {
  const start = events.length
  await H.send(l, [{ type: 'text', text }], randomUUID())
  return (await eventAfter(start, isResult(l.id))).msg as Record<string, unknown>
}
const contentText = (message: unknown) => ((message as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
test.after(async () => {
  for (const id of live) await H.stop(id)
  http.closeAllConnections()
  await new Promise<void>((r) => http.close(() => r()))
  rmSync(home, { recursive: true, force: true })
})

test('T3 discovery only lists connected providers and their models', async () => {
  const listed = await H.commandsAndModels('t3code', 'default')
  assert.deepEqual(listed.models.map((m) => m.value), ['', 'fake/one', 'fake/two', 'fake/three', 'fake/four'])
  assert.deepEqual(listed.models.map((m) => m.supportedEffortLevels), [
    undefined, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], ['low', 'high'], ['low', 'high', 'xhigh'], [],
  ])
  const agent = (await H.agents()).find((a) => a.harness === 't3code')!
  assert.deepEqual(agent.profiles, [{ name: 'default', providers: ['Fake T3 provider'] }])
  const l = launch()
  await turn(l, 'quick')
  await assert.rejects(H.setOption(l.id, 'model', 'disabled/unconnected'), /not available/)
  await H.stop(l.id)
  const invalid = launch()
  invalid.model = 'disabled/unconnected'
  const launches = calls.filter((c) => c.name === 't3_thread_launch').length
  await assert.rejects(H.send(invalid, [{ type: 'text', text: 'quick' }], randomUUID()), /not available from a connected/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_launch').length, launches, 'reject disconnected initial models before creating a conversation')
})

test('T3 supervisors use the selected member OpenCode model and variant for tool-free text', async () => {
  const original = readFileSync(config, 'utf8')
  const folder = mkdtempSync(join(home, 'supervisor-'))
  const binary = join(folder, 'opencode.mjs')
  const capture = join(folder, 'requests.jsonl')
  const openServer = join(folder, 'disable-auth')
  const limited = join(folder, 'rate-limited')
  const nativeModel = { providerID: 'account', id: 'chosen', modelID: 'Upstream-Chosen', enabled: true, variants: [{ id: 'high' }] }
  writeFileSync(binary, `#!${process.execPath}
import { createServer } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
const server = createServer(async (req, res) => {
  const auth = Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')
  if (!existsSync(${JSON.stringify(openServer)}) && (!process.env.OPENCODE_PASSWORD || req.headers.authorization !== 'Basic ' + auth)) {
    res.writeHead(401).end()
    return
  }
  let text = ''
  for await (const chunk of req) text += chunk
  const body = text ? JSON.parse(text) : null
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ method: req.method, url: req.url, body }) + '\\n')
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/model') res.end(JSON.stringify({ data: [${JSON.stringify(nativeModel)}] }))
  else if (req.url === '/api/experimental/generate/text' && existsSync(${JSON.stringify(limited)})) res.writeHead(502).end(JSON.stringify({ status: 429, reason: 'rate_limit' }))
  else if (req.url === '/api/experimental/generate/text') res.end(JSON.stringify({ data: { text: 'decision' } }))
  else res.writeHead(404).end()
}).listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })))
process.stdin.resume()
process.stdin.on('end', () => server.close())
`, { mode: 0o700 })
  const models = [{ id: 'account/chosen', options: [{ id: 'variant', values: ['high', 'stale'] }] }]
  const providers = [
    { providerInstanceId: 'local', driverKind: 'opencode' },
    { providerInstanceId: 'broken', driverKind: 'opencode' },
    { providerInstanceId: 'custom', driverKind: 'opencode' },
    { providerInstanceId: 'other', driverKind: 'codex' },
  ]
  supervisorProviders = providers.map((p) => ({ ...p, canRunChildTask: true, displayName: p.providerInstanceId, models }))
  const simple = { driver: 'opencode', enabled: true, config: { binaryPath: binary } }
  const settings = { providerInstances: { local: simple, broken: { ...simple, config: { binaryPath: '/bin/false' } }, custom: { ...simple, config: { ...simple.config, env: { ACCOUNT: 'another' } } }, other: simple } }
  mkdirSync(join(folder, 'userdata'))
  writeFileSync(join(folder, 'userdata/settings.json'), JSON.stringify(settings))
  writeFileSync(config, JSON.stringify({ ...JSON.parse(original), baseDir: folder }))
  const messages = () => readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { url: string; body: unknown; method: string })
  try {
    const { models: entries } = await H.commandsAndModels('t3code', 'default', undefined, true)
    assert.deepEqual(entries.filter((m) => m.supportsSupervisor).map((m) => [m.value, m.supportsSupervisor, m.supportedEffortLevels]), [['local/account/chosen', true, ['high']]])
    assert.ok(entries.some((m) => m.value === 'other/account/chosen' && m.supportsSupervisor === false))
    const chat = (await H.commandsAndModels('t3code', 'default', 'local/account/chosen')).models
    assert.deepEqual(chat.find((m) => m.value === 'local/account/chosen')?.supportedEffortLevels, ['high'])
    const start = calls.length
    const complete = (model: string, effort?: string) => H.complete('t3code', 'default', 'judge this transcript', { system: 'Return the decision.', model, effort })
    for (const unsupported of ['custom/account/chosen', 'other/account/chosen', 'local/account/missing']) {
      await assert.rejects(complete(unsupported), /supervisor model/i)
    }
    await assert.rejects(complete('local/account/chosen', 'invalid'), /thinking level/i)
    assert.equal(await complete('local/account/chosen', 'high'), 'decision')
    const generate = messages().filter((m) => m.url === '/api/experimental/generate/text')
    assert.deepEqual(generate, [{ method: 'POST', url: '/api/experimental/generate/text',
      body: { prompt: 'Return the decision.\n\njudge this transcript', model: { providerID: 'account', id: 'chosen', variant: 'high' } } }])
    // T3 can retain a variant in its catalog after OpenCode removes it. Never request a default in its place.
    await assert.rejects(complete('local/account/chosen', 'stale'), /variant|thinking|level/i)
    writeFileSync(limited, '')
    await assert.rejects(complete('local/account/chosen', 'high'), /rate limit/)
    // An executable that ignores its configured password must never receive the private transcript.
    writeFileSync(openServer, '')
    await assert.rejects(complete('local/account/chosen', 'high'))
    assert.equal(messages().filter((m) => m.url === '/api/experimental/generate/text').length, 2)
    assert.ok(messages().every((m) => m.url === '/api/model' || m.url === '/api/experimental/generate/text'))
    assert.ok(calls.slice(start).every((c) => c.name === 'orchestrator_capabilities'), 'no tool-bearing T3 thread was started')
  } finally {
    supervisorProviders = undefined
    writeFileSync(config, original)
  }
})

test('T3 Antigravity supervisors enforce tool-free ACP isolation, strict config, rate limits and cleanup', async () => {
  const original = readFileSync(config, 'utf8')
  const folder = mkdtempSync(join(home, 'supervisor-agy-'))
  const capture = join(folder, 'acp-events.jsonl')
  const modeFile = join(folder, 'mode.txt')
  const releaseId = 'a'.repeat(64)
  const toolRoot = join(folder, 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`)
  const versionDir = join(toolRoot, 'versions', releaseId)
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(toolRoot, 'active.json'), JSON.stringify({ releaseId }), { mode: 0o600 })
  const binary = join(versionDir, 'agy_acp_server.par')
  const harnessBin = join(versionDir, 'localharness_external')
  writeFileSync(harnessBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(binary, `#!${process.execPath}
const { appendFileSync, existsSync, readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const capture = ${JSON.stringify(capture)}
const modeFile = ${JSON.stringify(modeFile)}
const mode = () => existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok'
const log = (entry) => appendFileSync(capture, JSON.stringify(entry) + '\\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')

const models = [
  { value: 'gemini-4-neon', name: 'Gemini 4 Neon', levels: ['low', 'high'] },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', levels: ['low', 'medium'] },
]
let currentModel = models[0].value
let currentLevel = 'high'
const configOptions = () => {
  const active = models.find((m) => m.value === currentModel) ?? models[0]
  return [
    { id: 'model', category: 'model', currentValue: currentModel, options: models.map((m) => ({ value: m.value, name: m.name })) },
    { id: 'thinking_level', category: 'thought_level', currentValue: currentLevel, options: active.levels.map((v) => ({ value: v, name: v })) },
  ]
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    const acpDir = join(process.env.GEMINI_HOME || '', 'antigravity-acp')
    log({
      event: 'initialize',
      pid: process.pid,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      home: process.env.HOME,
      geminiHome: process.env.GEMINI_HOME,
      tmpdir: process.env.TMPDIR,
      harnessPath: process.env.ANTIGRAVITY_HARNESS_PATH,
      acpFiles: existsSync(acpDir) ? readdirSync(acpDir).sort() : [],
      params: msg.params,
    })
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } })
  } else if (msg.method === 'authenticate') {
    log({ event: 'authenticate', params: msg.params })
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  } else if (msg.method === 'session/new') {
    log({ event: 'session/new', params: msg.params })
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ephemeral-1', configOptions: configOptions() } })
  } else if (msg.method === 'session/set_config_option') {
    log({ event: 'session/set_config_option', params: msg.params })
    if (msg.params.configId === 'model' && models.some((m) => m.value === msg.params.value)) {
      currentModel = msg.params.value
      currentLevel = models.find((m) => m.value === currentModel).levels[0]
    } else if (msg.params.configId === 'thinking_level') {
      const active = models.find((m) => m.value === currentModel)
      if (active?.levels.includes(msg.params.value)) currentLevel = msg.params.value
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptions() } })
  } else if (msg.method === 'session/prompt') {
    log({ event: 'session/prompt', params: msg.params })
    const m = mode()
    if (m === 'tool_call') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ephemeral-1', update: { sessionUpdate: 'tool_call', title: 'bash' } } })
      return
    }
    if (m === 'permission') {
      send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 'ephemeral-1' } })
      return
    }
    if (m === 'rpc_rate_limit') {
      process.stderr.write('secret-oauth-token-leak\\n')
      send({ jsonrpc: '2.0', id: msg.id, error: { code: 429, message: 'RESOURCE_EXHAUSTED token=secret-oauth-token-leak' } })
      return
    }
    if (m === 'chunk_rate_limit') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ephemeral-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Usage Limit Reached\\n\\nYou have reached your quota.' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { used: 0, size: 1000 } } })
      return
    }
    if (m === 'refusal_rate_limit') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ephemeral-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error 429 RESOURCE_EXHAUSTED' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } })
      return
    }
    if (m === 'hang') {
      return
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ephemeral-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agy-decision' } } } })
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { used: 42, size: 1000 } } })
  } else if (msg.method === 'session/delete') {
    log({ event: 'session/delete', params: msg.params })
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`, { mode: 0o700 })

  const setupProviderCreds = (instanceId: string, opts: { symlinkToken?: boolean; authType?: string } = {}) => {
    const hash = createHash('sha256').update(instanceId).digest('hex')
    const acpDir = join(folder, 'userdata', 'providers', 'antigravity', hash, 'antigravity-acp')
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    const tokenFile = join(acpDir, 'acp_token.json')
    if (opts.symlinkToken) {
      const target = join(folder, 'real-token.json')
      writeFileSync(target, JSON.stringify({ access_token: 'secret-token' }), { mode: 0o600 })
      symlinkSync(target, tokenFile)
    } else {
      writeFileSync(tokenFile, JSON.stringify({ access_token: 'secret-token' }), { mode: 0o600 })
    }
    writeFileSync(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: opts.authType ?? 'oauth-personal' } }), { mode: 0o600 })
    // Place distracting files in member dir to confirm they are NEVER copied into the ephemeral GEMINI_HOME.
    writeFileSync(join(acpDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { bad: { command: '/bin/sh' } } }), { mode: 0o600 })
    return tokenFile
  }
  const validToken = setupProviderCreds('antigravity')
  setupProviderCreds('agy-badkeys')
  setupProviderCreds('agy-badauth', { authType: 'gemini-api-key' })
  setupProviderCreds('agy-symlink', { symlinkToken: true })

  const agyModels = [
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', options: [{ id: 'thinkingLevel', values: ['low', 'high', 'xhigh'] }] },
    { id: 'stale-model', label: 'Stale Model', options: [{ id: 'thinkingLevel', values: ['low'] }] },
  ]
  const codexModels = [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', options: [{ id: 'reasoningEffort', values: ['high'] }] }]
  supervisorProviders = [
    { providerInstanceId: 'antigravity', driverKind: 'antigravity', canRunChildTask: true, displayName: 'Antigravity', models: agyModels },
    { providerInstanceId: 'agy-badkeys', driverKind: 'antigravity', canRunChildTask: true, displayName: 'BadKeys', models: agyModels },
    { providerInstanceId: 'agy-badauth', driverKind: 'antigravity', canRunChildTask: true, displayName: 'BadAuth', models: agyModels },
    { providerInstanceId: 'agy-symlink', driverKind: 'antigravity', canRunChildTask: true, displayName: 'Symlink', models: agyModels },
    { providerInstanceId: 'codex', driverKind: 'codex', canRunChildTask: true, displayName: 'Codex', models: codexModels },
  ]
  const settings = {
    providerInstances: {
      antigravity: { driver: 'antigravity', enabled: true, config: { enabled: true, authMethod: 'oauth-personal' } },
      'agy-badkeys': { driver: 'antigravity', enabled: true, config: { enabled: true, authMethod: 'oauth-personal', env: { FOO: 'bar' } } },
      'agy-badauth': { driver: 'antigravity', enabled: true, config: { enabled: true, authMethod: 'gemini-api-key' } },
      'agy-symlink': { driver: 'antigravity', enabled: true, config: { enabled: true, authMethod: 'oauth-personal' } },
      codex: { driver: 'codex', enabled: true, config: { enabled: true, binaryPath: '/bin/true' } },
    },
  }
  mkdirSync(join(folder, 'userdata'), { recursive: true })
  writeFileSync(join(folder, 'userdata', 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  writeFileSync(config, JSON.stringify({ ...JSON.parse(original), baseDir: folder }))

  const eventsLog = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []
  try {
    H.refreshT3()
    // Chat picker must not spawn Antigravity ACP.
    await H.commandsAndModels('t3code', 'default')
    assert.equal(eventsLog().length, 0)

    // Supervisor picker discovers only the live verified Antigravity catalog; bad/codex/stale entries stay supportsSupervisor: false.
    const { models: entries } = await H.commandsAndModels('t3code', 'default', undefined, true)
    assert.deepEqual(
      entries.filter((m) => m.supportsSupervisor).map((m) => [m.value, m.supportedEffortLevels]),
      [['antigravity/gemini-4-neon', ['low', 'high']], ['antigravity/gemini-3.8-flash', ['low', 'medium']]],
    )
    for (const chatOnly of ['codex/gpt-6.2-sol', 'antigravity/stale-model', 'agy-badkeys/gemini-4-neon', 'agy-badauth/gemini-4-neon', 'agy-symlink/gemini-4-neon']) {
      assert.ok(entries.some((m) => m.value === chatOnly && m.supportsSupervisor === false), `${chatOnly} must be supportsSupervisor: false`)
    }
    const initCountAfterDiscovery = eventsLog().filter((e) => e.event === 'initialize').length
    assert.equal(initCountAfterDiscovery, 1)

    // Cached discovery does not respawn ACP within TTL.
    await H.commandsAndModels('t3code', 'default', undefined, true)
    assert.equal(eventsLog().filter((e) => e.event === 'initialize').length, 1)

    const startCalls = calls.length
    const complete = (model: string, effort?: string) => H.complete('t3code', 'default', 'judge this transcript', { system: 'Return the decision.', model, effort })

    // Disallowed providers, stale models, and stale thinking levels reject without fallback.
    for (const unsupported of ['codex/gpt-6.2-sol', 'agy-badkeys/gemini-4-neon', 'agy-badauth/gemini-4-neon', 'agy-symlink/gemini-4-neon']) {
      await assert.rejects(complete(unsupported), /supervisor model/i)
    }
    await assert.rejects(complete('antigravity/stale-model'), /unavailable/i)
    await assert.rejects(complete('antigravity/gemini-4-neon', 'xhigh'), /thinking level/i)
    assert.equal(eventsLog().filter((e) => e.event === 'session/prompt').length, 0)

    // Valid completions reuse the warm isolated ACP worker (no repeated initialize) while creating and deleting a fresh zero-tool session each call.
    const sessionsBefore = eventsLog().filter((e) => e.event === 'session/new').length
    assert.equal(await complete('antigravity/gemini-4-neon', 'low'), 'agy-decision')
    assert.equal(await complete('antigravity/gemini-4-neon', 'low'), 'agy-decision')
    assert.equal(eventsLog().filter((e) => e.event === 'initialize').length, 1, 'warm worker avoids repeated ACP cold starts')
    assert.equal(eventsLog().filter((e) => e.event === 'session/new').length, sessionsBefore + 2, 'each completion uses a fresh ephemeral session')
    assert.ok(eventsLog().filter((e) => e.event === 'session/delete').length >= sessionsBefore + 2)
    const initEvent = eventsLog().filter((e) => e.event === 'initialize').at(-1)!
    assert.deepEqual((initEvent.params as { clientCapabilities: unknown }).clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
    assert.notEqual(initEvent.home, home)
    assert.notEqual(initEvent.geminiHome, join(folder, 'userdata'))
    assert.equal(initEvent.harnessPath, harnessBin)
    assert.deepEqual(initEvent.acpFiles, ['acp_token.json', 'settings.json'])
    const sessionNew = eventsLog().filter((e) => e.event === 'session/new').at(-1)!
    assert.deepEqual(sessionNew.params, { cwd: initEvent.cwd, mcpServers: [], _meta: { antigravity: { enabledTools: [] } } })

    // Any tool_call or permission request kills the warm worker immediately and removes its ephemeral runDir.
    writeFileSync(modeFile, 'tool_call')
    await assert.rejects(complete('antigravity/gemini-4-neon', 'low'), /tool call/i)
    assert.equal(existsSync(String(initEvent.tmpdir)), false, 'ephemeral runDir must be removed immediately after tool violation')
    assert.throws(() => process.kill(Number(initEvent.pid), 0), 'violating worker process must be killed')
    writeFileSync(modeFile, 'permission')
    await assert.rejects(complete('antigravity/gemini-4-neon', 'low'), /tool/i)

    // Rate-limit detection across RPC error, swallowed chunk, and refusal; never leaks secrets.
    for (const rlMode of ['rpc_rate_limit', 'chunk_rate_limit', 'refusal_rate_limit']) {
      writeFileSync(modeFile, rlMode)
      await assert.rejects(complete('antigravity/gemini-4-neon', 'low'), (err: Error) => {
        assert.match(err.message, /rate limit/i)
        assert.doesNotMatch(err.message, /secret-oauth-token-leak/)
        return true
      })
    }

    // Bounded timeout kills hanging child and cleans up ephemeral runDir.
    writeFileSync(modeFile, 'hang')
    await assert.rejects(
      supervisorText({ kind: 'antigravity', bin: binary, harnessPath: harnessBin, authMethod: 'oauth-personal', tokenPath: validToken, id: 'gemini-4-neon', variant: 'low' }, 'hi', { startupMs: 5000, requestMs: 500 }),
      /timed out/i,
    )
    const hangInit = eventsLog().filter((e) => e.event === 'initialize').at(-1)!
    assert.equal(existsSync(String(hangInit.tmpdir)), false, 'ephemeral runDir must be removed after timeout')
    assert.throws(() => process.kill(Number(hangInit.pid), 0), 'hanging child process must be killed')

    // Disposing on refresh tears down any remaining warm worker and removes its ephemeral runDir.
    writeFileSync(modeFile, 'ok')
    assert.equal(await complete('antigravity/gemini-4-neon', 'low'), 'agy-decision')
    const warmInit = eventsLog().filter((e) => e.event === 'initialize').at(-1)!
    H.refreshT3()
    for (let i = 0; i < 40 && existsSync(String(warmInit.tmpdir)); i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(String(warmInit.tmpdir)), false, 'refresh must dispose warm worker and remove its runDir')

    // No tool-bearing T3 thread was ever launched.
    assert.ok(calls.slice(startCalls).every((c) => c.name === 'orchestrator_capabilities'))
  } finally {
    supervisorProviders = undefined
    writeFileSync(config, original)
    H.refreshT3()
  }
})

test('T3 real bridge streams growing activity once, returns success and keeps transcript/tool results', async () => {
  const l = launch(), start = events.length
  const result = await turn(l, 'stream')
  assert.equal(result.subtype, 'success')
  assert.equal(result.result, 'Hello')
  const chunks = events.slice(start).filter((e) => e.id === l.id && e.ev === 'claude.msg').map((e) => e.msg as { type?: string; event?: { delta?: { text?: string } } }).filter((m) => m.type === 'stream_event').map((m) => m.event?.delta?.text ?? '')
  assert.deepEqual(chunks, ['Hel', 'lo'], 'repeated MCP reads must not duplicate streamed text')
  const history = H.history(l).messages
  assert.equal(history.filter((m) => m.type === 'assistant').map(contentText).join(''), 'Hello', 'MCP-created user messages must never be rendered as assistant replies')
  assert.equal(history.filter((m) => m.type === 'user' && JSON.stringify(m).includes('tool_result')).length, 1)
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')?.nativeId
  assert.ok(typeof native === 'string')
  await H.stop(l.id)
  assert.ok(deleted > 0, 'stopping a bridge closes its MCP session')
  const launches = calls.filter((c) => c.name === 't3_thread_launch').length
  const resumed = { ...l, started: true, nativeId: native }
  assert.equal((await turn(resumed, 'resume')).result, 'Done')
  assert.equal(calls.filter((c) => c.name === 't3_thread_launch').length, launches, 'resume reuses its native conversation')
  assert.equal(H.history(l).messages.filter((m) => m.type === 'assistant').map(contentText).join(''), 'HelloDone')
  await H.stop(l.id)
})

test('T3 model and effort changes reach configure and unsupported options fail', async () => {
  const l = launch()
  await turn(l, 'quick')
  await H.setOption(l.id, 'model', 'fake/two')
  await H.setOption(l.id, 'effort', 'high')
  const selected = selectionWrites().at(-1)?.args.modelSelection
  assert.deepEqual(selected, { instanceId: 'fake', model: 'two', options: [{ id: 'variant', value: 'high' }] })
  await assert.rejects(H.setOption(l.id, 'effort', 'turbo'), /effort level/)
  await assert.rejects(H.setOption(l.id, 'model', 'fake/missing'), /not available/)
  await assert.rejects(H.setOption(l.id, 'permissionMode', 'plan'), /fixed/)
  await H.stop(l.id)
})

test('T3 launches with the chosen native thinking level and resets it without changing other options', async () => {
  const l = { ...launch(), model: 'fake/three', effort: 'xhigh' }
  await turn(l, 'quick')
  const launched = calls.filter((c) => c.name === 't3_thread_launch').at(-1)!
  assert.deepEqual(launched.args.modelSelection, { instanceId: 'fake', model: 'three', options: [{ id: 'thinking_level', value: 'xhigh' }] })
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const t = threads.get(native)!
  t.options!.push({ id: 'serviceTier', value: 'priority' })
  await H.setSelection(l.id, l.model, null)
  assert.deepEqual(t.options, [{ id: 'serviceTier', value: 'priority' }])
  await H.setSelection(l.id, 'fake/one', 'ultra')
  assert.deepEqual(t.options, [{ id: 'reasoningEffort', value: 'ultra' }])
  await H.stop(l.id)
  const invalid = { ...launch(), model: 'fake/three', effort: 'ultra' }
  const before = calls.filter((c) => c.name === 't3_thread_launch').length
  await assert.rejects(H.send(invalid, [{ type: 'text', text: 'quick' }], randomUUID()), /effort level/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_launch').length, before)
})

test('T3 model and effort are validated and applied together without partial remote changes', async () => {
  const l = launch()
  await turn(l, 'quick')
  await H.setSelection(l.id, 'fake/one', 'medium')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const before = selectionWrites().length
  await assert.rejects(H.setSelection(l.id, 'fake/two', 'medium'), /effort level/)
  assert.equal(selectionWrites().length, before, 'reject the complete invalid pair before configuring T3')
  assert.equal(threads.get(native)!.model, 'one')
  await H.setOption(l.id, 'effort', 'high')
  assert.equal((selectionWrites().at(-1)!.args.modelSelection as { model: string }).model, 'one', 'failed pair keeps the local model selection')
  const successful = selectionWrites().length
  await H.setSelection(l.id, 'fake/two', 'high')
  assert.equal(selectionWrites().length, successful + 1, 'one remote configure commits the valid pair')
  assert.deepEqual(selectionWrites().at(-1)!.args.modelSelection, { instanceId: 'fake', model: 'two', options: [{ id: 'variant', value: 'high' }] })
  await assert.rejects(H.setOption(l.id, 'model', null), /Choose a specific model/)
  await H.stop(l.id)
})

test('T3 an effort change keeps the actual model when the conversation started on Default', async () => {
  const l = launch()
  l.model = null
  await turn(l, 'quick')
  await H.setSelection(l.id, null, 'medium')
  assert.deepEqual(selectionWrites().at(-1)!.args.modelSelection, { instanceId: 'fake', model: 'one', options: [{ id: 'reasoningEffort', value: 'medium' }] })
  await H.stop(l.id)
})

test('T3 discovers a project default outside the short list and restores its level on resume', async () => {
  defaultModel = 'outside-short-list'
  const l = { ...launch(), model: null, effort: 'adaptive' }
  try {
    const id = 'fake/outside-short-list'
    const picker = await H.commandsAndModels('t3code', 'default', id)
    assert.deepEqual(picker.models.find((m) => m.value === id)?.supportedEffortLevels, ['low', 'adaptive'])
    assert.ok(!(await H.commandsAndModels('t3code', 'default')).models.some((m) => m.value === id))
    await turn(l, 'quick')
    const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
    const t = threads.get(native)!
    assert.deepEqual(t.options, [{ id: 'thinking_level', value: 'adaptive' }])
    assert.deepEqual(events.find((e) => e.id === l.id && e.ev === 'claude.efforts')?.efforts, ['low', 'adaptive'])
    await H.stop(l.id)
    // The native app changed reasoning offline; read it and apply DevDash's saved setting before the next turn.
    t.options = [{ id: 'thinking_level', value: 'low' }]
    await turn({ ...l, started: true, nativeId: native }, 'quick')
    assert.deepEqual(t.options, [{ id: 'thinking_level', value: 'adaptive' }])
    await H.stop(l.id)
  } finally { defaultModel = 'one' }
})

test('T3 explicit connection refresh invalidates its cached models', async () => {
  const before = (await H.commandsAndModels('t3code', 'default')).models
  caps.providers[0]!.models.push({ id: 'newly-connected', options: [] })
  try {
    assert.deepEqual((await H.commandsAndModels('t3code', 'default')).models, before, 'normal reads use the short model cache')
    H.refreshT3()
    assert.ok((await H.commandsAndModels('t3code', 'default')).models.some((m) => m.value === 'fake/newly-connected'))
  } finally { caps.providers[0]!.models.pop(); H.refreshT3() }
})

test('T3 cancellation interrupts its native run and emits a cancelled result', async () => {
  const l = launch(), index = events.length
  const active = eventAfter(index, (e) => e.id === l.id && (e.msg as { type?: string } | undefined)?.type === 'stream_event')
  const result = eventAfter(index, isResult(l.id))
  await H.send(l, [{ type: 'text', text: 'cancel' }], randomUUID())
  await active
  await H.interrupt(l.id)
  const msg = (await result).msg as Record<string, unknown>
  assert.equal(msg.terminal_reason, 'aborted_by_user')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')?.nativeId
  assert.ok(calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === native && typeof c.args.runId === 'string'))
  await H.stop(l.id)
})

test('T3 guest and attachment requests are rejected before opening a bridge or sending a prompt', async () => {
  const l = launch(), before = calls.length
  await assert.rejects(H.send(l, [{ type: 'text', text: 'guest' }], randomUUID(), { id: 2, name: 'Guest' }), /guest turns/)
  await assert.rejects(H.send(l, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }], randomUUID()), /text messages only/)
  await assert.rejects(H.send({ ...l, toolPolicy: { tools: ['Read'] } }, [{ type: 'text', text: 'restricted' }], randomUUID()), /restricted roles/)
  assert.equal(calls.length, before)
})

test('T3 send HTTP failures become visible errors without duplicate sends and all sessions close', async () => {
  const l = launch(), before = calls.filter((c) => c.name === 't3_thread_send').length
  const result = await turn(l, 'fail-send')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /HTTP 503/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, before + 1)
  const retry = await turn(l, 'another message')
  assert.equal(retry.is_error, true)
  assert.match(String(retry.result), /may still be running/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, before + 1, 'an unknown outcome stays blocked until the member checks and reconnects')
  await H.stop(l.id)
  assert.equal(deleted, initialized, 'every successful MCP initialize is cleaned up on stop')
})

test('T3 clean send rejection leaves the conversation usable without an interrupt', async () => {
  const l = launch(), interrupts = calls.filter((c) => c.name === 't3_thread_interrupt').length
  assert.equal((await turn(l, 'clean-rejection')).is_error, true)
  assert.equal((await turn(l, 'quick')).result, 'Done')
  assert.equal(calls.filter((c) => c.name === 't3_thread_interrupt').length, interrupts)
  await H.stop(l.id)
})

test('T3 provider errors appear in activity even while its provider is still retrying', async () => {
  const l = launch(), from = events.length
  assert.equal((await turn(l, 'provider-error')).result, 'Done')
  const history = H.history(l).messages
  assert.ok(history.some((m) => JSON.stringify(m).includes('Provider request failed with HTTP 503')))
  assert.ok(events.slice(from).some((e) => JSON.stringify(e).includes('T3 Code provider error')))
  await H.stop(l.id)
})

test('T3 full text pages are joined and waiting notices point to T3 without being duplicated', async () => {
  const l = launch()
  const long = await turn(l, 'long-text')
  assert.equal(long.result, 'L'.repeat(60010))
  assert.ok(calls.some((c) => c.name === 't3_thread_read' && c.args.textOffset === 50000))
  const start = events.length
  const done = await turn(l, 'waiting')
  assert.equal(done.result, 'Approved')
  const notices = events.slice(start).filter((e) => e.id === l.id && e.ev === 'claude.msg' && (e.msg as { type?: string }).type === 'assistant').map((e) => contentText(e.msg)).filter((text) => text.includes('needs an answer'))
  assert.equal(notices.length, 1)
  assert.deepEqual(events.slice(start).filter((e) => e.id === l.id && e.ev === 'claude.status').map((e) => e.status), ['working', 'waiting', 'working', 'idle'])
  assert.equal(H.pendingFor(l.id).length, 0)
  assert.match(notices[0]!, /https:\/\/t3.example\/thread/)
  await H.stop(l.id)
})

test('T3 transient waiting without a pending request does not replace the real final reply', async () => {
  const l = launch()
  const start = events.length
  const done = await turn(l, 'transient-wait')
  assert.ok(!events.slice(start).some((e) => e.id === l.id && e.ev === 'claude.status' && e.status === 'waiting'))
  assert.equal(done.result, 'Final reply')
  const history = H.history(l).messages.map(contentText).join('\n')
  assert.ok(!history.includes('needs an approval or answer'))
  await H.stop(l.id)
})

test('T3 replays paginated native history and a workspace mismatch never starts a replacement', async () => {
  const l = launch()
  await turn(l, 'quick')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  await H.stop(l.id)
  const t = threads.get(native)!
  for (let i = 0; i < 105; i++) {
    const runId = `external-${i}`
    t.items.push({ itemId: `external-user-${i}`, position: t.items.length, runId, type: 'user_message', createdBy: 'user', text: `external question ${i}`, title: null, status: 'completed' })
    t.items.push({ itemId: `external-agent-${i}`, position: t.items.length, runId, type: 'assistant_message', createdBy: 'agent', text: `external answer ${i}`, title: null, status: 'completed' })
  }
  const resumed = { ...l, started: true, nativeId: native }
  await turn(resumed, 'after-external')
  const text = H.history(l, { turns: 200 }).messages.map(contentText).join('\n')
  assert.match(text, /external question 0/)
  assert.match(text, /external answer 104/)
  assert.ok(calls.some((c) => c.name === 't3_thread_read' && c.args.afterPosition === 99))
  await H.stop(l.id)
  t.projectId = 'wrong-project'
  const launches = calls.filter((c) => c.name === 't3_thread_launch').length
  const sends = calls.filter((c) => c.name === 't3_thread_send').length
  await assert.rejects(H.send(resumed, [{ type: 'text', text: 'wrong-folder' }], randomUUID()), /different folder/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_launch').length, launches)
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, sends)
})

test('T3 can change thinking after the idle bridge closes without sending a turn', async () => {
  const l = launch()
  await turn(l, 'quick')
  const nativeId = String(events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId)
  await H.stop(l.id)
  const stopped = { ...l, started: true, nativeId }
  const before = calls.length
  await assert.rejects(H.setSelection(l.id, 'fake/two', 'medium', stopped), /effort level/)
  assert.equal(threads.get(nativeId)!.model, 'one')
  await H.setSelection(l.id, 'fake/two', 'high', stopped)
  assert.equal(threads.get(nativeId)!.model, 'two')
  const writes = calls.slice(before).filter((c) => c.name === 't3_thread_configure' && c.args.modelSelection)
  assert.equal(writes.length, 1)
  assert.deepEqual((writes[0]!.args.modelSelection as { options: unknown[] }).options, [{ id: 'variant', value: 'high' }])
  assert.ok(!calls.slice(before).some((c) => c.name === 't3_thread_send' || c.name === 't3_thread_launch'))
  await H.stop(l.id)
})

test('T3 poll read failures interrupt the active native run before reporting an error', async () => {
  const l = launch()
  const result = await turn(l, 'fail-poll')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /HTTP 503/)
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const t = threads.get(native)!
  assert.equal(t.runs[0]?.status, 'interrupted')
  assert.ok(calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === native && c.args.runId === t.runId))
  await H.stop(l.id)
})

test('T3 cancellation during the baseline read prevents sending the prompt', async () => {
  const l = launch()
  await turn(l, 'quick')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const pause = delayNext('t3_thread_read', native)
  const before = calls.filter((c) => c.name === 't3_thread_send').length
  const result = eventAfter(events.length, isResult(l.id))
  await H.send(l, [{ type: 'text', text: 'cancel' }], randomUUID())
  await pause.entered
  try {
    await H.interrupt(l.id)
    // This request follows the cancel notification on the same ACP pipe. Its reply
    // proves the child processed cancellation before the held HTTP read resumes.
    await assert.rejects(H.setOption(l.id, 'effort', 'high'), /Wait for T3 Code to finish/)
  } finally { pause.release() }
  assert.equal(((await result).msg as Record<string, unknown>).terminal_reason, 'aborted_by_user')
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, before)
  await H.stop(l.id)
})

test('T3 cancellation during a delayed send response interrupts the accepted run', async () => {
  const l = launch()
  await turn(l, 'quick')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const pause = delayNext('t3_thread_send', native)
  const result = eventAfter(events.length, isResult(l.id))
  await H.send(l, [{ type: 'text', text: 'cancel' }], randomUUID())
  await pause.entered
  const accepted = threads.get(native)!.runId
  const interrupts = calls.filter((c) => c.name === 't3_thread_interrupt').length
  try {
    await H.interrupt(l.id)
    await assert.rejects(H.setOption(l.id, 'effort', 'high'), /Wait for T3 Code to finish/)
    assert.equal(calls.filter((c) => c.name === 't3_thread_interrupt').length, interrupts, 'an unresolved send is not permission to interrupt the whole thread')
  } finally { pause.release() }
  assert.equal(((await result).msg as Record<string, unknown>).terminal_reason, 'aborted_by_user')
  assert.ok(calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === native && c.args.runId === accepted))
  assert.equal(threads.get(native)!.runs[0]?.status, 'interrupted')
  await H.stop(l.id)
})

test('T3 a lost send response cancels only the correlated accepted run without resending', async () => {
  const l = launch(), before = calls.filter((c) => c.name === 't3_thread_send').length
  const result = await turn(l, 'lost-send-response')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /HTTP 503/)
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  assert.equal(threads.get(native)!.runs[0]?.status, 'interrupted')
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, before + 1)
  assert.ok(calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === native && c.args.runId === threads.get(native)!.runs[0]?.runId))
  await H.stop(l.id)
})


test('T3 sends only the member message, without copying DevDash rules or personal instructions', async () => {
  const l = launch()
  l.instructions = 'PRIVATE_SESSION_RULES_MUST_NOT_LEAVE_DEVDASH'
  await turn(l, 'quick')
  const sent = calls.filter((c) => c.name === 't3_thread_send').at(-1)!
  assert.equal(sent.args.message, 'quick')
  assert.ok(!String(sent.args.message).includes('PRIVATE_SESSION_RULES'))
  await H.stop(l.id)
})

test('Hamasa and Autopilot invoke only their workflow tools with the current member session', async () => {
  const run = promisify(execFile)
  const l = launch()
  const native = `thread-${threads.size + 1}`
  const socket = join(home, "member's agent.sock")
  const requests: { method: string; params: { sessionId: string; cwd: string; args: Record<string, unknown> } }[] = []
  let brokenReply: 'invalid' | 'disconnect' | undefined
  const server = unixServer((s) => s.on('data', (buf) => {
    const req = JSON.parse(String(buf))
    requests.push(req)
    if (brokenReply && req.method === 'mcp.sessions_list') return s.end(brokenReply === 'invalid' ? 'invalid JSON\n' : '')
    const reply = req.method === 'mcp.assistant_here' ? { name: 'Test' } : req.method === 'mcp.autopilot_here' ? true : req.method === 'mcp.team_role' ? { session: true } : 'From the member socket'
    s.end(JSON.stringify({ result: reply }) + '\n')
  })).listen(socket)
  await new Promise<void>((r) => server.once('listening', r))
  const originalSocket = process.env.DEVDASH_AGENT_SOCKET
  process.env.DEVDASH_AGENT_SOCKET = socket
  try {
    for (const assistant of [true, false]) {
      const pause = delayNext('t3_thread_send', native)
      const done = eventAfter(events.length, isResult(l.id))
      const launch = { ...l, originKind: assistant ? 'assistant' : null, instructions: 'A personal agent instruction.' }
      await H.send(launch, [{ type: 'text', text: 'What is open?' }], randomUUID(), null, !assistant)
      await pause.entered
      const dir = join(home, '.cache', 'devdash', 'sessions', l.id)
      const helper = join(dir, readdirSync(dir).find((f) => f.startsWith('tools-'))!)
      try {
        const sent = String(calls.filter((c) => c.name === 't3_thread_send').at(-1)!.args.message)
        assert.match(sent, /What is open\?$/)
        assert.equal(sent.includes('A personal agent instruction.'), assistant)
        assert.ok(sent.includes(helper) && !sent.includes(socket))
        assert.equal(statSync(helper).mode & 0o777, 0o700)
        const list = (await run(helper, ['list'])).stdout.trim().split('\n')
        const name = assistant ? 'sessions_list' : 'autopilot_rules'
        assert.ok(list.includes(name))
        assert.equal(list.includes('team_threads'), assistant)
        assert.ok(!list.includes(assistant ? 'autopilot_log' : 'session_create'))
        const cmd = run(helper, ['call', name])
        cmd.child.stdin!.end('{"mine":true}')
        assert.match((await cmd).stdout, /From the member socket/)
        assert.deepEqual(requests.at(-1), { op: 'rpc', method: 'mcp.' + name, params: { sessionId: l.id, cwd: home, args: { mine: true } } })
        if (assistant) {
          for (brokenReply of ['invalid', 'disconnect'] as const) {
            const broken = run(helper, ['call', name])
            broken.child.stdin!.end('{}')
            await assert.rejects(broken, brokenReply === 'invalid' ? /unreadable response/ : /disconnected before answering/)
          }
          brokenReply = undefined
        }
        const rejected = run(helper, ['call', 'unlisted'])
        rejected.child.stdin!.end('{}')
        await assert.rejects(rejected, /Unknown workflow tool/)
      } finally { pause.release() }
      await done
      assert.ok(!existsSync(helper))
    }
    assert.equal((await turn(l, 'plain follow-up')).result, 'Done')
    assert.equal(calls.filter((c) => c.name === 't3_thread_send').at(-1)!.args.message, 'plain follow-up')

    // Rebuild from the fake native conversation to exercise the replay path. An ordinary native user's
    // lookalike note must survive verbatim, but the bridge's own per-turn workflow block stays private.
    await H.stop(l.id)
    rmSync(join(home, '.local/share/devdash/sessions', l.id + '.jsonl'))
    const t = threads.get(native)!, marker = randomUUID()
    const literal = `[DevDash workflow ${marker}]\nquoted by the native user\n[/DevDash workflow ${marker}]\n\nplain text`
    t.items.push({ itemId: 'native-user', position: t.items.length, runId: randomUUID(), type: 'user_message', createdBy: 'user', text: literal, title: null, status: 'completed' })
    await turn({ ...l, nativeId: native, started: true }, 'resume')
    const prompts = H.history(l).messages.filter((m) => m.type === 'user').map(contentText)
    assert.deepEqual(prompts, ['What is open?', 'What is open?', 'plain follow-up', literal, 'resume'])
  } finally {
    await H.stop(l.id)
    if (originalSocket === undefined) delete process.env.DEVDASH_AGENT_SOCKET
    else process.env.DEVDASH_AGENT_SOCKET = originalSocket
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('T3 refuses an already active native conversation and never stops its external run', async () => {
  const l = launch()
  await turn(l, 'quick')
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const t = threads.get(native)!, external = externalRun(t)
  const sent = calls.filter((c) => c.name === 't3_thread_send').length
  const interrupts = calls.filter((c) => c.name === 't3_thread_interrupt').length
  const result = await turn(l, 'my next message')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /already running in T3 Code/)
  assert.equal(calls.filter((c) => c.name === 't3_thread_send').length, sent)
  await H.stop(l.id)
  assert.equal(calls.filter((c) => c.name === 't3_thread_interrupt').length, interrupts)
  assert.equal(t.runs.find((r) => r.runId === external)?.status, 'running')
})

test('T3 rejected sends do not interrupt an unrelated run that starts in its own app', async () => {
  const l = launch()
  const interrupts = calls.filter((c) => c.name === 't3_thread_interrupt').length
  const result = await turn(l, 'rejected-with-external')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /HTTP 503/)
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  await H.stop(l.id)
  assert.equal(calls.filter((c) => c.name === 't3_thread_interrupt').length, interrupts)
  assert.equal(threads.get(native)!.runs[0]?.status, 'running')
})

test('T3 cancels only its queued turn if another app starts a run during the send', async () => {
  const l = launch(), from = calls.length
  const result = await turn(l, 'raced-external')
  assert.equal(result.is_error, true)
  assert.match(String(result.result), /queued DevDash turn was cancelled/)
  const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
  const t = threads.get(native)!
  assert.equal(t.runs[0]!.status, 'interrupted')
  assert.equal(t.runs[1]!.status, 'running', 'the racing native-app run is untouched')
  assert.deepEqual(calls.slice(from).filter((c) => c.name === 't3_thread_interrupt').map((c) => c.args.runId), [t.runs[0]!.runId])
  await H.stop(l.id)
})

test('T3 stops only its own run at a finite turn deadline and backs off while activity is unchanged', async () => {
  const l = launch()
  const previous = process.env.DEVDASH_T3_TURN_TIMEOUT_MS
  process.env.DEVDASH_T3_TURN_TIMEOUT_MS = '1800'
  try {
    const result = await turn(l, 'long-stall')
    assert.equal(result.is_error, true)
    assert.match(String(result.result), /turn time limit/)
    const native = events.find((e) => e.id === l.id && e.ev === 'claude.native')!.nativeId as string
    const t = threads.get(native)!
    assert.equal(t.runs[0]?.status, 'interrupted')
    const reads = calls.filter((c) => c.name === 't3_thread_read' && c.args.threadId === native)
    assert.ok(reads.filter((c) => c.args.textOffset === 50000).length <= 4, 'unchanged completed or timestamped text pages should be cached')
    assert.ok(reads.filter((c) => c.args.textOffset === undefined).length <= 9, 'polling backs off rather than spinning on unchanged activity')
    await H.stop(l.id)
  } finally {
    if (previous === undefined) delete process.env.DEVDASH_T3_TURN_TIMEOUT_MS
    else process.env.DEVDASH_T3_TURN_TIMEOUT_MS = previous
  }
})

test('T3 unavailable discovery is bounded and cached instead of delaying every setup request', async () => {
  stalledDiscovery = true
  H.refreshT3()
  try {
    const started = Date.now()
    const first = (await H.agents()).find((a) => a.harness === 't3code')!
    assert.equal(first.installed, false)
    assert.ok(Date.now() - started < 4000, 'a blackholed T3 must not stall setup for the normal 30 second MCP timeout')
    const probes = calls.filter((c) => c.name === 'orchestrator_capabilities').length
    const second = (await H.agents()).find((a) => a.harness === 't3code')!
    assert.equal(second.installed, false)
    assert.equal(calls.filter((c) => c.name === 'orchestrator_capabilities').length, probes, 'cache an unavailable connection as well as a healthy one')
  } finally { stalledDiscovery = false; H.refreshT3() }
})

test('T3 refresh starts a new discovery probe and a stale result cannot replace its cache', async () => {
  const T3 = await import('./t3code.ts')
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  discoveryHold = { entered: enter, released }
  T3.invalidateInfo()
  const old = T3.info()
  try {
    await entered
    caps.providers[0]!.displayName = 'Refreshed provider'
    T3.invalidateInfo()
    const fresh = await T3.info()
    assert.deepEqual(fresh.profiles[0]!.providers, ['Refreshed provider'])
    release()
    await old
    assert.deepEqual((await T3.info()).profiles[0]!.providers, ['Refreshed provider'])
  } finally {
    release(); await old
    caps.providers[0]!.displayName = 'Fake T3 provider'
    T3.invalidateInfo()
  }
})
