import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import type { AgentsService } from '../agents/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { deployService, githubRepo } from './deploy.ts'

const sha = (c: string) => c.repeat(40)
const commit = (c: string, message: string) => ({ sha: sha(c), html_url: `https://github.com/example/DevDash/commit/${sha(c)}`, commit: { message, author: { name: 'Yara', date: '2026-10-12T10:00:00Z' } } })

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', ?)")
  add.run(1, 'y@x.io', 'yara', 'Yara', 'admin')
  add.run(2, 'a@x.io', 'omar', 'Omar', 'member')
  db.prepare("insert into projects (id, slug, name, repo_url, created_by) values (1, 'devdash', 'DevDash', 'https://github.com/example/DevDash.git', 1), (2, 'shop', 'Shop', 'git@github.com:example/shop.git', 1)").run()
  const session = db.prepare("insert into claude_sessions (id, owner_id, profile, title, cwd, mode, permission_mode, project_id) values (?, 2, 'default', ?, '/srv', 'chat', 'default', ?)")
  session.run('s-dd', 'Ship the deploy button', 1)
  session.run('s-shop', 'Shop work', 2)

  const rpc: Record<string, (username: string, params: unknown) => unknown> = {}
  const agents = { onRpc: (name: string, fn: (u: string, p: unknown) => unknown) => void (rpc[name] = fn) } as unknown as AgentsService
  const projects = { forPath: () => null } as unknown as ProjectsService
  const notified: { userId: number; kind: string; title: string }[] = []
  // main on GitHub, newest first; c2 is live.
  const main = [commit('4', 'Server page: deploy button'), commit('3', 'Fix tabs'), commit('2', 'Answer line'), commit('1', 'Team')]
  let live = { id: sha('2').slice(0, 12), since: Math.floor(Date.now() / 1000) - 3600 }
  const helperCalls: { cmd: string; args: { sha: string } }[] = []
  const unit: { state: string; result: string; ran: boolean; log?: string }[] = []
  const deploys = deployService({
    db, agents, projects, runDir: '', repo: 'example/DevDash', live: () => live, pollMs: 5,
    notify: async (userId, kind, n) => void notified.push({ userId, kind, title: n.title }),
    github: (async () => new Response(JSON.stringify(main))) as unknown as typeof fetch,
    rootHelper: async (cmd, args) => {
      helperCalls.push({ cmd, args: args as { sha: string } })
      if (cmd === 'deploy-status') {
        const s = unit.shift() ?? { state: 'inactive', result: 'success', ran: true }
        if (s.state === 'inactive' && s.result === 'success') live = { id: (args as { sha: string }).sha.slice(0, 12), since: Math.floor(Date.now() / 1000) }
        return { ok: true, ...s }
      }
      return { ok: true }
    },
  })
  deploys.registerMcp()
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(fn(), 'timed out')
  }
  const status = (id: number) => (db.prepare('select status, log from deploys where id = ?').get(id) as { status: string; log: string | null })
  const yara = { id: 1, name: 'Yara', role: 'admin' }
  const omar = { id: 2, name: 'Omar', role: 'member' }
  return { db, rpc, deploys, notified, main, helperCalls, unit, until, status, yara, omar }
}

test('GitHub repository URLs: https and ssh, with or without .git', () => {
  assert.equal(githubRepo('https://github.com/abdvlrqhman/DevDash.git'), 'abdvlrqhman/devdash')
  assert.equal(githubRepo('https://github.com/abdvlrqhman/DevDash'), 'abdvlrqhman/devdash')
  assert.equal(githubRepo('git@github.com:abdvlrqhman/DevDash.git'), 'abdvlrqhman/devdash')
  assert.equal(githubRepo('https://gitlab.com/abdvlrqhman/DevDash.git'), null)
  assert.equal(githubRepo(null), null)
})

test('a session in DevDash\'s own project asks; admins hear; an admin deploys; the server follows it to the end', async () => {
  const { rpc, deploys, notified, helperCalls, until, status, yara, omar } = setup()
  // The tools exist only in DevDash's own project.
  assert.deepEqual(rpc['mcp.devdash_here']!('omar', { sessionId: 's-dd' }), { here: true })
  assert.deepEqual(rpc['mcp.devdash_here']!('omar', { sessionId: 's-shop' }), { here: false })
  await assert.rejects(async () => rpc['mcp.devdash_deploy_request']!('omar', { sessionId: 's-shop', args: {} }), /Only sessions in the project of DevDash's own repository/)

  const asked = await rpc['mcp.devdash_deploy_request']!('omar', { sessionId: 's-dd', args: { note: 'The deploy button' } }) as string
  assert.match(asked, /Asked the admins \(Yara\) to deploy 4444444 \(request #1\)\. It brings 2 commits: 4444444, 3333333\./)
  assert.deepEqual(notified, [{ userId: 1, kind: 'needs_you', title: 'Omar asks to update DevDash' }])
  assert.match(await rpc['mcp.devdash_deploy_request']!('omar', { sessionId: 's-dd', args: {} }) as string, /Already waiting for approval \(request #1\)/)
  assert.equal(notified.length, 1, 'asking twice notifies once')

  const s = await deploys.state(true)
  assert.deepEqual(s.ahead!.map((c) => c.sha[0]), ['4', '3'])
  assert.deepEqual(s.requests.map((r) => ({ id: r.id, by: r.by, session: r.session?.title })), [{ id: 1, by: 'Omar', session: 'Ship the deploy button' }])
  assert.equal(s.canAct, true)

  await assert.rejects(deploys.start(omar, { requestId: 1 }), /Only admins deploy/)
  const d = await deploys.start(yara, { requestId: 1 })
  assert.equal(d.status, 'running')
  assert.deepEqual(helperCalls[0], { cmd: 'deploy', args: { sha: '4'.repeat(40) } })
  await assert.rejects(deploys.start(yara, {}), /already running/)
  await until(() => status(1).status === 'done')
  assert.deepEqual(notified.slice(1).map((n) => [n.userId, n.title]).sort(), [[1, 'DevDash updated to 4444444'], [2, 'DevDash updated to 4444444']])
  await assert.rejects(deploys.request(omar, {}), /4444444 is already live/)
})

test('a deploy that went live counts as done even after systemd forgot its unit (the new server resumes watching it)', async () => {
  const { deploys, unit, until, status, yara } = setup()
  unit.push(...Array(40).fill({ state: 'inactive', result: 'success', ran: false }))
  const d = await deploys.start(yara, {})
  await until(() => status(d.id).status !== 'running')
  assert.deepEqual({ ...status(d.id) }, { status: 'done', log: null })
})

test('a failed deploy keeps its output; admins decline requests; older commits stay as rollback requests', async () => {
  const { deploys, notified, unit, until, status, yara, omar, main } = setup()
  await assert.rejects(deploys.request(omar, { commit: 'zz' }), /Give a commit id/)
  await assert.rejects(deploys.request(omar, { commit: '9999999' }), /isn't among the newest 40 commits/)

  unit.push({ state: 'active', result: 'success', ran: true }, { state: 'failed', result: 'exit-code', ran: true, log: 'npm ERR! build failed' })
  const d = await deploys.start(yara, { sha: '3333333' })
  await until(() => status(d.id).status === 'failed')
  assert.equal(status(d.id).log, 'npm ERR! build failed')
  assert.ok(notified.some((n) => n.kind === 'errors' && n.title === 'DevDash update to 3333333 failed'))
  assert.equal((await deploys.state(true)).last!.log, 'npm ERR! build failed')

  const r = await deploys.request(omar, { note: 'please' })
  deploys.decline(yara, r.id)
  assert.equal(status(r.id).status, 'declined')
  assert.ok(notified.some((n) => n.userId === 2 && n.title === 'Yara declined the DevDash update to 4444444'))
  assert.throws(() => deploys.decline(yara, r.id), /already handled/)

  // Asking for a commit older than the live one is a rollback: it waits for an admin like any other request.
  const back = await deploys.request(omar, { commit: main[3]!.sha.slice(0, 7) })
  assert.equal((await deploys.state(true, true)).requests.map((x) => x.id).includes(back.id), true)
})

test('a newer request supersedes an older pending one for a commit it already includes, so only the latest shows', async () => {
  const { deploys, db, omar } = setup()
  // main is [c4, c3, c2(live), c1]; ahead is [c4, c3].
  const older = await deploys.request(omar, { commit: sha('3').slice(0, 7) }) // request #1, brings c3
  assert.deepEqual((await deploys.state(true, true)).requests.map((r) => r.id), [older.id])

  const newer = await deploys.request(omar, {}) // request #2, the newest (c4), which includes c3
  assert.equal(newer.superseded, 1)
  // Only the newer request waits now.
  assert.deepEqual((await deploys.state(true, true)).requests.map((r) => r.id), [newer.id])
  // The older one is declined (never ran) with a note — and must not read as the last deploy.
  const row = db.prepare('select status, note from deploys where id = ?').get(older.id) as { status: string; note: string | null }
  assert.equal(row.status, 'declined')
  assert.match(row.note ?? '', /Superseded by a newer request \(#2\)/)
  assert.equal((await deploys.state(true, true)).last, null)
})
