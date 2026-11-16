import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFolders, forSession, within } from './skill-scope.ts'

const R = '/srv/devdash'

test('a folder covers itself, what is under it, and (for a project) its session worktrees', () => {
  assert.equal(within(['/srv/devdash/projects/shop'], '/srv/devdash/projects/shop', R), true)
  assert.equal(within(['/srv/devdash/projects/shop'], '/srv/devdash/projects/shop/.claude/worktrees/x', R), true)
  assert.equal(within(['/srv/devdash/projects/shop'], '/srv/devdash/worktrees/shop/ab12cd34', R), true)
  assert.equal(within(['/srv/devdash/projects/shop'], '/srv/devdash/projects/shopify', R), false, 'not a prefix match')
  assert.equal(within(['/srv/devdash/projects/shop'], '/srv/devdash/worktrees/shopify/ab12', R), false)
  assert.equal(within(['/home/a/projects/lucky'], '/home/a/projects/lucky/src', R), true)
  assert.equal(within([], '/anything', R), false)
})

test('a session hides My skills meant for other folders, and turns scoped plugins on only where they belong', () => {
  const s = { skills: { pdf: ['/home/a/projects/docs'], deck: ['/srv/devdash/projects/shop'] }, plugins: { 'od@local': ['/home/a/projects/lucky'] } }
  assert.deepEqual(forSession(s, '/home/a/projects/docs', R), { hide: ['deck'], plugins: { 'od@local': false } })
  assert.deepEqual(forSession(s, '/srv/devdash/worktrees/shop/1', R), { hide: ['pdf'], plugins: { 'od@local': false } })
  assert.deepEqual(forSession(s, '/home/a/projects/lucky', R), { hide: ['pdf', 'deck'], plugins: { 'od@local': true } })
  assert.deepEqual(forSession({ skills: {}, plugins: {} }, '/x', R), { hide: [], plugins: {} })
})

test('folders: absolute or ~, tidied and deduplicated; nothing relative, upward or empty', () => {
  assert.deepEqual(cleanFolders(['~/projects/app/', '/srv/devdash/projects/shop', '~/projects/app'], '/home/a'), ['/home/a/projects/app', '/srv/devdash/projects/shop'])
  assert.deepEqual(cleanFolders(['~'], '/home/a'), ['/home/a'])
  for (const bad of [[], ['projects/app'], ['/a/../b'], ['/'], ['/a\nb'], [7], 'nope']) assert.throws(() => cleanFolders(bad, '/home/a'), String(bad))
  assert.throws(() => cleanFolders(Array.from({ length: 51 }, (_, i) => `/f${i}`), '/h'))
})
