import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { search } from './mentions.ts'

test('@ mentions: names that start with the query come first, folders end in /, node_modules is skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-'))
  for (const f of ['src/app/main.ts', 'src/mainframe.ts', 'docs/domain.md', 'node_modules/main/index.js', 'README.md']) {
    mkdirSync(join(root, f, '..'), { recursive: true })
    writeFileSync(join(root, f), '')
  }
  assert.deepEqual(await search(root, 'main'), ['src/mainframe.ts', 'src/app/main.ts', 'docs/domain.md'])
  assert.deepEqual((await search(root, '')).slice(0, 3), ['src/', 'docs/', 'README.md'])
  assert.ok((await search(root, 'app')).includes('src/app/'))
})
