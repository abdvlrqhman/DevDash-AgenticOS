import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHistory, pageOf, type HistoryMessage } from './claude.ts'

const prompt = (uuid: string): HistoryMessage => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'do it' }] } })
const reply = (uuid: string): HistoryMessage => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } })
const toolResult = (uuid: string): HistoryMessage => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })

// Raw `.jsonl` lines use `parentUuid`, not `parent_tool_use_id`; recovered lines should come out with it set to null.
const rawPrompt = (uuid: string, text = 'old') => ({ type: 'user', uuid, parentUuid: 'p', message: { content: [{ type: 'text', text }] }, timestamp: `t-${uuid}` })
const rawReply = (uuid: string) => ({ type: 'assistant', uuid, parentUuid: 'p', message: { content: [{ type: 'text', text: 'old ok' }] }, timestamp: `t-${uuid}` })
const boundary = (uuid: string) => ({ type: 'system', subtype: 'compact_boundary', uuid, content: 'Conversation compacted', timestamp: `t-${uuid}` })
const summary = (uuid: string) => ({ type: 'user', uuid, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued…' } })
const sidechain = (uuid: string) => ({ type: 'assistant', uuid, isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } })

test('history pages hold whole turns: the last N prompts and what followed, then the N before them', () => {
  // 3 turns: p1 r1 | p2 r2 t2 r2b | p3 r3
  const all = [prompt('p1'), reply('r1'), prompt('p2'), reply('r2'), toolResult('t2'), reply('r2b'), prompt('p3'), reply('r3')]
  assert.deepEqual(pageOf(all, { turns: 2 }), { start: 2, end: 8 }) // p2 … r3: a tool result is not a prompt
  assert.deepEqual(pageOf(all, { turns: 2, before: 'p2' }), { start: 0, end: 2 }) // only p1 r1 left
  assert.deepEqual(pageOf(all, { turns: 10 }), { start: 0, end: 8 })
  assert.deepEqual(pageOf(all, {}), { start: 0, end: 8 }) // no turns: everything (the journal reads it all)
  assert.deepEqual(pageOf(all, { turns: 1, before: 'gone' }), { start: 6, end: 8 }) // an unknown id: the latest page
})

test('mergeHistory prepends the pre-compaction turns the SDK dropped, boundary kept, summary and sidechains out', () => {
  // On disk: two old turns, a subagent line, the compaction boundary + summary, then the two live turns.
  const raw = [
    rawPrompt('o1'), rawReply('o1r'), sidechain('sc1'), rawPrompt('o2'), rawReply('o2r'),
    boundary('cb'), summary('sum'), rawPrompt('n1'), rawReply('n1r'),
  ]
  // getSessionMessages only returns the live thread (from after the compaction).
  const active = [prompt('n1'), reply('n1r')]
  const merged = mergeHistory(active, raw)
  assert.deepEqual(merged.map((m) => m.uuid), ['o1', 'o1r', 'o2', 'o2r', 'cb', 'n1', 'n1r']) // order kept, sidechain + summary gone
  assert.equal(merged.find((m) => m.uuid === 'cb')?.type, 'system') // the "Conversation compacted" note stays
  assert.ok(merged.slice(0, 5).every((m) => m.parent_tool_use_id === null)) // recovered lines get parent_tool_use_id, not parentUuid
  assert.deepEqual(merged.slice(5), active) // the live thread is passed through untouched
})

test('mergeHistory leaves a session that never compacted exactly as the SDK gave it', () => {
  // The active thread already starts at the first line: nothing older to prepend.
  const raw = [rawPrompt('a1'), rawReply('a1r'), rawPrompt('a2'), rawReply('a2r')]
  const active = [prompt('a1'), reply('a1r'), prompt('a2'), reply('a2r')]
  assert.deepEqual(mergeHistory(active, raw), active)
})

test('mergeHistory de-dupes by uuid so a line in both sources is not doubled', () => {
  const raw = [rawPrompt('o1'), rawPrompt('o1'), rawReply('o1r'), rawPrompt('n1')] // 'o1' repeated on disk
  const active = [prompt('n1')]
  assert.deepEqual(mergeHistory(active, raw).map((m) => m.uuid), ['o1', 'o1r', 'n1'])
})

test('mergeHistory keeps the active thread when none of it is on disk yet', () => {
  assert.deepEqual(mergeHistory([prompt('live')], [rawPrompt('o1')]), [prompt('live')])
})
