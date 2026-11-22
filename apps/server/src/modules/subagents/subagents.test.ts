import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type Db } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService } from '../claude/service.ts'
import { subagentsService } from './service.ts'

const user = (id: number, username: string, name: string): User => ({
  id,
  email: `${username}@x.io`,
  username,
  name,
  role: id === 1 ? 'admin' : 'member',
})

function setup(existingDb?: Db) {
  const db = existingDb ?? openDb(':memory:')
  if (!existingDb) {
    const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
    add.run(1, 'ann@x.io', 'ann', 'Ann Lee', 'admin')
    add.run(2, 'bob@x.io', 'bob', 'Bob Ray', 'member')
  }

  const hub = createHub()
  const rpcs = new Map<string, (username: string, params: unknown) => unknown>()
  const eventListeners: Array<(username: string, ev: Record<string, unknown>) => void> = []
  const agents = {
    onRpc(method: string, fn: (username: string, params: unknown) => unknown) { rpcs.set(method, fn) },
    onEvent(fn: (username: string, ev: Record<string, unknown>) => void) { eventListeners.push(fn) },
  } as unknown as AgentsService

  const preambles: Array<(session: Record<string, unknown>, ctx: { role: boolean }) => Array<{ type: string; text: string }>> = []
  const msgListeners: Array<(sessionId: string, msg: Record<string, unknown>) => void> = []
  const promptListeners: Array<(session: { id: string }, req: { toolName: string; input?: Record<string, unknown> }) => void> = []
  const turnEndListeners: Array<(t: { session: { id: string }; ok: boolean; aborted?: boolean; result?: string | null; costUsd?: number }) => void> = []

  let nextSes = 1
  const createdSessions: Array<{ id: string; user: User; opts: Record<string, unknown>; meta?: Record<string, unknown> }> = []
  const sentMessages: Array<{ sessionId: string; text: string }> = []
  const interrupted: string[] = []
  const transcripts = new Map<string, Array<{ type?: string; message?: { content?: unknown } }>>()

  const claude = {
    addPreamble(fn: (session: Record<string, unknown>, ctx: { role: boolean }) => Array<{ type: string; text: string }>) {
      preambles.push(fn)
    },
    onMessage(fn: (sessionId: string, msg: Record<string, unknown>) => void) { msgListeners.push(fn) },
    onPrompt(fn: (session: { id: string }, req: { toolName: string; input?: Record<string, unknown> }) => void) { promptListeners.push(fn) },
    onTurnEnd(fn: (t: { session: { id: string }; ok: boolean; aborted?: boolean; result?: string | null; costUsd?: number }) => void) { turnEndListeners.push(fn) },
    defaults() {
      return { harness: 't3code', profile: 'default', model: 'codex/gpt-6.2-sol', effort: 'high', permission_mode: 'bypassPermissions' }
    },
    async commands(_u: User, _profile: string, harness: string) {
      if (harness === 't3code') {
        return {
          commands: [],
          models: [
            { value: 'antigravity/gemini-4-neon', displayName: 'Gemini 4 Neon', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
            { value: 'codex/gpt-6.2-sol', displayName: 'gpt-6.2-sol', supportedEffortLevels: ['low', 'medium', 'high'] },
          ],
        }
      }
      return { commands: [], models: [] }
    },
    async create(u: User, opts: Record<string, unknown>, meta?: Record<string, unknown>) {
      const id = `ses-sub-${nextSes++}`
      db.prepare("insert into claude_sessions (id, owner_id, title, cwd, harness, profile, status, listed) values (?, ?, ?, ?, ?, ?, 'working', ?)")
        .run(id, u.id, String(opts.title ?? 'Subagent'), String(opts.cwd ?? ''), String(opts.harness ?? 'claude'), String(opts.profile ?? 'default'), meta?.listed === false ? 0 : 1)
      createdSessions.push({ id, user: u, opts, meta })
      return { id, title: String(opts.title ?? 'Subagent') }
    },
    async send(_u: User, sessionId: string, text: string) {
      sentMessages.push({ sessionId, text })
    },
    async interrupt(_u: User, sessionId: string) {
      interrupted.push(sessionId)
    },
    async transcript(sessionId: string) {
      return transcripts.get(sessionId) ?? []
    },
  } as unknown as ClaudeService

  const notifications: Array<{ userId: number; title: string; body: string }> = []
  const service = subagentsService({
    db,
    hub,
    agents,
    claude,
    notify: (userId, _kind, payload) => { notifications.push({ userId, title: payload.title, body: payload.body ?? '' }) },
  })
  service.registerMcp()

  return {
    db, service, rpcs, preambles, createdSessions, sentMessages, interrupted, transcripts, notifications,
    emitMsg(sessionId: string, msg: Record<string, unknown>) { for (const fn of msgListeners) fn(sessionId, msg) },
    emitPrompt(sessionId: string, info: { toolName: string; input?: Record<string, unknown> }) { for (const fn of promptListeners) fn({ id: sessionId }, info) },
    emitTurnEnd(sessionId: string, info: { ok?: boolean; aborted?: boolean; result?: string | null; costUsd?: number } = {}) { for (const fn of turnEndListeners) fn({ session: { id: sessionId }, ok: info.ok ?? true, aborted: info.aborted, result: info.result, costUsd: info.costUsd }) },
    emitAgentEvent(username: string, ev: Record<string, unknown>) { for (const fn of eventListeners) fn(username, ev) },
  }
}

test('CRUD, slug normalization, templates, and strict member isolation', async () => {
  const { service } = setup()
  const ann = user(1, 'ann', 'Ann Lee')
  const bob = user(2, 'bob', 'Bob Ray')

  const empty = service.overview(ann)
  assert.equal(empty.subagents.length, 0)
  assert.ok(empty.templates.length >= 4)

  const created = await service.create(ann, {
    name: 'Web Search',
    description: 'Searches the live web and summarizes citations.',
    instructions: 'Search the web thoroughly and return links.',
    icon: 'globe',
    color: 'cyan',
    scope: 'both',
  })
  assert.equal(created.slug, 'web-search')
  assert.equal(created.enabled, true)

  // Duplicate slug for same user fails
  await assert.rejects(() => service.create(ann, {
    name: 'Web Search',
    instructions: 'Another web searcher.',
  }), /duplicate_slug|already have a subagent/)

  // Different member can use the same slug independently
  const bobCopy = await service.create(bob, {
    name: 'Web Search',
    instructions: 'Bob personal web searcher.',
  })
  assert.equal(bobCopy.slug, 'web-search')
  assert.equal(service.overview(bob).subagents.length, 1)
  assert.equal(service.overview(ann).subagents.length, 1)

  // Bob cannot modify or delete Ann's subagent
  await assert.rejects(() => service.update(bob, created.id, { name: 'Hacked' }), /not found/i)
  assert.throws(() => service.remove(bob, created.id), /not found/i)

  const updated = await service.update(ann, created.id, { description: 'Updated desc', scope: 'hamasa' })
  assert.equal(updated.description, 'Updated desc')
  assert.equal(updated.scope, 'hamasa')

  service.remove(ann, created.id)
  assert.equal(service.overview(ann).subagents.length, 0)
})

test('preamble injection respects scope, enabled flag, team roles, and prevents recursion', async () => {
  const { db, service, preambles } = setup()
  const ann = user(1, 'ann', 'Ann Lee')

  await service.create(ann, { name: 'Web Search', slug: 'web-search', instructions: 'Search web', scope: 'both' })
  await service.create(ann, { name: 'Hamasa Helper', slug: 'hamasa-only', instructions: 'Only Hamasa', scope: 'hamasa' })
  await service.create(ann, { name: 'Code Finder', slug: 'code-only', instructions: 'Only sessions', scope: 'sessions' })
  await service.create(ann, { name: 'Off Agent', slug: 'off-agent', instructions: 'Disabled', scope: 'both', enabled: false })

  assert.equal(preambles.length, 1)
  const runPreamble = preambles[0]!

  // Hamasa session sees both + hamasa (not sessions-only or disabled)
  const hamasaOut = runPreamble({ id: 'ham-1', owner_id: 1, origin_kind: 'assistant' }, { role: false })
  assert.equal(hamasaOut.length, 1)
  assert.match(hamasaOut[0]!.text, /web-search/)
  assert.match(hamasaOut[0]!.text, /hamasa-only/)
  assert.doesNotMatch(hamasaOut[0]!.text, /code-only/)
  assert.doesNotMatch(hamasaOut[0]!.text, /off-agent/)

  // Normal session sees both + sessions (not hamasa-only or disabled)
  const normalOut = runPreamble({ id: 'ses-1', owner_id: 1, origin_kind: null }, { role: false })
  assert.equal(normalOut.length, 1)
  assert.match(normalOut[0]!.text, /web-search/)
  assert.match(normalOut[0]!.text, /code-only/)
  assert.doesNotMatch(normalOut[0]!.text, /hamasa-only/)

  // Team role session gets no personal subagents
  assert.deepEqual(runPreamble({ id: 'role-1', owner_id: 1, origin_kind: null }, { role: true }), [])

  // Subagent session itself gets no preamble (anti-recursion)
  const webSa = service.overview(ann).subagents.find((s) => s.slug === 'web-search')!
  const run = await service.runManual(ann, webSa.id, { task: 'Find latest Node LTS' })
  assert.ok(run.sessionId)
  assert.deepEqual(runPreamble({ id: run.sessionId, owner_id: 1, origin_kind: null }, { role: false }), [])
  // Also ensure db row exists
  const row = db.prepare('select id from subagent_runs where id = ?').get(run.id)
  assert.ok(row)
})

test('live activity stream tracking, waiting prompt, turn completion, follow-up, stop, and history', async () => {
  const { service, createdSessions, sentMessages, interrupted, transcripts, emitMsg, emitPrompt, emitTurnEnd } = setup()
  const ann = user(1, 'ann', 'Ann Lee')
  const bob = user(2, 'bob', 'Bob Ray')

  const sa = await service.create(ann, {
    name: 'Code Search',
    slug: 'code-search',
    instructions: 'Find code fast.',
    icon: 'file-search',
    color: 'blue',
  })

  const run = await service.runManual(ann, sa.id, { task: 'Where is createHub defined?' })
  assert.equal(run.status, 'running')
  assert.equal(createdSessions.length, 1)
  assert.equal(createdSessions[0]!.meta?.listed, false)
  const sid = run.sessionId!

  // Member isolation on runs
  assert.throws(() => service.getRun(bob, run.id), /not found/i)
  await assert.rejects(() => service.stopRun(bob, run.id), /not found/i)

  // Live tool activity updates
  emitMsg(sid, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'createHub' } }] },
  })
  let cur = service.getRun(ann, run.id)
  assert.match(cur.activity, /Searching: createHub/)
  assert.ok(cur.steps.some((s) => s.label.includes('createHub')))

  // Permission prompt moves run to waiting
  emitPrompt(sid, { toolName: 'Bash', input: { command: 'rg createHub' } })
  cur = service.getRun(ann, run.id)
  assert.equal(cur.status, 'waiting')
  assert.match(cur.activity, /Needs permission: Bash/)

  // Turn completes and extracts assistant result from transcript
  transcripts.set(sid, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Found `createHub` in `apps/server/src/core/hub.ts:10`.' }] } },
  ])
  emitTurnEnd(sid, { costUsd: 0.0123 })
  // Wait microtask for async transcript fetch in onTurnEnd
  await new Promise((r) => setTimeout(r, 20))
  cur = service.getRun(ann, run.id)
  assert.equal(cur.status, 'completed')
  assert.match(cur.result ?? '', /core\/hub\.ts:10/)
  assert.equal(cur.costUsd, 0.0123)

  // Follow-up reopens run and sends to underlying session
  const reopened = await service.sendToRun(ann, run.id, 'Also check callers of createHub')
  assert.equal(reopened.status, 'running')
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0]!.sessionId, sid)

  // Stop interrupts underlying session and marks run stopped
  const stopped = await service.stopRun(ann, run.id)
  assert.equal(stopped.status, 'stopped')
  assert.deepEqual(interrupted, [sid])

  // Clear finished removes stopped run from history
  service.clearHistory(ann, sa.id)
  assert.equal(service.runs(ann, { subagentId: sa.id }).length, 0)
})

test('MCP tools support Hamasa and normal sessions, sync & async runs, scope checks, and block recursion', async () => {
  const { db, service, rpcs, transcripts, emitTurnEnd } = setup()
  const ann = user(1, 'ann', 'Ann Lee')

  await service.create(ann, { name: 'Web Search', slug: 'web-search', instructions: 'Search the web', scope: 'both' })
  await service.create(ann, { name: 'Hamasa Research', slug: 'hamasa-research', instructions: 'Research for Hamasa', scope: 'hamasa' })

  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, harness, profile, status, origin_kind) values ('ham-ses', 1, 'Hamasa', '', 'claude', 'default', 'working', 'assistant')").run()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, harness, profile, status, origin_kind) values ('norm-ses', 1, 'Normal', '', 'claude', 'default', 'working', null)").run()

  // Availability check
  const hereHamasa = rpcs.get('mcp.subagents_here')!('ann', { sessionId: 'ham-ses', args: {} }) as { available: boolean }
  assert.equal(hereHamasa.available, true)

  // Normal session sees web-search but NOT hamasa-research
  const normalList = rpcs.get('mcp.subagents_list')!('ann', { sessionId: 'norm-ses', args: {} }) as { subagents: Array<{ slug: string }> }
  assert.deepEqual(normalList.subagents.map((s) => s.slug), ['web-search'])

  // Normal session cannot run hamasa-only subagent
  await assert.rejects(
    () => Promise.resolve(rpcs.get('mcp.subagent_run')!('ann', { sessionId: 'norm-ses', args: { subagent: 'hamasa-research', task: 'Hi', wait: false } })),
    /configured for Hamasa only/i,
  )

  // Async background run from Hamasa
  const asyncRes = await rpcs.get('mcp.subagent_run')!('ann', {
    sessionId: 'ham-ses',
    args: { subagent: 'hamasa-research', task: 'Research AI agents', wait: false },
  }) as { runId: number; status: string }
  assert.equal(asyncRes.status, 'running')
  const bgRun = service.getRun(ann, asyncRes.runId)
  assert.equal(bgRun.callerKind, 'hamasa')

  // Inside the subagent's own session, subagents_here is false and subagent_run is rejected (anti-recursion)
  const hereChild = rpcs.get('mcp.subagents_here')!('ann', { sessionId: bgRun.sessionId, args: {} }) as { available: boolean }
  assert.equal(hereChild.available, false)
  await assert.rejects(
    () => Promise.resolve(rpcs.get('mcp.subagent_run')!('ann', { sessionId: bgRun.sessionId, args: { subagent: 'web-search', task: 'Loop', wait: false } })),
    /cannot spawn other subagents/i,
  )

  // Sync run waits until turn completes and returns final result
  const syncPromise = Promise.resolve(rpcs.get('mcp.subagent_run')!('ann', {
    sessionId: 'norm-ses',
    args: { subagent: 'web-search', task: 'Check latest TS version', wait: true, timeout_sec: 10 },
  }))
  await new Promise((r) => setTimeout(r, 15))
  const active = service.overview(ann).activeRuns.find((r) => r.subagentSlug === 'web-search')!
  transcripts.set(active.sessionId!, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'TypeScript 5.8 is the latest stable release.' }] } },
  ])
  emitTurnEnd(active.sessionId!, { costUsd: 0.004 })

  const syncRes = await syncPromise as { status: string; result: string | null }
  assert.equal(syncRes.status, 'completed')
  assert.match(syncRes.result ?? '', /TypeScript 5\.8/)

  // Stop the background run via MCP
  const stopped = await rpcs.get('mcp.subagent_stop')!('ann', { sessionId: 'ham-ses', args: { run_id: asyncRes.runId } }) as { status: string }
  assert.equal(stopped.status, 'stopped')
})

test('reconciles orphaned active runs after server restart', async () => {
  const first = setup()
  const ann = user(1, 'ann', 'Ann Lee')
  const sa = await first.service.create(ann, { name: 'Searcher', slug: 'searcher', instructions: 'Search' })
  const run = await first.service.runManual(ann, sa.id, { task: 'In-flight before restart' })
  // Simulate session ending while server was down
  first.db.prepare("update claude_sessions set status = 'idle' where id = ?").run(run.sessionId)

  // Re-initialize service on same DB (simulating server restart)
  const second = setup(first.db)
  const after = second.service.getRun(ann, run.id)
  assert.equal(after.status, 'stopped')
  assert.match(after.activity, /restart/i)
})

test('subagent defaults decouple subagents from the main frontier model and record resolved model on runs', async () => {
  const { service, createdSessions } = setup()
  const ann = user(1, 'ann', 'Ann Lee')

  const searcher = await service.create(ann, {
    name: 'Code Search',
    slug: 'code-search',
    instructions: 'Search codebase fast',
  })
  const reviewer = await service.create(ann, {
    name: 'Deep Reviewer',
    slug: 'deep-reviewer',
    instructions: 'Audit carefully',
    harness: 'claude',
    model: 'sonnet',
  })

  // Before setting subagent defaults, inherits main frontier default
  const runFrontier = await service.runManual(ann, searcher.id, { task: 'Find auth routes' })
  assert.equal(runFrontier.harness, 't3code')
  assert.equal(runFrontier.model, 'codex/gpt-6.2-sol')
  assert.equal(runFrontier.effort, 'high')
  assert.equal(createdSessions.at(-1)!.opts.model, 'codex/gpt-6.2-sol')

  // Save a fast & smart default subagent model (Gemini 4 Neon · low)
  const saved = await service.saveDefaults(ann, {
    harness: 't3code',
    model: 'antigravity/gemini-4-neon',
    effort: 'low',
  })
  assert.equal(saved.harness, 't3code')
  assert.equal(saved.model, 'antigravity/gemini-4-neon')
  assert.equal(saved.effort, 'low')
  assert.equal(service.overview(ann).defaults.model, 'antigravity/gemini-4-neon')
  assert.equal(service.claudeSubagentModel(ann.id), null)

  // Searcher now runs on the fast subagent default instead of the frontier model
  const runFast = await service.runManual(ann, searcher.id, { task: 'Find all routes' })
  assert.equal(runFast.harness, 't3code')
  assert.equal(runFast.model, 'antigravity/gemini-4-neon')
  assert.equal(runFast.effort, 'low')
  assert.equal(createdSessions.at(-1)!.opts.model, 'antigravity/gemini-4-neon')
  assert.equal(createdSessions.at(-1)!.opts.effort, 'low')

  // Per-subagent override still wins over subagent defaults
  const runOverride = await service.runManual(ann, reviewer.id, { task: 'Review PR' })
  assert.equal(runOverride.harness, 'claude')
  assert.equal(runOverride.model, 'sonnet')
  assert.equal(runOverride.effort, null)

  // Claude subagent default exposes CLAUDE_CODE_SUBAGENT_MODEL
  await service.saveDefaults(ann, { harness: 'claude', model: 'haiku' })
  assert.equal(service.claudeSubagentModel(ann.id), 'haiku')

  // Resetting clears subagent defaults
  const cleared = await service.saveDefaults(ann, { harness: null })
  assert.equal(cleared.harness, null)
  assert.equal(cleared.model, null)
  assert.equal(service.claudeSubagentModel(ann.id), null)
})

test('deduplicates repeated activity steps and reopens a finished run on native chat follow-up', async () => {
  const { service, emitMsg, emitAgentEvent, emitTurnEnd, transcripts } = setup()
  const ann = user(1, 'ann', 'Ann Lee')
  const sa = await service.create(ann, { name: 'Code Search', slug: 'code-search', instructions: 'Search' })
  const run = await service.runManual(ann, sa.id, { task: 'Survey files' })

  // Duplicate tool_use events with short arg hint should collapse and not repeat detail
  emitMsg(run.sessionId!, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'T3 Code', input: { title: 'Ran command' } }] },
  })
  emitMsg(run.sessionId!, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'T3 Code', input: { title: 'Ran command' } }] },
  })

  const mid = service.getRun(ann, run.id)
  const toolSteps = mid.steps.filter((s) => s.kind === 'tool')
  assert.equal(toolSteps.length, 1)
  assert.equal(toolSteps[0]!.label, 'T3 Code: Ran command')
  assert.equal(toolSteps[0]!.detail, undefined)

  // Finish the first turn
  transcripts.set(run.sessionId!, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'First answer.' }] } },
  ])
  emitTurnEnd(run.sessionId!, { costUsd: 0.001 })
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(service.getRun(ann, run.id).status, 'completed')

  // User sends a follow-up directly in SessionView (fires claude.status working)
  emitAgentEvent('ann', { ev: 'claude.status', id: run.sessionId!, status: 'working' })
  const reopened = service.getRun(ann, run.id)
  assert.equal(reopened.status, 'running')

  // Follow-up turn completes and updates stored result
  transcripts.set(run.sessionId!, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Follow-up answer.' }] } },
  ])
  emitTurnEnd(run.sessionId!, { costUsd: 0.002 })
  await new Promise((r) => setTimeout(r, 15))
  const finished = service.getRun(ann, run.id)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.result, 'Follow-up answer.')
})
