import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, mergePage, mergeRaw, touchedFiles, type Raw } from './transcript.ts'

const msgs: Raw[] = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the login crash' } },
  { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'look at auth' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'search' } }] } },
  { type: 'assistant', uuid: 'a2', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'refresh' } }] } },
  { type: 'user', uuid: 'u2', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'auth.dart:42' }] } },
  { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found it' }], is_error: false }] } },
  { type: 'user', uuid: 'u4', message: { content: '<command-name>/compact</command-name>' } },
  { type: 'user', uuid: 'u5', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } },
  { type: 'result', uuid: 'r1', subtype: 'success', duration_ms: 4200, total_cost_usd: 0.03 },
]

test('builds user, thinking, text, nested tool calls with results, commands and the result footer', () => {
  const b = buildTranscript(msgs)
  assert.deepEqual(b.map((x) => x.kind), ['user', 'thinking', 'text', 'tool', 'command', 'result'])
  const task = b[3]!
  assert.ok(task.kind === 'tool')
  assert.equal(task.result?.text, 'found it')
  assert.equal(task.children.length, 1, 'subagent step nests under the Task call')
  const grep = task.children[0]!
  assert.ok(grep.kind === 'tool' && grep.result?.text === 'auth.dart:42')
  const cmd = b[4]!
  assert.ok(cmd.kind === 'command' && cmd.name === '/compact' && cmd.output === 'Compacted')
  const res = b[5]!
  assert.ok(res.kind === 'result' && res.ok && res.seconds === 4)
})

test('merging live messages skips ones already in the transcript', () => {
  const merged = mergeRaw(msgs.slice(0, 2), [msgs[1]!, msgs[2]!])
  assert.deepEqual(merged.map((m) => m.uuid), ['u1', 'a1', 'a2'])
})

test('a fresh latest page slides: an exchange that dropped out of it stays above, not after the new prompt', () => {
  const turn = (n: number, day: number): Raw[] => [
    { type: 'user', uuid: `p${n}`, timestamp: `2026-10-${day}T10:0${n}:00Z`, message: { role: 'user', content: `prompt ${n}` } },
    { type: 'assistant', uuid: `a${n}`, timestamp: `2026-10-${day}T10:0${n}:30Z`, message: { content: [{ type: 'text', text: `answer ${n}` }] } },
  ]
  // The view had the page p1..p2 (yesterday) and the prompt just sent; a refetch brings the page p2..p3.
  const have = [...turn(1, 11), ...turn(2, 11), ...turn(3, 12), { type: 'assistant', uuid: 'live', timestamp: '2026-10-12T10:09:00Z', message: { content: [] } }]
  const page = [...turn(2, 11), ...turn(3, 12)]
  assert.deepEqual(mergePage(have, page).map((m) => m.uuid), ['p1', 'a1', 'p2', 'a2', 'p3', 'a3', 'live'])
  // Nothing in common: older messages go above by time, newer ones after.
  assert.deepEqual(mergePage(turn(1, 10), page).map((m) => m.uuid), ['p1', 'a1', 'p2', 'a2', 'p3', 'a3'])
  assert.deepEqual(mergePage(turn(4, 13), page).map((m) => m.uuid), ['p2', 'a2', 'p3', 'a3', 'p4', 'a4'])
})

test('images in user messages become data URLs', () => {
  const b = buildTranscript([{ type: 'user', uuid: 'x', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'this' }] } }])
  assert.ok(b[0]!.kind === 'user' && b[0]!.images[0] === 'data:image/png;base64,AAA')
})

test('a note Claude Code adds for the model shows its content: an image inline, text as a preview with the full text on tap', () => {
  const b = buildTranscript([
    // A synthetic note that is only an image: its picture must survive, not be dropped for a bare label.
    { type: 'user', uuid: 'n1', isSynthetic: true, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } }] } },
    // A non-human note with text: the first line labels it, the whole thing stays reachable as detail.
    { type: 'user', uuid: 'n2', origin: { kind: 'hook' }, message: { role: 'user', content: 'Reminder line one\nmore detail here' } },
  ] as never)
  assert.deepEqual(b.map((x) => x.kind), ['event', 'event'])
  const img = b[0]!, txt = b[1]!
  assert.ok(img.kind === 'event' && img.images?.[0] === 'data:image/png;base64,BBB' && img.text === 'Claude Code added an image')
  assert.ok(txt.kind === 'event' && txt.text === 'Reminder line one' && txt.detail === 'Reminder line one\nmore detail here')
})

test('side panel facts: latest to-dos and changed files with line counts, including subagent edits', async () => {
  const { sessionFacts } = await import('./transcript.ts')
  const b = buildTranscript([
    { type: 'assistant', uuid: 'a', message: { content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending' }] } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y\nz' } },
      { type: 'tool_use', id: 't3', name: 'Task', input: {} },
    ] } },
    { type: 'assistant', uuid: 'b', parent_tool_use_id: 't3', message: { content: [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: '/p/b.ts', content: '1\n2\n3' } }] } },
    { type: 'assistant', uuid: 'c', message: { content: [{ type: 'tool_use', id: 't5', name: 'TodoWrite', input: { todos: [{ content: 'new', status: 'completed' }] } }] } },
  ])
  const f = sessionFacts(b)
  assert.equal(f.todos[0]!.content, 'new')
  assert.deepEqual(f.files.map((x) => [x.path, x.added, x.removed]), [['/p/a.ts', 2, 1], ['/p/b.ts', 3, 0]])
})

test('system reminders are not shown as the person\'s words', () => {
  const blocks = buildTranscript([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the build<system-reminder>internal note for the model</system-reminder>' } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '<system-reminder>only a reminder</system-reminder>' } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: '<task-notification><status>completed</status><summary>Background command &quot;gh run watch&quot; completed (exit code 0)</summary></task-notification>' } },
  ] as never)
  assert.deepEqual(blocks.map((b) => b.kind), ['user', 'event'])
  assert.equal((blocks[0] as { text: string }).text, 'fix the build')
  assert.equal((blocks[1] as { text: string }).text, 'Background command "gh run watch" completed (exit code 0)')
})

test('touchedFiles: what Claude worked on, most recent first, from its file tools and the full paths in its commands', () => {
  const raws: Raw[] = [
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/srv/p/docs/A.md', content: 'x' } }] } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: "magick in.png -resize 512 /srv/p/builds/store/1-app-icon-512.png && ls '/srv/p/builds/store'" } }] } },
    { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/srv/p/docs/A.md' } }] } },
  ]
  assert.deepEqual(touchedFiles(buildTranscript(raws)), ['/srv/p/docs/A.md', '/srv/p/builds/store/1-app-icon-512.png'])
})
