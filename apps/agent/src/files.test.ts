import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ops } from './files.ts'

test('find: files with a name under the given folders, newest first, skipping dependencies and git', async () => {
  const root = mkdtempSync('/tmp/dd-find-')
  try {
    const put = (rel: string, at: number) => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), 'x')
      utimesSync(join(root, rel), at, at)
    }
    put('builds/arcade/play-store/icon.png', 1_000)
    put('builds/puzzle/play-store/icon.png', 2_000)
    put('node_modules/pkg/icon.png', 3_000)
    put('.git/icon.png', 3_000)
    const { paths } = await ops.find({ name: 'icon.png', dirs: [root, join(root, 'builds')] })
    assert.deepEqual(paths, [join(root, 'builds/puzzle/play-store/icon.png'), join(root, 'builds/arcade/play-store/icon.png')])
    assert.deepEqual((await ops.find({ name: 'missing.png', dirs: [root] })).paths, [])
    await assert.rejects(ops.find({ name: '../etc/passwd', dirs: [root] }), /file name/)
    // Folders DevDash can't show are left out, not searched.
    assert.deepEqual((await ops.find({ name: 'passwd', dirs: ['/etc'] })).paths, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
