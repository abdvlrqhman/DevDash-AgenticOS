import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeSubagent, subagentIdFor } from './claude.ts'

test('subagentIdFor finds the subagent whose meta.toolUseId matches the Task tool_use', () => {
  const metas = [
    { agentId: 'a111', meta: { agentType: 'Explore', description: 'look around', toolUseId: 'toolu_A' } },
    { agentId: 'b222', meta: { agentType: 'Plan', description: 'design it', toolUseId: 'toolu_B' } },
  ]
  assert.equal(subagentIdFor(metas, 'toolu_B'), 'b222')
  assert.equal(subagentIdFor(metas, 'toolu_A'), 'a111')
  assert.equal(subagentIdFor(metas, 'toolu_missing'), null) // not spawned yet, or not ours
  assert.equal(subagentIdFor([], 'toolu_A'), null)
})

test('shapeSubagent keeps only user/assistant messages, parent_tool_use_id null, timestamps kept', () => {
  // The real on-disk shape: a string task prompt, Claude Code `attachment` bookkeeping lines, an assistant turn with a
  // tool_use, and a user turn carrying its tool_result. Everything has isSidechain + parentUuid, no parent_tool_use_id.
  const lines = [
    { type: 'user', uuid: 'u0', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'Explore the repo' }, timestamp: 't0' },
    { type: 'attachment', uuid: 'att1', parentUuid: 'u0', isSidechain: true },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u0', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: {} }] }, timestamp: 't1' },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'found it' }] }, timestamp: 't2' },
    { type: 'system', uuid: 's1', subtype: 'something' }, // dropped
    { type: 'assistant', uuid: 'a2', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: 't3' },
  ]
  const out = shapeSubagent(lines)
  assert.deepEqual(out.map((m) => m.uuid), ['u0', 'a1', 'u1', 'a2']) // attachment and system lines gone, order kept
  assert.ok(out.every((m) => m.parent_tool_use_id === null)) // the subagent's own thread is the top level here
  assert.deepEqual(out.map((m) => m.timestamp), ['t0', 't1', 't2', 't3']) // timestamps preserved for the web
  assert.deepEqual((out[0]!.message as { content: unknown }).content, 'Explore the repo') // the tool call/result shape is untouched
})

test('shapeSubagent drops lines with no message or no uuid', () => {
  const lines = [
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
    { type: 'assistant', message: { role: 'assistant', content: [] } }, // no uuid
    { type: 'user', uuid: 'u1' }, // no message
  ]
  assert.deepEqual(shapeSubagent(lines).map((m) => m.uuid), ['a1'])
})
