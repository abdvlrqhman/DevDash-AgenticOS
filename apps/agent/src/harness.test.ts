import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoAllowed, formAnswer, formQuestions, newFromReplay, toPrompt } from './harness.ts'

test("a replay adds only the turns DevDash's transcript doesn't have (typed in the agent's own terminal app)", () => {
  const prompt = (t: string) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } })
  const reply = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } }
  const ours = [prompt('a'), reply('A'), toolResult, prompt('b'), reply('B')]
  const replay = [prompt('a'), reply('A'), toolResult, prompt('b'), reply('B'), prompt('c'), toolResult, reply('C')]
  assert.deepEqual(newFromReplay(ours, replay), [prompt('c'), toolResult, reply('C')])
  assert.deepEqual(newFromReplay(ours, ours), [])
  assert.deepEqual(newFromReplay([], replay), replay) // nothing of ours yet (the session began in the CLI)
})

test('prompts: text, images and attached documents become ACP content', () => {
  assert.deepEqual(toPrompt([
    { type: 'text', text: 'Look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    { type: 'document', title: 'notes.md', source: { type: 'text', media_type: 'text/plain', data: '# hi' } },
    { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'PDF' } },
    { type: 'text', text: '' },
  ]), [
    { type: 'text', text: 'Look' },
    { type: 'image', mimeType: 'image/png', data: 'AAA' },
    { type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/plain', text: '# hi' } },
    { type: 'resource', resource: { uri: 'file:///spec.pdf', mimeType: 'application/pdf', blob: 'PDF' } },
  ])
})

test("permission modes decide like Claude Code's: reads always run, edits in Accept edits, everything in Bypass", () => {
  for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) assert.equal(autoAllowed(mode, 'Read'), true, mode)
  assert.equal(autoAllowed('default', 'Edit'), false)
  // DevDash's own tools run, except the personal agent's that reach other sessions or its schedules, and the tailnet's.
  assert.equal(autoAllowed('default', 'mcp__plugin_devdash_devdash__task_create'), true)
  assert.equal(autoAllowed('default', 'mcp__plugin_devdash_devdash__session_read'), true)
  for (const t of ['session_send', 'session_create', 'schedule_delete', 'net_devices']) assert.equal(autoAllowed('default', `mcp__plugin_devdash_devdash__${t}`), false, t)
  assert.equal(autoAllowed('bypassPermissions', 'mcp__plugin_devdash_devdash__session_send'), true)
  assert.equal(autoAllowed('acceptEdits', 'Edit'), true)
  assert.equal(autoAllowed('acceptEdits', 'Bash'), false)
  assert.equal(autoAllowed('bypassPermissions', 'Bash'), true)
  // DevDash's own task and note tools run; its network tools reach the owner's devices, so they ask.
  assert.equal(autoAllowed('default', 'mcp__plugin_devdash_devdash__task_update'), true)
  assert.equal(autoAllowed('default', 'mcp__plugin_devdash_devdash__net_devices'), false)
  assert.equal(autoAllowed('default', 'mcp__ida__decompile'), false)
})

test("OpenCode's question form becomes a question card, and the card's answer fills the form", () => {
  const schema = {
    properties: {
      q0: { type: 'string', title: 'Package manager', description: 'Which one?', oneOf: [{ const: 'npm', title: 'npm' }, { const: 'bun', title: 'Bun' }] },
      q0_custom: { type: 'string', title: 'Package manager (other)' },
      q1: { type: 'array', title: 'Targets', description: 'Where?', items: { anyOf: [{ const: 'web', title: 'Web' }, { const: 'ios', title: 'iOS' }] } },
    },
  }
  const qs = formQuestions(schema)
  assert.deepEqual(qs.map((q) => [q.key, q.question, q.header, q.multiSelect, q.options.map((o) => o.label)]), [
    ['q0', 'Which one?', 'Package manager', false, ['npm', 'Bun']],
    ['q1', 'Where?', 'Targets', true, ['Web', 'iOS']],
  ])
  assert.deepEqual(formAnswer(qs, { 'Which one?': 'Bun', 'Where?': 'Web, iOS' }, schema), { q0: 'bun', q1: ['web', 'ios'] })
  // A typed answer goes in the form's own free-text field.
  assert.deepEqual(formAnswer(qs, { 'Which one?': 'pnpm', 'Where?': 'iOS' }, schema), { q0_custom: 'pnpm', q1: ['ios'] })
})

test("OpenCode's terminal app asks as the session's permission mode would; Chat leaves every decision to DevDash", async () => {
  const { cliPermissions, config } = await import('./opencode.ts')
  const effect = (rules: { action: string; effect: string }[], action: string) => [...rules].reverse().find((r) => r.action === action || r.action === '*')!.effect
  assert.equal(effect(cliPermissions('bypassPermissions'), 'shell'), 'allow')
  assert.deepEqual(['edit', 'shell'].map((a) => effect(cliPermissions('acceptEdits'), a)), ['allow', 'ask'])
  assert.deepEqual(['read', 'edit', 'shell'].map((a) => effect(cliPermissions('default'), a)), ['allow', 'ask', 'ask'])
  const chat = config({ rulesFile: '/r.md', mcp: { devdash: { type: 'local', command: ['node', 'x.mjs'], environment: {} } } })
  assert.deepEqual(chat.permissions, [{ action: '*', resource: '*', effect: 'ask' }])
  assert.deepEqual(chat.mcp.servers.devdash, { type: 'local', command: ['node', 'x.mjs'], environment: {}, codemode: false })
})

test('"Always allow" covers a command by program and subcommand, a fetch by site, anything else by its tool', async () => {
  const { alwaysKey } = await import('./harness.ts')
  assert.equal(alwaysKey('Bash', { command: 'git status --short' }), 'Bash(git status)')
  assert.equal(alwaysKey('Bash', { command: 'npm test -- auth' }), 'Bash(npm test)')
  assert.equal(alwaysKey('Bash', { command: 'ls -la /tmp' }), 'Bash(ls)') // a flag isn't a subcommand
  assert.equal(alwaysKey('Bash', { command: 'echo one' }), 'Bash(echo)') // nor is a plain program's argument
  assert.equal(alwaysKey('WebFetch', { url: 'https://docs.example.com/a?b' }), 'WebFetch(docs.example.com)')
  assert.equal(alwaysKey('Edit', { file_path: '/x' }), 'Edit')
})

test("a team role's limits, in Claude Code's rule syntax: tools it has, and what runs without asking", async () => {
  const { allowedBy, policyDecision } = await import('./harness.ts')
  const rules = ['Read', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(head:*)', 'mcp__plugin_devdash_devdash', 'WebFetch(domain:example.com)']
  assert.equal(allowedBy(rules, 'Read', {}), true)
  assert.equal(allowedBy(rules, 'Bash', { command: 'git log --oneline' }), true)
  assert.equal(allowedBy(rules, 'Bash', { command: 'git log | head -5' }), true) // every part allowed
  assert.equal(allowedBy(rules, 'Bash', { command: 'git log && rm -rf x' }), false) // one part isn't
  assert.equal(allowedBy(rules, 'Bash', { command: 'git logx' }), false)
  assert.equal(allowedBy(rules, 'mcp__plugin_devdash_devdash__team_note', {}), true) // the whole server
  assert.equal(allowedBy(rules, 'WebFetch', { url: 'https://api.example.com/x' }), true)
  assert.equal(allowedBy(rules, 'WebFetch', { url: 'https://example.org' }), false)
  const policy = { tools: ['Read', 'Bash'], allow: rules }
  assert.equal(policyDecision(policy, 'Edit'), 'deny') // not one of its tools
  assert.equal(policyDecision(policy, 'Read'), 'allow')
  assert.equal(policyDecision(policy, 'Bash', { command: 'npm publish' }), null) // its tool, but asks (or, in Don't ask, is denied)
  assert.equal(policyDecision(policy, 'mcp__ida__x'), null) // MCP tools aren't limited by `tools`
  assert.equal(policyDecision(null, 'Edit'), null)
})

test("Don't ask isn't Bypass: nothing runs on its own but reads", async () => {
  const { autoAllowed } = await import('./harness.ts')
  assert.equal(autoAllowed('dontAsk', 'Bash'), false)
  assert.equal(autoAllowed('auto', 'Bash'), false) // no classifier here: like Ask
})

test("a prompt naming a command is kept as one; anything else, or a teammate's, is left as it is", async () => {
  const { commandText, notACommand } = await import('./harness.ts')
  const cmds = [{ name: 'review' }, { name: 'team/review' }]
  assert.deepEqual(commandText([{ type: 'text', text: '/review src/auth.ts' }], cmds), [{ type: 'text', text: '<command-name>/review</command-name>\n<command-args>src/auth.ts</command-args>' }])
  assert.deepEqual(commandText([{ type: 'text', text: '/team/review' }], cmds), [{ type: 'text', text: '<command-name>/team/review</command-name>\n<command-args></command-args>' }])
  assert.equal(commandText([{ type: 'text', text: '/etc/hosts is broken' }], cmds), null) // not one of its commands
  assert.equal(commandText([{ type: 'text', text: 'please /review' }], cmds), null)
  assert.equal(commandText([{ type: 'text', text: '/review' }, { type: 'image' }], cmds), null) // with an image: a message
  assert.deepEqual(notACommand([{ type: 'text', text: '/review' }]), [{ type: 'text', text: 'A teammate wrote:' }, { type: 'text', text: '/review' }])
  assert.deepEqual(notACommand([{ type: 'text', text: 'hi' }]), [{ type: 'text', text: 'hi' }])
})
