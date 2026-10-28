import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentEvent, AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeRepo } from '../claude/repo.ts'
import { claudeService } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { reviewsService } from './service.ts'

// record() is what the team module's onProposalIdle callback calls when an approved code proposal's session goes quiet
// (team owns that detection; the boundary test keeps Team unimported here). We drive it directly.
const WORKTREE = '/srv/devdash/worktrees/shop/abc12345'
const ann: User = { id: 1, name: 'Ann', username: 'ann', email: '', role: 'admin' }

function setup(repoUrl: string | null = 'https://github.com/acme/shop.git') {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'ann@example.com', 'ann', 'Ann', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'shop', 'Shop', 1)").run()
  const sent: Record<string, unknown>[] = []
  const replies: Record<string, unknown> = {
    'git.branchStat': { commits: 2, files: 3, insertions: 40, deletions: 5 },
    'gh.pr': { url: 'https://github.com/acme/shop/pull/7' },
    'git.mergeBranch': { ok: true },
    'git.branchDiff': { diff: 'diff --git a/x b/x\n+hi', truncated: false },
  }
  const rpcs: Record<string, (u: string, p: unknown) => unknown> = {}
  const agents = {
    onEvent: (_fn: (u: string, ev: AgentEvent) => void) => {},
    onRpc: (name: string, fn: (u: string, p: unknown) => unknown) => void (rpcs[name] = fn),
    request: async (_u: string, req: Record<string, unknown>) => { sent.push(req); return replies[String(req.op)] ?? { ok: true } },
  } as unknown as AgentsService
  const project = { id: 1, slug: 'shop', name: 'Shop', repo_url: repoUrl, default_branch: 'main' }
  const projects = {
    bySlug: (slug: string) => { if (slug !== 'shop') throw new Error('no project'); return project },
    path: () => '/srv/devdash/projects/shop',
    forPath: () => project,
    worktree: async () => ({ path: WORKTREE, branch: 'dd/abc12345' }),
  } as unknown as ProjectsService
  const hub = createHub()
  const notified: { userId: number; title: string }[] = []
  const notify = async (userId: number, _k: string, n: { title: string }) => void notified.push({ userId, title: n.title })
  const claude = claudeService({ db, agents, hub, projects, notify: async () => {} })
  const merged: { id: number; mergeCommit: string | null }[] = []
  const reviews = reviewsService({ db, hub, agents, projects, notify, onMerged: (d, commit) => merged.push({ id: d.id, mergeCommit: commit }) })
  reviews.registerMcp()

  /** A session as if a code proposal had been approved: own-branch worktree, origin=proposal. */
  async function proposalSession(title = 'CTO: Add rate limiting') {
    const s = await claude.create(ann, {
      prompt: 'Work on it', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'dontAsk',
      mode: 'chat', project: 'shop', worktree: true,
    }, { title, origin: { kind: 'proposal', role: 'CTO' }, listed: false })
    return s.id
  }
  const rows = () => db.prepare('select * from code_deliveries').all() as Record<string, unknown>[]
  const sessionRow = (id: string) => claudeRepo(db).byId(id)!
  return { db, sent, replies, rpcs, merged, claude, reviews, notified, proposalSession, rows, sessionRow }
}

test('a finished proposal session with commits becomes a ready delivery and notifies once', async () => {
  const { reviews, notified, rows, proposalSession, sessionRow } = setup()
  const id = await proposalSession()
  await reviews.record(sessionRow(id))
  const d = rows()
  assert.equal(d.length, 1)
  assert.equal(d[0]!.status, 'ready')
  assert.equal(d[0]!.role, 'CTO')
  assert.equal(d[0]!.title, 'Add rate limiting') // the "CTO: " prefix is stripped
  assert.equal(d[0]!.branch, 'dd/abc12345')
  assert.equal(d[0]!.base_branch, 'main')
  assert.equal(d[0]!.commits, 2)
  assert.equal(d[0]!.files, 3)
  assert.equal(notified.length, 1)
  assert.match(notified[0]!.title, /CTO finished: Add rate limiting — ready to review/)

  // Re-finishing (more commits) updates the stats but does not notify again while still 'ready'.
  await reviews.record(sessionRow(id))
  assert.equal(rows().length, 1)
  assert.equal(notified.length, 1)
  assert.equal(reviews.list('shop').readyCount, 1)
})

test('no delivery for a proposal session with zero commits', async () => {
  const { replies, notified, rows, proposalSession, reviews, sessionRow } = setup()
  replies['git.branchStat'] = { commits: 0, files: 0, insertions: 0, deletions: 0 }
  const id = await proposalSession()
  await reviews.record(sessionRow(id))
  assert.equal(rows().length, 0)
  assert.equal(notified.length, 0)
})

test('non-proposal sessions never create deliveries', async () => {
  const { reviews, claude, rows, sessionRow } = setup()
  const s = await claude.create(ann, {
    prompt: 'Hi', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default',
    mode: 'chat', project: 'shop', worktree: true,
  })
  await reviews.record(sessionRow(s.id)) // a plain session: no origin_kind
  assert.equal(rows().length, 0)
})

test('a dismissed delivery re-surfaces and notifies again when new work lands', async () => {
  const { reviews, notified, rows, proposalSession, sessionRow } = setup()
  const id = await proposalSession()
  await reviews.record(sessionRow(id))
  reviews.dismiss(ann, 'shop', Number(rows()[0]!.id))
  assert.equal(reviews.list('shop').deliveries.length, 0)
  await reviews.record(sessionRow(id)) // committed more after dismissal
  assert.equal(reviews.list('shop').readyCount, 1)
  assert.equal(notified.length, 2)
})

test('dismiss, open PR and merge move a delivery through its states', async () => {
  const { reviews, sent, rows, proposalSession, sessionRow } = setup()
  const id1 = await proposalSession('CTO: One')
  await reviews.record(sessionRow(id1))
  const deliveryId = Number(rows()[0]!.id)

  // Open PR (GitHub project): pushes + opens the PR, stores the URL, status 'opened'.
  const pr = await reviews.openPr(ann, 'shop', deliveryId)
  assert.equal(pr.status, 'opened')
  assert.equal(pr.prUrl, 'https://github.com/acme/shop/pull/7')
  assert.ok(sent.some((r) => r.op === 'gh.pr' && r.branch === 'dd/abc12345' && r.base === 'main'))

  // Dismiss: drops it from the list.
  reviews.dismiss(ann, 'shop', deliveryId)
  assert.equal(reviews.list('shop').deliveries.length, 0)

  // Merge: status 'merged', still listed as recently merged.
  const merged = await reviews.merge(ann, 'shop', deliveryId)
  assert.equal(merged.status, 'merged')
  assert.ok(sent.some((r) => r.op === 'git.mergeBranch' && r.base === 'main'))
  assert.equal(reviews.list('shop').deliveries.length, 1)
  assert.equal(reviews.list('shop').readyCount, 0)
})

test('open PR is refused for a project without a GitHub remote; diff is fetched from the agent', async () => {
  const { reviews, rows, proposalSession, sessionRow } = setup(null)
  const id = await proposalSession()
  await reviews.record(sessionRow(id))
  const deliveryId = Number(rows()[0]!.id)
  await assert.rejects(() => reviews.openPr(ann, 'shop', deliveryId), /no GitHub remote/)
  const diff = await reviews.diff(ann, 'shop', deliveryId)
  assert.match(diff.diff, /diff --git/)
})

test('a fetch marks a card merged when its branch has landed in the default branch outside DevDash, and it leaves Ready', async () => {
  const { reviews, replies, rows, merged, proposalSession, sessionRow } = setup()
  const id = await proposalSession()
  await reviews.record(sessionRow(id))
  assert.equal(rows()[0]!.status, 'ready')
  assert.equal(reviews.list('shop').readyCount, 1)
  // The next repo fetch asks git: the branch is now an ancestor of the default branch (a session merged it and deployed).
  replies['git.isAncestor'] = { ancestor: true, mergeCommit: 'f'.repeat(40), mergedAt: 1_700_000_000 }
  await reviews.checkMerges({ id: 1, slug: 'shop', default_branch: 'main', creator_username: 'ann' })
  const d = rows()[0]!
  assert.equal(d.status, 'merged')
  assert.equal(d.merged_commit, 'f'.repeat(40))
  assert.equal(d.merged_at, 1_700_000_000)
  assert.equal(reviews.list('shop').readyCount, 0, 'it no longer waits to be reviewed')
  assert.deepEqual(merged, [{ id: d.id, mergeCommit: 'f'.repeat(40) }], 'Team is told, once, so it can note the merge')
  // A later fetch doesn't re-mark or re-notify an already-merged card.
  await reviews.checkMerges({ id: 1, slug: 'shop', default_branch: 'main', creator_username: 'ann' })
  assert.equal(merged.length, 1)
})

test('a branch not yet in the default branch stays ready', async () => {
  const { reviews, replies, rows, proposalSession, sessionRow } = setup()
  await reviews.record(sessionRow(await proposalSession()))
  replies['git.isAncestor'] = { ancestor: false, mergeCommit: null, mergedAt: null }
  await reviews.checkMerges({ id: 1, slug: 'shop', default_branch: 'main', creator_username: 'ann' })
  assert.equal(rows()[0]!.status, 'ready')
})

test('review_card_update lets a session close its own card after merging a dd/* branch', async () => {
  const { reviews, rpcs, rows, merged, proposalSession, sessionRow } = setup()
  const sid = await proposalSession()
  await reviews.record(sessionRow(sid))
  const out = rpcs['mcp.review_card_update']!('ann', { sessionId: sid, args: { branch: 'dd/abc12345', status: 'merged', merged_commit: 'c0ffee0' } })
  assert.match(String(out), /merged/)
  assert.equal(rows()[0]!.status, 'merged')
  assert.equal(rows()[0]!.merged_commit, 'c0ffee0')
  assert.equal(merged.length, 1)
})
