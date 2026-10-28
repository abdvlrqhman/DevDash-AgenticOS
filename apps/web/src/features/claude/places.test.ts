import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byFolder, folderName, sessionPlace } from './places.ts'

const s = (cwd: string, extra: Partial<{ status: string; lastActivityAt: number; project: { slug: string; name: string } | null }> = {}) =>
  ({ cwd, status: 'idle', lastActivityAt: 1, owner: { username: 'ann' }, project: null, ...extra })

test('sessions group by where they work, labelled the way people say it', () => {
  assert.equal(folderName('/home/ann/projects/portfolio', 'ann'), 'portfolio')
  assert.equal(folderName('/home/ann', 'ann'), 'Home folder')
  assert.equal(folderName('/srv/devdash/projects/shop/', 'ann'), 'shop')

  const shop = { slug: 'shop', name: 'Shop app' }
  const groups = byFolder([
    s('/srv/devdash/projects/shop', { project: shop }),
    s('/srv/devdash/worktrees/shop/1a2b', { project: shop, status: 'waiting' }), // a branch of the same project
    s('/home/ann/projects/portfolio', { lastActivityAt: 5 }),
    s('/home/ann/projects/portfolio', { lastActivityAt: 3 }),
    s('/home/ann/work/app'),
    s('/home/ann/old/app'),
    s('/home/ann'),
  ])
  assert.deepEqual(groups.map((g) => [g.label, g.sessions.length]), [
    ['Shop app', 2], ['portfolio', 2], ['work/app', 1], ['old/app', 1], ['Home folder', 1],
  ], 'project first (something waits there), one group per project, same-named folders told apart')
  assert.equal(sessionPlace(s('/srv/devdash/worktrees/shop/1a2b', { project: shop })), 'Shop app')
  assert.equal(sessionPlace(s('/home/ann/projects/calm-falcon')), 'calm-falcon')
})
