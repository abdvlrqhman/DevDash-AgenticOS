// ACP bridge to a member-owned T3 Code instance. Only explicit Bypass sessions run here; DevDash approval modes are unavailable.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { T3Client, T3RequestError } from './t3-client.ts'
import { connectedCapabilities, effortOption, selection, modelId, type Capabilities } from './t3code.ts'

type Selection = { model: string; instanceId: string; options?: { id: string; value: string | boolean }[] }
type Item = { itemId: string; position: number; runId: string | null; type: string; createdBy: string | null; text: string | null; title: string | null; status: string; textTruncated?: boolean; nextTextOffset?: number | null; [key: string]: unknown }
type Read = { thread: { threadId: string; projectId: string; worktreePath?: string | null; model: string; providerInstanceId: string; status: string; title: string; activeRunId?: string | null; latestRunId?: string | null; pendingRequestCount?: number; runtimeMode: string; interactionMode: string; link?: string | null }; items: Item[]; hasMore: boolean; nextPosition: number | null; recentRuns: { runId: string; status: string; [key: string]: unknown }[] }
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'])
const send = (m: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
const client = new T3Client()
let caps: Capabilities
let thread: Read['thread'] | undefined
let running: string | undefined
let unresolvedSend = false
let activePrompt = false
let deadlineAt = 0
let pollWake: AbortController | undefined
let lastPosition = -1
let stopped = false
let closing = false
let promptDone: Promise<unknown> | undefined
let effort = 'default'
let mode = process.env.DEVDASH_T3_PERMISSION_MODE ?? 'default'
const update = (u: Record<string, unknown>) => send({ method: 'session/update', params: { sessionId: thread?.threadId, update: u } })
const desiredModes = () => ({ runtimeMode: 'full-access', interactionMode: 'default' })
const activeRun = (data: Read) => data.thread.activeRunId ?? data.recentRuns.find((r) => !terminal.has(r.status))?.runId
const busyThread = (data: Read) => !!activeRun(data) || ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(data.thread.status)
const limit = (name: string, fallback: number, min: number, max: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback }
const turnLimitMs = limit('DEVDASH_T3_TURN_TIMEOUT_MS', 30 * 60_000, 100, 30 * 60_000)
function currentModel() { return caps.providers.find((p) => p.providerInstanceId === thread?.providerInstanceId)?.models.find((m) => m.id === thread?.model) }
/** A project's default or a resumed model may be outside T3's short list. Search its exact ID when necessary. */
async function findModel(picked: Selection) {
  const provider = caps.providers.find((p) => p.providerInstanceId === picked.instanceId)
  const listed = provider?.models.find((m) => m.id === picked.model)
  if (listed || !provider?.omittedModels) return listed
  const result = await connectedCapabilities(client, picked.model)
  const match = result.providers.find((p) => p.providerInstanceId === picked.instanceId)?.models.find((m) => m.id === picked.model)
  if (match) provider.models.push(match)
  return match
}
// With no modelSelection this MCP operation is read-only and returns options that t3_thread_read omits.
async function readSelection() {
  const result = await client.call<{ modelSelection: Selection }>('t3_thread_configure', { threadId: thread!.threadId })
  return result.modelSelection
}
async function withEffort(picked: Selection, level: string | null): Promise<Selection> {
  const model = await findModel(picked)
  if (!model) throw new Error('That model is not available from a connected T3 Code provider.')
  const opt = effortOption(model)
  const options = (picked.options ?? []).filter((o) => o.id !== opt?.id)
  if (level && level !== 'default') {
    if (!opt?.levels.includes(level)) throw new Error('That effort level is not available for this T3 Code model.')
    options.push({ id: opt.id, value: level })
  }
  return { instanceId: picked.instanceId, model: picked.model, ...(options.length ? { options } : {}) }
}
function configOptions() {
  return [
    { id: 'model', category: 'model', currentValue: thread ? modelId(thread.providerInstanceId, thread.model) : '', options: caps.providers.flatMap((p) => p.models.map((m) => ({ value: modelId(p.providerInstanceId, m.id), name: `${p.displayName ?? p.providerInstanceId}: ${m.label ?? m.id}` }))) },
    { id: 'effort', category: 'thought_level', currentValue: effort, options: [{ value: 'default', name: 'Default' }, ...(effortOption(currentModel())?.levels ?? []).map((value) => ({ value, name: value }))] },
  ]
}
function checkDeadline() {
  if (activePrompt && running && deadlineAt && Date.now() >= deadlineAt) throw new Error('T3 Code turn time limit was reached.')
}
async function readThread(o: Record<string, unknown> = {}): Promise<Read> {
  checkDeadline()
  const data = await client.call<Read>('t3_thread_read', { threadId: thread!.threadId, view: 'activity', limit: 100, maxCharsPerItem: 50000, ...o })
  checkDeadline()
  for (const item of data.items) lastPosition = Math.max(lastPosition, item.position)
  return data
}
async function allItems(afterPosition = -1) {
  const items: Item[] = []
  let page: Read
  do {
    page = await readThread(afterPosition < 0 ? {} : { afterPosition })
    items.push(...page.items)
    if (page.hasMore) {
      if (page.nextPosition === null || page.nextPosition <= afterPosition) throw new Error('T3 Code returned an invalid history cursor.')
      afterPosition = page.nextPosition
    }
  } while (page.hasMore)
  return { ...page, items }
}
const textCache = new Map<string, { key: string; text: string }>()
async function fullText(item: Item) {
  const key = JSON.stringify([item.text, item.status, item.nextTextOffset, item.updatedAt])
  const cached = textCache.get(item.itemId)
  if (cached?.key === key) return cached.text
  let text = item.text ?? ''
  let offset = item.nextTextOffset
  while (item.textTruncated && offset != null) {
    const page = await readThread({ itemId: item.itemId, textOffset: offset })
    const part = page.items.find((i) => i.itemId === item.itemId)
    if (!part) throw new Error('T3 Code could not return the full message.')
    text += part.text ?? ''
    if (!part.textTruncated) break
    if (part.nextTextOffset == null || part.nextTextOffset <= offset) throw new Error('T3 Code returned an invalid text cursor.')
    offset = part.nextTextOffset
  }
  if (terminal.has(item.status) || typeof item.updatedAt === 'string') {
    if (textCache.size >= 64) textCache.delete(textCache.keys().next().value!)
    textCache.set(item.itemId, { key, text })
  }
  return text
}
const sentText = new Map<string, string>()
const sentTools = new Map<string, string>()
async function transcribe(items: Item[], replay = false) {
  for (const i of items) {
    let text = await fullText(i)
    // createdBy identifies who submitted the item (MCP sends are agent-created), not its conversation role.
    const user = i.type === 'user_message' || (i.type === 'message' && i.createdBy === 'user')
    const assistant = i.type === 'assistant_message' || (i.type === 'message' && i.createdBy === 'agent')
    if (replay && user) {
      const marker = /^\[DevDash workflow ([a-f0-9-]{36})\]\n/.exec(text)
      if (marker && requestMatches(i, marker[1]!)) {
        const end = `\n[/DevDash workflow ${marker[1]}]\n\n`
        const idx = text.indexOf(end)
        if (idx !== -1) text = text.slice(idx + end.length)
      }
    }
    const previous = sentText.get(i.itemId) ?? ''
    if (assistant || (replay && user)) {
      if (text !== previous && text.startsWith(previous)) {
        update({ sessionUpdate: user ? 'user_message_chunk' : 'agent_message_chunk', messageId: i.itemId, content: { type: 'text', text: text.slice(previous.length) } })
        sentText.set(i.itemId, text)
      }
    } else if (['tool_call', 'tool', 'activity', 'command_execution', 'file_change', 'tool_invocation', 'error'].includes(i.type)) {
      const key = `${i.status}:${text}`
      if (sentTools.get(i.itemId) === key) continue
      sentTools.set(i.itemId, key)
      // Activity is informational: permissions are enforced by T3, never fabricated as DevDash approvals.
      const title = i.title ?? (i.type === 'error' ? 'T3 Code provider error' : 'T3 Code activity')
      update({ sessionUpdate: 'tool_call_update', toolCallId: i.itemId, title, name: 'T3 Code', status: i.type === 'error' || i.status === 'failed' ? 'failed' : terminal.has(i.status) || i.status === 'idle' ? 'completed' : 'in_progress', rawInput: { description: title }, rawOutput: text })
    }
  }
}
async function checkWorkspace(cwd: string) {
  const project = await client.call<{ workspaceRoot: string }>('t3_project_read', { projectId: thread!.projectId })
  if (realpathSync(thread!.worktreePath ?? project.workspaceRoot) !== realpathSync(cwd)) throw new Error('The T3 Code conversation belongs to a different folder.')
}
/** Validate the whole selection before T3 changes anything; committing model then effort can leave the two apps apart. */
async function setSelection(model: string | null, requestedEffort: string | null) {
  if (running || unresolvedSend || activePrompt) throw new Error('Wait for T3 Code to finish before changing its model or effort.')
  caps = await connectedCapabilities(client)
  const current = await readSelection()
  // Keep unrelated options such as service tier when only the reasoning level changes.
  const picked = !model || model === modelId(current.instanceId, current.model) ? current : selection(model)
  const modelSelection = await withEffort(picked, requestedEffort)
  if (busyThread(await readThread())) throw new Error('T3 Code is already running this conversation. Wait for it to finish before changing its model or effort.')
  await client.call('t3_thread_configure', { threadId: thread!.threadId, modelSelection })
  effort = requestedEffort ?? 'default'
  thread = { ...thread!, providerInstanceId: picked.instanceId, model: picked.model }
  return { configOptions: configOptions() }
}
function requestMatches(item: Item, requestId: string) {
  for (const value of [item.messageId, item.itemId]) {
    if (typeof value !== 'string') continue
    let decoded = value
    for (let i = 0; i < 3; i++) {
      if (decoded.endsWith(`:thread-send:${requestId}`)) return true
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next } catch { break }
    }
  }
  return false
}
async function stopOwned(runId: string) {
  await client.call('t3_thread_interrupt', { threadId: thread!.threadId, runId, clientRequestId: randomUUID() })
  if (running === runId) running = undefined
}
const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
  initialize: async () => {
    await client.connect()
    caps = await connectedCapabilities(client)
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: false } }, agentInfo: { name: 't3code', version: client.serverVersion ?? 'unknown' } }
  },
  'session/new': async (p) => {
    if (thread) throw new Error('A T3 Code conversation is already open.')
    if (mode !== 'bypassPermissions') throw new Error('This T3 Code connection supports only explicitly selected Bypass sessions. DevDash approval modes are unavailable.')
    if (caps.runtimeMode !== 'full-access') throw new Error('The member T3 Code connection does not allow Bypass sessions.')
    const wanted = process.env.DEVDASH_T3_MODEL
    const wantedEffort = process.env.DEVDASH_T3_EFFORT || null
    const initial = wanted ? await withEffort(selection(wanted), wantedEffort) : undefined
    if (!caps.providers.some((p) => p.models.length)) throw new Error('No connected T3 Code provider has available models.')
    const cwd = realpathSync(String(p.cwd))
    // Bind every conversation to exactly the folder DevDash selected, including existing worktrees.
    let projectId: string | undefined
    let cursor: number | undefined
    do {
      const page = await client.call<{ projects: { id: string; workspaceRoot: string }[]; nextCursor: number | null }>('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
      projectId = page.projects.find((x) => x.workspaceRoot === cwd)?.id
      cursor = page.nextCursor ?? undefined
    } while (!projectId && cursor !== undefined)
    if (!projectId) projectId = (await client.call<{ id: string }>('t3_project_create', { title: `DevDash: ${cwd.split('/').at(-1)}`, workspaceRoot: cwd })).id
    const launched = await client.call<{ threadId: string }>('t3_thread_launch', {
      projectId, title: process.env.DEVDASH_T3_TITLE || 'DevDash session', ...desiredModes(), workspaceStrategy: { type: 'root' },
      clientRequestId: process.env.DEVDASH_SESSION_ID ?? randomUUID(), ...(initial ? { modelSelection: initial } : {}),
    })
    thread = { threadId: launched.threadId } as Read['thread']
    thread = (await readThread()).thread
    const desired = desiredModes()
    if (thread.runtimeMode !== desired.runtimeMode || thread.interactionMode !== desired.interactionMode) throw new Error('The member T3 Code instance did not open the requested Bypass conversation. Reconnect that member instance.')
    if (initial) effort = wantedEffort ?? 'default'
    else await findModel({ instanceId: thread.providerInstanceId, model: thread.model })
    return { sessionId: thread.threadId, configOptions: configOptions() }
  },
  'session/load': async (p) => {
    thread = { threadId: String(p.sessionId) } as Read['thread']
    const data = await allItems()
    thread = data.thread
    await checkWorkspace(String(p.cwd))
    const desired = desiredModes()
    if (mode !== 'bypassPermissions' || thread.runtimeMode !== desired.runtimeMode || thread.interactionMode !== desired.interactionMode) throw new Error('This T3 Code connection supports only explicitly selected Bypass sessions. Start a new session to change permissions.')
    const current = await readSelection()
    thread = { ...thread, providerInstanceId: current.instanceId, model: current.model }
    const opt = effortOption(await findModel(current))
    const savedLevel = current.options?.find((o) => o.id === opt?.id)?.value
    effort = typeof savedLevel === 'string' ? savedLevel : 'default'
    await transcribe(data.items, true)
    return { configOptions: configOptions() }
  },
  'session/set_selection': (p) => {
    if ((p.model !== null && typeof p.model !== 'string') || (p.effort !== null && typeof p.effort !== 'string')) throw new Error('Invalid T3 Code model or effort.')
    return setSelection(p.model as string | null, p.effort as string | null)
  },
  'session/set_config_option': (p) => {
    if (p.configId === 'model') return setSelection(String(p.value), null)
    if (p.configId === 'effort') return setSelection(null, p.value === 'default' ? null : String(p.value))
    throw new Error('Unknown T3 Code option.')
  },
  'session/prompt': async (p) => {
    if (running || unresolvedSend || activePrompt) throw new Error('T3 Code may still be running. Stop the conversation before sending again.')
    const prompt = p.prompt as { type: string; text?: string }[]
    if (!Array.isArray(prompt) || prompt.some((b) => b.type !== 'text')) throw new Error('This T3 Code bridge currently accepts text messages only.')
    stopped = false
    activePrompt = true
    deadlineAt = Date.now() + turnLimitMs
    try {
      // Read only activity added since this bridge last saw the thread. Never queue behind a turn from T3's own UI.
      const before = await allItems(lastPosition)
      thread = before.thread
      if (busyThread(before)) throw new Error('This conversation is already running in T3 Code. Wait for it to finish or stop it there before sending another message.')
      if (stopped || closing) return { stopReason: 'cancelled' }
      const afterPosition = lastPosition
      const requestId = randomUUID()
      const text = prompt.map((b) => b.text ?? '').join('\n')
      const message = typeof p.workflowContext === 'string'
        ? `[DevDash workflow ${requestId}]\n${p.workflowContext}\n[/DevDash workflow ${requestId}]\n\n${text}` : text
      const baselineRuns = new Set(before.recentRuns.map((r) => r.runId))
      unresolvedSend = true
      let result: { runId: string; delivery?: string }
      try {
        result = await client.call<{ runId: string; delivery?: string }>('t3_thread_send', { threadId: thread!.threadId, message, mode: 'queue', clientRequestId: requestId })
        unresolvedSend = false
      } catch (err) {
        // A rejection or lost reply does not authorize stopping somebody else's turn. Reconcile only our exact
        // request id, exposed in T3's public message identity. Unknown formats fail closed, without a blind interrupt.
        try {
          const data = await allItems(afterPosition)
          const own = data.items.find((i) => i.type === 'user_message' && i.runId && !baselineRuns.has(i.runId) && requestMatches(i, requestId))
          if (own?.runId) {
            running = own.runId
            await stopOwned(own.runId)
            unresolvedSend = false
          } else if (err instanceof T3RequestError && !err.mayHaveExecuted) {
            unresolvedSend = false
          }
        } catch {
          throw new Error('Lost contact while sending to T3 Code. Check the conversation in T3 Code before retrying; no unrelated run was stopped.')
        }
        if (unresolvedSend) throw new Error(`${(err as Error).message} The send outcome is unknown. Check the conversation in T3 Code before reconnecting; no unrelated run was stopped.`)
        throw err
      }
      const runId = result.runId
      running = runId
      const deadline = deadlineAt
      let waiting = false
      let waits = 0
      let settled = false
      let cursor = afterPosition
      let interval = 250
      let previous = ''
      try {
        if (result.delivery === 'queued') {
          await stopOwned(runId)
          settled = true
          throw new Error('Another turn started in T3 Code while sending. The queued DevDash turn was cancelled; wait for that conversation to finish before retrying.')
        }
        if (stopped || closing) await stopOwned(runId)
        while (!closing) {
          const data = await allItems(cursor)
          const items = data.items.filter((i) => i.runId === runId)
          await transcribe(items)
          thread = data.thread
          const run = data.recentRuns.find((r) => r.runId === runId)
          if (run && terminal.has(run.status)) {
            settled = true
            if (run.status === 'failed' || run.status === 'rolled_back') throw new Error('T3 Code could not complete this turn. Open the conversation in T3 Code for details.')
            return { stopReason: stopped || run.status !== 'completed' ? 'cancelled' : 'end_turn' }
          }
          if (Date.now() >= deadline) {
            await stopOwned(runId)
            settled = true
            throw new Error('T3 Code reached the turn time limit and the DevDash-started run was stopped.')
          }
          const pending = thread.status === 'waiting' && (thread.pendingRequestCount ?? 0) > 0
          if (pending !== waiting) {
            waiting = pending
            update({ sessionUpdate: 'session_info_update', _meta: { 'devdash/t3-status': { status: pending ? 'waiting' : 'working' } } })
            if (pending) update({ sessionUpdate: 'agent_message_chunk', messageId: `waiting-${runId}-${++waits}`, content: { type: 'text', text: `\nT3 Code needs an answer. Continue in T3 Code${thread.link ? `: ${thread.link}` : '.'}\n` } })
          }
          // Completed older items need not be paged again. Keep the newest item and any unfinished items because
          // their positions stay fixed while T3 appends streamed text or finishes tool output.
          if (items.length) {
            const unfinished = items.filter((i) => !terminal.has(i.status))
            const keep = unfinished.length ? Math.min(...unfinished.map((i) => i.position)) : Math.max(...items.map((i) => i.position))
            cursor = Math.max(cursor, keep - 1)
          }
          const signature = JSON.stringify([run?.status, items.map((i) => [i.itemId, i.status, i.text, i.updatedAt])])
          interval = signature === previous ? Math.min(interval * 2, 3000) : 250
          previous = signature
          pollWake = new AbortController()
          await delay(Math.min(interval, Math.max(1, deadline - Date.now())), undefined, { signal: pollWake.signal }).catch((err: Error) => { if (err.name !== 'AbortError') throw err })
          pollWake = undefined
        }
        return { stopReason: 'cancelled' }
      } catch (err) {
        if (!settled) {
          try { await stopOwned(runId); settled = true }
          catch { throw new Error('Lost contact with the DevDash-started T3 Code run. Check it in T3 Code before sending again.') }
        }
        throw err
      } finally { if (settled) running = undefined }
    } finally { activePrompt = false; deadlineAt = 0 }
  },
  'session/cancel': async () => {
    stopped = true
    // When a send is still unresolved, its response/reconciliation will identify our run before cancelling it.
    if (running) await stopOwned(running)
    pollWake?.abort()
  },
}
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    let m: { id?: string | number; method?: string; params?: Record<string, unknown> }
    try { m = JSON.parse(line) } catch { return }
    if (!m.method) return
    try {
      if (!handlers[m.method]) throw new Error(`Unsupported T3 Code operation: ${m.method}`)
      const pending = Promise.resolve(handlers[m.method]!(m.params ?? {}))
      if (m.method === 'session/prompt') promptDone = pending
      const result = await pending
      if (m.id !== undefined) send({ id: m.id, result })
    } catch (err) {
      if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: (err as Error).message } })
      else process.stderr.write('T3 Code could not complete the requested operation.\n')
    }
  })()
})
async function close() {
  if (closing) return
  closing = true
  try {
    await handlers['session/cancel']!({})
    await promptDone?.catch(() => {})
  } finally { await client.close() }
  process.exit(0)
}
input.on('close', () => void close())
process.on('SIGTERM', () => void close())
