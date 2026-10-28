import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, type Raw, type ToolBlock } from './transcript.ts'
import { diff, mcpName, toolFile, toolView } from './tool-view.ts'

const tool = (name: string, input: Record<string, unknown>, result?: string, extra: Partial<ToolBlock['result']> = {}): ToolBlock =>
  ({ kind: 'tool', key: 'k', id: 'i', name, input, children: [], result: result === undefined ? undefined : { text: result, isError: false, images: [], ...extra } })

test('each tool reads as what it did', () => {
  const read = toolView(tool('Read', { file_path: '/srv/app/src/App.tsx' }, '     1→import a\n     2→\n     3→export {}\n<system-reminder>x</system-reminder>'))
  assert.deepEqual([read.verb, read.target, read.where, read.meta], ['Read', 'App.tsx', 'app/src', '3 lines'])

  const img = toolView(tool('Read', { file_path: '/tmp/shot.png' }, '[image]', { images: ['data:image/png;base64,AA'] }))
  assert.equal(img.inline?.kind, 'images')

  const edit = toolView(tool('Edit', { file_path: '/a/b.ts', old_string: 'x\ny\nz', new_string: 'x\nY\nz' }, 'ok'))
  assert.equal(edit.meta, '+1 −1')
  assert.deepEqual(edit.inline, { kind: 'diff', lines: [{ sign: ' ', text: 'x' }, { sign: '-', text: 'y' }, { sign: '+', text: 'Y' }, { sign: ' ', text: 'z' }] })

  const write = toolView(tool('Write', { file_path: '/a/new.md', content: '# Hi\n\nthere' }, 'File created successfully at: /a/new.md'))
  assert.deepEqual([write.verb, write.meta], ['Created', '3 lines'])

  const bash = toolView(tool('Bash', { command: 'npm test', description: 'Run the tests' }, 'pass 3\nfail 0'))
  assert.deepEqual([bash.verb, bash.target, bash.where, bash.meta], ['Ran tests', 'Run the tests', 'npm test', '2 lines'])
  const failed = toolView(tool('Bash', { command: 'false' }, 'Exit code 1\nboom', { isError: true }))
  assert.equal(failed.meta, 'failed')
  assert.equal(failed.inline?.kind, 'output', 'errors show without a tap')

  assert.equal(toolView(tool('Grep', { pattern: 'refresh', path: '/srv/app' }, 'Found 2 files\na.ts\nb.ts')).meta, '2 files')
  assert.equal(toolView(tool('Glob', { pattern: '**/*.ts' }, 'No files found')).meta, 'none')

  const web = toolView(tool('WebSearch', { query: 'tauri ios push' }, 'Web search results for query: "x"\n\nLinks: [{"title":"Docs","url":"https://tauri.app"}]\n\nmore'))
  assert.deepEqual([web.meta, web.details[0]], ['1 result', { kind: 'links', links: [{ title: 'Docs', url: 'https://tauri.app' }] }])

  const mcp = toolView(tool('mcp__plugin_devdash_devdash__task_get', { key: 'shop#12' }, '{"title":"Fix"}'))
  assert.deepEqual([mcp.verb, mcp.where, mcp.target], ['Task get', 'DevDash', 'shop#12'])
  assert.deepEqual(mcpName('mcp__plugin_claude-mem_mcp-search__save_memory'), { server: 'Claude-mem', tool: 'Save memory' })

  assert.equal(toolView(tool('ScheduleWakeup', { delaySeconds: 1200, reason: 'watching CI' })).meta, 'in 20 min')
  const asked = toolView(tool('AskUserQuestion', { questions: [{ question: 'Which DB?' }] }, 'User has answered your questions: "Which DB?"="Postgres". You can now continue.'))
  assert.deepEqual(asked.inline, { kind: 'fields', fields: [['Which DB?', 'Postgres']] })
  assert.equal(toolView(tool('SomethingNew', { a: 1 }, 'done')).verb, 'Something New', 'tools nobody has seen yet still read')
})

test('steps on a file know which file, so it can open in the viewer', () => {
  assert.deepEqual(toolFile(tool('Read', { file_path: '/srv/app/a.ts', offset: 120, limit: 40 })), { file: '/srv/app/a.ts', line: 120 })
  assert.deepEqual(toolFile(tool('Edit', { file_path: '/srv/app/a.ts', old_string: 'a', new_string: 'b' })), { file: '/srv/app/a.ts', line: undefined })
  assert.equal(toolFile(tool('NotebookEdit', { notebook_path: '/srv/n.ipynb', new_source: 'x' })).file, '/srv/n.ipynb')
  assert.equal(toolView(tool('Write', { file_path: '/a/new.md', content: 'x' })).file, '/a/new.md')
  assert.equal(toolView(tool('mcp__x__save', { file_path: '/a/out.csv' })).file, '/a/out.csv')
  assert.equal(toolView(tool('Grep', { pattern: 'x', path: '/srv/app' })).file, undefined, 'folders are not files')
  assert.equal(toolView(tool('Bash', { command: 'ls' })).file, undefined)
})

test('diffs keep two lines of context and only the change', () => {
  assert.deepEqual(diff('a\nb\nc\nd\ne\nf', 'a\nb\nc\nD\ne\nf').map((l) => l.sign + l.text), [' b', ' c', '-d', '+D', ' e', ' f'])
})

test("what Claude Code says to Claude isn't shown as the person's message", () => {
  const blocks = buildTranscript([
    { type: 'user', uuid: 'p', origin: { kind: 'human' }, message: { content: 'please deploy' } },
    { type: 'user', uuid: 's', isSynthetic: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /home/a/.claude/skills/measured-design\n\n# Measured design…' }] } },
    { type: 'user', uuid: 'h', message: { content: 'Base directory for this skill: /x/skills/pdf\n\nbody' } }, // history: no flags
    { type: 'user', uuid: 'w', origin: { kind: 'task-notification', subkind: 'scheduled-trigger' }, message: { content: 'check CI' } },
    { type: 'user', uuid: 'q', origin: { kind: 'peer', name: 'Build bot', body: 'done' }, message: { content: '<peer>done</peer>' } },
    { type: 'user', uuid: 'c', origin: { kind: 'auto-continuation' }, message: { content: 'continue' } },
    { type: 'user', uuid: 'm', message: { content: '<monitor-event>file changed</monitor-event>' } },
    { type: 'user', uuid: 'r', message: { content: 'Continue where you left off. (DevDash: the server restarted while you were working.)' } },
    { type: 'user', uuid: 'k', message: { content: '<command-message>review</command-message><command-name>/review</command-name><command-args>PR 12</command-args>' } },
  ] as Raw[])
  assert.deepEqual(blocks.map((b) => (b.kind === 'event' ? `${b.tone}:${b.text}` : b.kind === 'command' ? `cmd:${b.name} ${b.args}` : b.kind)), [
    'user',
    'skill:Using the measured-design skill',
    'skill:Using the pdf skill',
    'schedule:A scheduled run started',
    'peer:Message from Build bot',
    'system:Continued on its own',
    'system:Monitor event',
    'system:Picked up again after a server restart',
    'cmd:/review PR 12',
  ])
  const skill = blocks[1]!
  assert.ok(skill.kind === 'event' && skill.detail?.startsWith('Base directory'), 'the raw text stays one tap away')
})

test('tool results keep their images; loaded tools keep their names', () => {
  const b = buildTranscript([
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/x.png' } }, { type: 'tool_use', id: 's', name: 'ToolSearch', input: {} }] } },
    { type: 'user', uuid: 'u', message: { content: [
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ' } }] },
      { type: 'tool_result', tool_use_id: 's', content: [{ type: 'tool_reference', tool_name: 'mcp__devdash__tasks_list' }] },
    ] } },
  ] as Raw[])
  const [read, search] = b as ToolBlock[]
  assert.deepEqual(read!.result?.images, ['data:image/png;base64,QQ'])
  assert.equal(toolView(search!).target, 'tasks_list')
})
