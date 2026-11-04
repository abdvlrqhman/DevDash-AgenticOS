import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { claudeTool, Rpc, todosOf, toolOutput, Transcriber } from './acp.ts'

test("agents' tools show as the Claude Code tools the web and the guest gate know", () => {
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'bash', kind: 'execute', rawInput: { command: 'ls -la', description: 'List' } }), { name: 'Bash', input: { command: 'ls -la', description: 'List' } })
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'read', rawInput: { filePath: '/srv/x.ts', offset: 10, limit: 5 } }), { name: 'Read', input: { file_path: '/srv/x.ts', offset: 10, limit: 5 } })
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'edit', rawInput: { filePath: '/srv/x.ts', oldString: 'a', newString: 'b' } }),
    { name: 'Edit', input: { file_path: '/srv/x.ts', old_string: 'a', new_string: 'b' } })
  // An edit known only from its diff (another agent's naming), and Gemini's tool names.
  assert.deepEqual(claudeTool({ toolCallId: 'a', kind: 'edit', content: [{ type: 'diff', path: '/srv/y.ts', oldText: 'x', newText: 'y' }] }),
    { name: 'Edit', input: { file_path: '/srv/y.ts', old_string: 'x', new_string: 'y' } })
  assert.equal(claudeTool({ toolCallId: 'a', name: 'run_shell_command', rawInput: { command: 'npm test' } }).name, 'Bash')
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'grep', rawInput: { pattern: 'TODO', path: '/srv', include: '*.ts' } }), { name: 'Grep', input: { pattern: 'TODO', path: '/srv', glob: '*.ts' } })
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'todowrite', rawInput: { todos: [{ content: 'Ship', status: 'in_progress', priority: 'high' }] } }),
    { name: 'TodoWrite', input: { todos: [{ content: 'Ship', status: 'in_progress', activeForm: 'Ship' }] } })
  // MCP tools: DevDash's own are named as Claude Code names its plugin's, so the net_ tools stay tailnet-gated.
  assert.equal(claudeTool({ toolCallId: 'a', name: 'devdash_net_devices' }, ['devdash', 'ida']).name, 'mcp__plugin_devdash_devdash__net_devices')
  assert.equal(claudeTool({ toolCallId: 'a', name: 'ida_decompile', rawInput: { addr: 1 } }, ['devdash', 'ida']).name, 'mcp__ida__decompile')
  // Unknown: its own name and input.
  assert.deepEqual(claudeTool({ toolCallId: 'a', name: 'lsp_hover', rawInput: { file: 'x' } }), { name: 'lsp_hover', input: { file: 'x' } })
  assert.deepEqual(todosOf([{ description: 'A', status: 'done' }, { nope: 1 }]), [{ content: 'A', status: 'completed', activeForm: 'A' }])
})

test('tool output: text content, else what was edited, else the raw output; huge output is cut', () => {
  assert.equal(toolOutput({ toolCallId: 'a', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] }), 'hi')
  assert.equal(toolOutput({ toolCallId: 'a', content: [{ type: 'diff', path: '/x', newText: 'y' }] }), 'Edited /x')
  assert.equal(toolOutput({ toolCallId: 'a', rawOutput: { output: 'done', metadata: {} } }), 'done')
  assert.match(toolOutput({ toolCallId: 'a', rawOutput: 'x'.repeat(70_000) }), /cut: 70,000 characters/)
})

test('a turn of ACP updates becomes the messages Claude Code would send', () => {
  const out: { msg: Record<string, unknown>; live?: boolean }[] = []
  const t = new Transcriber((msg, live) => out.push({ msg, live }), { model: () => 'anthropic/claude-sonnet-4-5', mcpServers: ['devdash'], sessionId: 'ses_1' })
  t.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me look.' } })
  t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking ' } })
  t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the files.' } })
  // A tool call without its input yet waits; its update brings the input, then the result.
  t.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'bash', kind: 'execute', status: 'pending', title: 'bash', rawInput: { cwd: '/x' } })
  t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', rawInput: { command: 'ls' } })
  t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.ts' } }] })
  t.update({ sessionUpdate: 'plan', entries: [{ content: 'Fix it', status: 'pending', priority: 'high' }] })
  t.update({ sessionUpdate: 'tool_call', toolCallId: 'c2', name: 'read', status: 'in_progress', rawInput: { filePath: '/a.ts' } })
  t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
  t.end({ stopReason: 'end_turn', durationMs: 1200, costUsd: 0.02, usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50 }, fresh: true })

  const kept = out.filter((o) => !o.live).map((o) => o.msg)
  const live = out.filter((o) => o.live).map((o) => o.msg)
  assert.equal(live.length, 3) // the text deltas
  assert.deepEqual(live[0], { type: 'stream_event', parent_tool_use_id: null, session_id: 'ses_1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking ' } } })
  const content = (m: Record<string, unknown>) => (m.message as { content: Record<string, unknown>[] } | undefined)?.content as Record<string, unknown>[]
  assert.deepEqual(kept.map((m) => [m.type, content(m)?.map((c) => c.type)]), [
    ['assistant', ['thinking', 'text']],
    ['assistant', ['tool_use']], ['user', ['tool_result']],
    ['assistant', ['tool_use']], ['user', ['tool_result']], // the plan, as TodoWrite
    ['assistant', ['tool_use']], // the read, still running at the end of the turn...
    ['assistant', ['text']],
    ['user', ['tool_result']], // ...is closed
    ['result', undefined],
  ])
  assert.deepEqual(content(kept[0]!), [{ type: 'thinking', thinking: 'Let me look.' }, { type: 'text', text: 'Checking the files.' }])
  assert.deepEqual(content(kept[1]!)[0], { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } })
  assert.deepEqual(content(kept[2]!)[0], { type: 'tool_result', tool_use_id: 'c1', content: 'a.ts', is_error: false })
  assert.equal((content(kept[3]!)[0]!.input as { todos: unknown[] }).todos.length, 1)
  assert.equal((kept[0]!.message as { model?: string }).model, 'anthropic/claude-sonnet-4-5')
  const r = kept.at(-1)!
  assert.equal(r.subtype, 'success')
  assert.equal(r.result, 'Done.')
  assert.equal(r.total_cost_usd, 0.02)
  assert.equal(r.num_turns, 2)
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 })
  assert.equal(r.devdash_fresh, true)
})

test('a stopped turn reads as stopped, not as an error; a refusal is an error', () => {
  const out: Record<string, unknown>[] = []
  const t = new Transcriber((m, live) => { if (!live) out.push(m) }, { model: () => null, mcpServers: [], sessionId: 's' })
  t.end({ stopReason: 'cancelled', durationMs: 5, costUsd: null, fresh: false })
  assert.equal(out[0]!.terminal_reason, 'aborted_by_user')
  assert.equal(out[0]!.is_error, false)
  assert.equal('total_cost_usd' in out[0]!, false) // unknown cost stays unknown
  t.end({ stopReason: 'refusal', durationMs: 5, costUsd: null, fresh: false })
  assert.equal(out[1]!.is_error, true)
})

test('the JSON-RPC connection: requests get their answers, the agent asks and is answered, logs are ignored', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess
  const notes: string[] = []
  const rpc = new Rpc(child, {
    notify: (m) => notes.push(m),
    request: async (m, p) => (m === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: String(p.pick) } } : Promise.reject(new Error('no'))),
  })
  const sent: Record<string, unknown>[] = []
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => sent.push(JSON.parse(l))))
  const answer = rpc.request<{ sessionId: string }>('session/new', { cwd: '/x', mcpServers: [] })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/x', mcpServers: [] } })
  stdout.write('opencode: some log line\n')
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })}\n`)
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 'ses_9' } })}\n`)
  assert.deepEqual(await answer, { sessionId: 'ses_9' })
  assert.deepEqual(notes, ['session/update'])
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { pick: 'allow-once' } })}\n`)
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'p2', method: 'fs/read_text_file', params: {} })}\n`)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 'p1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  assert.equal((sent[2]!.error as { message: string }).message, 'no')
  // The process going away fails what's still waiting.
  const late = rpc.request('session/prompt', {})
  ;(child as unknown as EventEmitter).emit('exit')
  await assert.rejects(late, /stopped/)
})
