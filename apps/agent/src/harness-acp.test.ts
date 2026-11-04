import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The ACP driver against a stand-in agent (testdata/fake-acp-agent.mjs) installed as OpenCode, in a home of its own.
const dir = mkdtempSync(join(tmpdir(), 'dd-acp-'))
mkdirSync(join(dir, 'bin'))
symlinkSync(fileURLToPath(new URL('./testdata/fake-acp-agent.mjs', import.meta.url)), join(dir, 'bin', 'opencode'))
const logFile = join(dir, 'agent.jsonl')
Object.assign(process.env, { HOME: dir, DEVDASH_OPENCODE_HOME: dir, FAKE_ACP_LOG: logFile })
const H = await import('./harness.ts')
const received = () => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown>; config?: { permissions: unknown[] } })
test.after(() => rmSync(dir, { recursive: true, force: true }))

test("a one-off answer: the agent's text, on the asked model, with every tool denied and its session deleted", async () => {
  rmSync(logFile, { force: true })
  assert.equal(await H.complete('opencode', 'default', 'What is 2+2?', { system: 'Answer briefly.', model: 'fake/two' }), '4')
  const got = received()
  assert.deepEqual(got[0]!.config!.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
  assert.equal(got.find((m) => m.method === 'session/set_config_option')?.params?.value, 'fake/two')
  assert.ok(got.some((m) => m.method === 'session/delete' && m.params?.sessionId === 'ses_fake'))
})

test('a Chat turn: the shell call is asked as Bash, "Always allow" keeps the next one quiet, and history is kept', async () => {
  const events: Record<string, unknown>[] = []
  const waiters: [(e: Record<string, unknown>) => boolean, () => void][] = []
  H.setEmitter((e) => {
    events.push(e)
    for (const [test, done] of waiters) if (test(e)) done()
    if (e.ev === 'claude.permission') {
      H.answer(l.id, e.requestId as string, { behavior: 'allow', updatedInput: e.input as Record<string, unknown>, updatedPermissions: e.suggestions as unknown[] })
    }
  })
  const result = () => new Promise<void>((done) => waiters.push([(e) => e.ev === 'claude.msg' && (e.msg as { type?: string }).type === 'result', done]))
  const l = { id: randomUUID(), harness: 'opencode', nativeId: null, cwd: dir, profile: 'default', model: null, permissionMode: 'default' as const, started: false, ownerName: 'Ann' }

  let ended = result()
  await H.send(l, [{ type: 'text', text: 'Please run `git status --short`.' }], randomUUID())
  await ended
  const asked = events.filter((e) => e.ev === 'claude.permission')
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.toolName, 'Bash')
  assert.deepEqual(asked[0]!.input, { command: 'git status --short' })
  assert.deepEqual(asked[0]!.suggestions, [{ always: 'Bash(git status)' }])
  assert.ok(events.some((e) => e.ev === 'claude.native' && e.nativeId === 'ses_fake'))
  assert.ok(events.some((e) => e.ev === 'claude.context' && e.percent === 10))

  ended = result()
  await H.send({ ...l, nativeId: 'ses_fake', started: true }, [{ type: 'text', text: 'And run `git status`.' }], randomUUID())
  await ended
  assert.equal(events.filter((e) => e.ev === 'claude.permission').length, 1, 'always allowed: not asked again')
  const r = events.filter((e) => e.ev === 'claude.msg' && (e.msg as { type?: string }).type === 'result').at(-1)!.msg as { total_cost_usd: number; result: string }
  assert.deepEqual([r.result, r.total_cost_usd], ['done', 0.01])

  // Kept: the prompts, the steps and the replies; not the results (the server keeps those).
  const kept = H.history({ ...l, nativeId: 'ses_fake' }, {}).messages as { type: string; message?: { content?: { type: string; name?: string }[] } }[]
  assert.deepEqual(kept.map((m) => [m.type, m.message?.content?.map((c) => c.name ?? c.type).join()]), [
    ['user', 'text'], ['assistant', 'Bash'], ['user', 'tool_result'], ['assistant', 'text'],
    ['user', 'text'], ['assistant', 'Bash'], ['user', 'tool_result'], ['assistant', 'text'],
  ])
  await H.stop(l.id)
})

test("OpenCode's commands: offered with their hints, kept as commands, /compact noted; a teammate's message never runs one", async () => {
  const events: Record<string, unknown>[] = []
  let ended: (() => void) | undefined
  H.setEmitter((e) => {
    events.push(e)
    if (e.ev === 'claude.msg' && (e.msg as { type?: string }).type === 'result') ended?.()
  })
  const turn = (l: Parameters<typeof H.send>[0], text: string, guest: { id: number; name: string } | null = null) =>
    new Promise<void>((done) => { ended = done; void H.send(l, [{ type: 'text', text }], randomUUID(), guest) })
  const l = { id: randomUUID(), harness: 'opencode', nativeId: null, cwd: dir, profile: 'default', model: null, permissionMode: 'bypassPermissions' as const, started: false, ownerName: 'Ann' }
  rmSync(logFile, { force: true })
  await turn(l, 'hello')
  const { commands } = await H.commandsAndModels('opencode', 'default')
  assert.deepEqual(commands.find((c) => c.name === 'review'), { name: 'review', description: 'Review changes', argumentHint: '[commit|branch|pr]' })

  await turn(l, '/compact')
  assert.ok(events.some((e) => e.ev === 'claude.msg' && (e.msg as { subtype?: string }).subtype === 'compact_boundary'), 'the compaction is noted')
  const kept = H.history(l, {}).messages as { message?: { content?: { text?: string }[] } }[]
  assert.ok(kept.some((m) => m.message?.content?.[0]?.text === '<command-name>/compact</command-name>\n<command-args></command-args>'), 'shown as a command')

  // A teammate's "/review" reaches the agent as words, not as a command.
  await turn(l, '/review main', { id: 2, name: 'Bob' })
  const prompts = received().filter((m) => m.method === 'session/prompt').map((m) => (m.params!.prompt as { text?: string }[])[0]!.text)
  assert.deepEqual(prompts, ['hello', '/compact', 'A teammate wrote:'])
  await H.stop(l.id)
})

test('sign-ins: each kind opens its own OpenCode sign-in in the profile, and a browser sign-in is finished from DevDash', async () => {
  const { createServer } = await import('node:http')
  assert.deepEqual(H.loginCommand('opencode', 'default', 'acct').args.slice(1), ['auth', 'login', 'opencode', '--standalone'])
  assert.deepEqual(H.loginCommand('opencode', 'default', 'go').args.slice(1), ['auth', 'login', 'opencode-go', '--standalone'])
  assert.deepEqual(H.loginCommand('opencode', 'work', 'login'), { env: { OPENCODE_DB: join(dir, '.opencode-profiles', 'work', 'opencode.db') }, args: [join(dir, 'bin', 'opencode'), 'auth', 'login', '--standalone'] })
  assert.throws(() => H.loginCommand('opencode', 'default', 'shell'), /unknown sign-in/)

  // Only a local sign-in address with its code: nothing else on the machine, nothing outside it.
  for (const bad of ['https://127.0.0.1:41879/cb?code=1', 'http://example.com:41879/cb?code=1', 'http://127.0.0.1/cb?code=1', 'http://127.0.0.1:22/?x=1', 'http://127.0.0.1:41879/cb', 'not a url']) {
    assert.throws(() => H.signInCallback(bad), Error, bad)
  }
  assert.equal(H.signInCallback(' http://localhost:41879/auth/callback?code=abc&state=s ').port, '41879')

  // The sign-in waiting in the terminal gets the code.
  let got = ''
  const server = createServer((req, res) => { got = req.url ?? ''; res.end('Signed in') }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  assert.deepEqual(await H.finishSignIn(`http://127.0.0.1:${port}/auth/callback?code=abc&state=s`), { ok: true })
  assert.equal(got, '/auth/callback?code=abc&state=s')
  server.close()
  await assert.rejects(H.finishSignIn(`http://127.0.0.1:${port}/auth/callback?code=abc`), /No sign-in is waiting/)
})
