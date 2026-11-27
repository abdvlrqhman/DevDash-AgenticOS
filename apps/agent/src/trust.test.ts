import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { heldByWakeups, trustFolder } from './claude.ts'

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

test('an idle session stays open while a wakeup or loop it scheduled is still due', () => {
  const H = 3_600_000
  assert.equal(heldByWakeups([], H), false, 'nothing scheduled: closes as idle')
  assert.equal(heldByWakeups([{ recurring: false }], H), true, 'ScheduleWakeup within the hour')
  assert.equal(heldByWakeups([{ recurring: false }], 3 * H), false, 'a one-shot long overdue: stale')
  assert.equal(heldByWakeups([{ recurring: true }], 48 * H), true, 'a /loop every day')
  assert.equal(heldByWakeups([{ recurring: true }], 8 * 24 * H), false, "past Claude Code's 7-day expiry")
})
