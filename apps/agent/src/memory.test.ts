import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

// homedir() follows HOME (USERPROFILE on Windows), read at call time.
const home = mkdtempSync(join(tmpdir(), 'devdash-mem-'))
process.env.HOME = home
process.env.USERPROFILE = home
const { configure, enabled } = await import('./memory.ts')
const settings = () => JSON.parse(readFileSync(join(home, '.claude-mem', 'settings.json'), 'utf8'))

test('claude-mem settings: own port, no Chroma, the profile login; the member\'s own values stay', () => {
  configure('default')
  assert.deepEqual(settings(), { CLAUDE_MEM_WORKER_PORT: String(37000 + userInfo().uid), CLAUDE_MEM_CHROMA_ENABLED: 'false' })

  writeFileSync(join(home, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '39999', CLAUDE_MEM_CHROMA_ENABLED: 'true', CLAUDE_MEM_MODEL: 'x' }))
  configure('work')
  assert.deepEqual(settings(), {
    CLAUDE_MEM_WORKER_PORT: '39999', CLAUDE_MEM_CHROMA_ENABLED: 'true', CLAUDE_MEM_MODEL: 'x',
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: join(home, '.claude-profiles', 'work'),
  })
})

test('claude-mem counts as on only when the profile enables the plugin', () => {
  assert.equal(enabled('default'), false)
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': false } }))
  assert.equal(enabled('default'), false)
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }))
  assert.equal(enabled('default'), true)
  assert.equal(enabled('work'), false)
})
