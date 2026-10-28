import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trustFolder } from './claude.ts'

test("a session's folder is trusted for Claude Code, without disturbing the rest of its config", () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'))
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ theme: 'dark', projects: { '/a': { allowedTools: ['Bash'] } } }))
  trustFolder(file, '/a')
  trustFolder(file, '/home/ann/projects/new')
  const c = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(c.theme, 'dark')
  assert.deepEqual(c.projects['/a'], { allowedTools: ['Bash'], hasTrustDialogAccepted: true })
  assert.deepEqual(c.projects['/home/ann/projects/new'], { hasTrustDialogAccepted: true })

  writeFileSync(file, '{ half written')
  trustFolder(file, '/b')
  assert.equal(readFileSync(file, 'utf8'), '{ half written', "a config it can't read is left alone")

  const fresh = join(dir, 'none.json')
  trustFolder(fresh, '/c')
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).projects['/c'].hasTrustDialogAccepted, true)
})
