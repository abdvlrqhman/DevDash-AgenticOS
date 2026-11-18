import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Launch } from './claude.ts'

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
    data = result
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
      if (t.behavior === 'waiting') { current.status = t.reads < 3 ? 'waiting' : 'completed'; t.status = current.status }
      if (['quick', 'long'].includes(t.behavior) || (['stream', 'waiting'].includes(t.behavior) && t.reads >= 3)) {
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
  const result = eventAfter(events.length, isResult(l.id))
  await H.send(l, [{ type: 'text', text }], randomUUID())
  return (await result).msg as Record<string, unknown>
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
  assert.match(notices[0]!, /https:\/\/t3.example\/thread/)
  await H.stop(l.id)
})

test('T3 transient waiting without a pending request does not replace the real final reply', async () => {
  const l = launch()
  const done = await turn(l, 'transient-wait')
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
