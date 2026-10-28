import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// git.ts fixes its allowed-paths regex to DEVDASH_PROJECTS_ROOT at load, so set it before importing it (dynamically).
const root = mkdtempSync(join(tmpdir(), 'dd-git-'))
process.env.DEVDASH_PROJECTS_ROOT = root
const dir = join(root, 'projects', 'app')
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
const commit = (msg: string) => g('commit', '-q', '--allow-empty', '-m', msg)

test('isAncestor sees a --no-ff merge and a fast-forward as merged, and an open branch as not', async () => {
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  commit('base')
  const { ops } = await import('./git.ts')

  // A branch with work, not merged yet.
  g('checkout', '-q', '-b', 'dd/aaa'); commit('work on aaa'); g('checkout', '-q', 'main')
  assert.deepEqual(await ops.isAncestor({ path: dir, branch: 'dd/aaa', base: 'main' }), { ancestor: false, mergeCommit: null, mergedAt: null })

  // --no-ff merge: ancestor, and the merge commit is the real merge (two parents).
  g('merge', '--no-ff', '-q', '-m', 'Merge dd/aaa', 'dd/aaa')
  const noff = await ops.isAncestor({ path: dir, branch: 'dd/aaa', base: 'main' })
  assert.equal(noff.ancestor, true)
  assert.ok(noff.mergeCommit)
  assert.ok(noff.mergedAt && noff.mergedAt > 0)
  const parents = g('rev-list', '--parents', '-n', '1', noff.mergeCommit!).trim().split(' ')
  assert.equal(parents.length, 3, 'the reported merge commit has two parents (a real --no-ff merge)')

  // Fast-forward merge: ancestor, with no merge commit — reports the branch tip.
  g('checkout', '-q', '-b', 'dd/bbb'); commit('work on bbb'); g('checkout', '-q', 'main')
  g('merge', '--ff-only', '-q', 'dd/bbb')
  const ff = await ops.isAncestor({ path: dir, branch: 'dd/bbb', base: 'main' })
  assert.equal(ff.ancestor, true)
  assert.equal(ff.mergeCommit, g('rev-parse', 'dd/bbb').trim(), 'a fast-forward reports the branch tip as the merge point')

  // A branch that no longer exists can't be told to be merged.
  assert.equal((await ops.isAncestor({ path: dir, branch: 'dd/gone', base: 'main' })).ancestor, false)
})
