import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyName, dbOf, isCopy, parseEnv, setEnv } from './worktree-db.ts'

test('env files: plain, quoted, exported and commented values', () => {
  const env = parseEnv('# db\nDATABASE_URL="postgres://u:p@127.0.0.1:5432/shop"\nexport DEVDASH_WORKTREE_DB=DATABASE_URL\nREDIS=redis://x # cache\nBAD LINE\n')
  assert.equal(env.get('DATABASE_URL'), 'postgres://u:p@127.0.0.1:5432/shop')
  assert.equal(env.get('DEVDASH_WORKTREE_DB'), 'DATABASE_URL')
  assert.equal(env.get('REDIS'), 'redis://x')
  assert.equal(env.size, 3)
})

test("a worktree's env points at its own database; nothing else in the file changes", () => {
  const text = 'A=1\nDATABASE_URL="postgres://u:p@127.0.0.1:5432/shop" # main\nexport DATABASE_URL=postgres://old\nDATABASE_URL_RO=keep\n'
  assert.equal(setEnv(text, 'DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/shop_wt_ab12'),
    'A=1\nDATABASE_URL="postgres://u:p@127.0.0.1:5432/shop_wt_ab12" # main\nexport DATABASE_URL=postgres://u:p@127.0.0.1:5432/shop_wt_ab12\nDATABASE_URL_RO=keep\n')
})

test('Postgres URLs: the database name, and the same URL on another database (driver suffixes kept)', () => {
  const d = dbOf('postgresql+asyncpg://user:p%40ss@127.0.0.1:5433/task_team?sslmode=disable')!
  assert.equal(d.name, 'task_team')
  assert.equal(d.on('task_team_wt_ab12'), 'postgresql+asyncpg://user:p%40ss@127.0.0.1:5433/task_team_wt_ab12?sslmode=disable')
  assert.equal(dbOf('postgres://u@localhost/shop')!.on('postgres'), 'postgres://u@localhost/postgres')
  for (const bad of ['mysql://u@h/db', 'postgres://u@h/', 'postgres://u@h', 'redis://h:6379/0', 'not a url']) assert.equal(dbOf(bad), null, bad)
})

test("copies are named after their worktree, fit Postgres's 63 bytes, and only they are ever dropped", () => {
  assert.equal(copyName('Shop', 'ab12cd34'), 'shop_wt_ab12cd34')
  const long = copyName('x'.repeat(80), 'ab12cd34')
  assert.equal(long.length, 63)
  assert.ok(long.endsWith('_wt_ab12cd34'))
  assert.ok(isCopy('shop_wt_ab12cd34'))
  for (const name of ['shop', 'postgres', 'shop_wt_', 'shop_wt_AB12', 'shop_wt_ab12/x']) assert.equal(isCopy(name), false, name)
})
