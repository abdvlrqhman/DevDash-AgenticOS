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
