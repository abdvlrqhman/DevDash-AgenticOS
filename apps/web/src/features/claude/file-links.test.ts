import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeFile, fileKind, folderOf, foldersIn, hrefFile, knownFor, lookIn, mainCheckout, normalize, resolvePaths, splitLine } from './file-links.ts'

const at = { cwd: '/srv/devdash/projects/shop', username: 'ann' }

test('code spans that are file paths open; ordinary code stays code', () => {
  assert.deepEqual(codeFile('docs/guide.md', at), { path: '/srv/devdash/projects/shop/docs/guide.md', line: undefined })
  assert.deepEqual(codeFile('apps/web/src/main.tsx:42', at), { path: '/srv/devdash/projects/shop/apps/web/src/main.tsx', line: 42 })
  assert.deepEqual(codeFile('src/a.ts:42:7', at), { path: '/srv/devdash/projects/shop/src/a.ts', line: 42 })
  assert.deepEqual(codeFile('/srv/x/README.md', at), { path: '/srv/x/README.md', line: undefined })
  assert.deepEqual(codeFile('~/notes/todo.txt', at), { path: '/home/ann/notes/todo.txt', line: undefined })
  assert.deepEqual(codeFile('../other/package.json', at), { path: '/srv/devdash/projects/other/package.json', line: undefined })
  assert.equal(codeFile('README.md', at)?.path, '/srv/devdash/projects/shop/README.md')
  assert.equal(codeFile('Makefile', at)?.path, '/srv/devdash/projects/shop/Makefile')
  assert.equal(codeFile('.env', at)?.path, '/srv/devdash/projects/shop/.env')
  assert.equal(codeFile('.env.local', at)?.path, '/srv/devdash/projects/shop/.env.local')
  assert.equal(codeFile('logs/server.log', at)?.path, '/srv/devdash/projects/shop/logs/server.log')
  assert.equal(codeFile('src/app/[id]/page.tsx', at)?.path, '/srv/devdash/projects/shop/src/app/[id]/page.tsx')

  for (const code of ['npm test', 'origin/main', 'feat/login', 'useState', 'console.log', 'process.env','example.com', 'v1.2.3', 'docs/v1.2', 'src/**/*.ts',
    '--no-verify', '@types/node', 'https://x.io/a.md', 'a b.md', 'foo()', 'express.json()', 'and/or', '/api/files/read', 'x.y', 'src/', '']) {
    assert.equal(codeFile(code, at), null, code)
  }
  assert.equal(codeFile('docs/guide.md', {}), null, 'relative paths need the session folder')
})

test('links to files open; web links do not', () => {
  assert.deepEqual(hrefFile('docs/guide.md', at), { path: '/srv/devdash/projects/shop/docs/guide.md', line: undefined })
  assert.deepEqual(hrefFile('./src/a.ts#L12', at), { path: '/srv/devdash/projects/shop/src/a.ts', line: 12 })
  assert.deepEqual(hrefFile('file:///srv/x/My%20Notes.md', at), { path: '/srv/x/My Notes.md', line: undefined })
  assert.deepEqual(hrefFile('/srv/devdash/projects/shop/src', at), { path: '/srv/devdash/projects/shop/src', line: undefined })
  assert.deepEqual(hrefFile('~/a.md:3', at), { path: '/home/ann/a.md', line: 3 })
  for (const href of ['https://example.com/a.md', 'http://x', 'mailto:a@b.c', '#section', '//cdn.x/a.js', 'www.example.com', 'tel:123', '']) {
    assert.equal(hrefFile(href, at), null, href)
  }
})

test('helpers', () => {
  assert.equal(normalize('/a/./b/../c//d/'), '/a/c/d')
  assert.deepEqual(splitLine('a.ts:9'), { path: 'a.ts', line: 9 })
  assert.deepEqual(splitLine('a.ts'), { path: 'a.ts' })
  assert.equal(folderOf('/srv/x/a.md'), '/srv/x')
  assert.equal(folderOf('/a.md'), '/')
  assert.equal(fileKind('PLAN.MD').kind, 'markdown')
  assert.deepEqual(fileKind('logo.svg'), { kind: 'image', mime: 'image/svg+xml' })
  assert.equal(fileKind('report.pdf').kind, 'pdf')
  assert.equal(fileKind('Dockerfile').kind, 'text')
})

test('after Claude moves (cd, a worktree), its relative paths are tried from where it was, the session folder, then the main checkout', () => {
  const moved = { cwd: '/srv/devdash/worktrees/games/ab12/games/puzzle', base: '/srv/devdash/worktrees/games/ab12', username: 'ann' }
  assert.deepEqual(codeFile('build/puzzle-debug.apk', moved), {
    path: '/srv/devdash/worktrees/games/ab12/games/puzzle/build/puzzle-debug.apk', line: undefined,
    also: [
      '/srv/devdash/worktrees/games/ab12/build/puzzle-debug.apk',
      '/srv/devdash/projects/games/games/puzzle/build/puzzle-debug.apk',
      '/srv/devdash/projects/games/build/puzzle-debug.apk',
    ],
  })
  assert.equal(hrefFile('store/LISTING.md#L3', moved)?.also?.[0], '/srv/devdash/worktrees/games/ab12/store/LISTING.md')
  // Absolute and home paths have one place only; so does a session in a project's own checkout that never moved.
  assert.deepEqual(codeFile('/tmp/shot.png', moved), { path: '/tmp/shot.png', line: undefined })
  assert.deepEqual(resolvePaths('~/a.txt', moved), ['/home/ann/a.txt'])
  assert.deepEqual(resolvePaths('a.txt', { cwd: '/x', base: '/x' }), ['/x/a.txt'])
  assert.equal(codeFile('docs/guide.md', at)?.also, undefined)
})

test('a bare name is also tried in the folders the same reply names, and searched for under the project', () => {
  const where = { cwd: '/srv/devdash/worktrees/games/ab12', username: 'ann' }
  const text = 'Saved the store art to `/srv/devdash/projects/games/builds/puzzle/play-store/`:\n- `1-app-icon-512.png`\n- see also docs/ADS.md'
  const near = foldersIn(text, where)
  assert.deepEqual(near, ['/srv/devdash/projects/games/builds/puzzle/play-store', '/srv/devdash/worktrees/games/ab12/docs'])
  assert.ok(codeFile('1-app-icon-512.png', { ...where, near })?.also?.includes('/srv/devdash/projects/games/builds/puzzle/play-store/1-app-icon-512.png'))
  assert.deepEqual(lookIn({ ...where, near }), [...near, '/srv/devdash/projects/games', '/srv/devdash/worktrees/games/ab12'])
  assert.equal(mainCheckout('/srv/devdash/worktrees/games/ab12/games/x'), '/srv/devdash/projects/games/games/x')
  assert.equal(mainCheckout('/srv/devdash/projects/games'), undefined)
  // Web links and plain words aren't folders.
  assert.deepEqual(foldersIn('see https://example.com/a/b and and/or', where), [])
})

test('files Claude worked on come first for a name that ends their path', () => {
  const touched = ['/srv/p/builds/puzzle/play-store/1-app-icon-512.png', '/srv/p/builds/arcade/play-store/1-app-icon-512.png', '/srv/p/src/a.ts']
  assert.deepEqual(knownFor('1-app-icon-512.png', touched), touched.slice(0, 2))
  assert.deepEqual(knownFor('play-store/1-app-icon-512.png:3', touched), touched.slice(0, 2))
  assert.deepEqual(knownFor('src/a.ts', touched), ['/srv/p/src/a.ts'])
  assert.deepEqual(knownFor('/srv/p/src/a.ts', touched), [])
  assert.deepEqual(knownFor('a.ts.bak', touched), [])
})
