import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isKey, openTeamFiles } from './team-files.ts'

test("a member's private files in a shared project open to the team; keys and tool folders stay as they are", async () => {
  const root = mkdtempSync('/tmp/dd-team-files-')
  chmodSync(root, 0o2775) // like /srv/devdash/projects itself
  try {
    const project = join(root, 'shop')
    mkdirSync(join(project, 'backend'), { recursive: true })
    mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true })
    const env = join(project, 'backend', '.env')
    const key = join(project, 'deploy.pem')
    const dep = join(project, 'node_modules', 'pkg', 'secret.txt')
    for (const f of [env, key, dep]) { writeFileSync(f, 'x'); chmodSync(f, 0o600) }
    chmodSync(join(project, 'backend'), 0o700)
    const mode = (p: string) => statSync(p).mode & 0o7777

    // A folder its owner marked private keeps its permissions.
    const backup = join(project, 'server-backup')
    mkdirSync(backup)
    writeFileSync(join(backup, '.devdash-private'), '')
    writeFileSync(join(backup, 'shadow'), 'x')
    chmodSync(join(backup, 'shadow'), 0o600)

    assert.equal(await openTeamFiles([root]), 2) // the .env and its folder
    assert.equal(mode(join(backup, 'shadow')), 0o600, 'a private folder is left alone')
    assert.equal(mode(env), 0o660, 'the project .env: the team can read and write it')
    assert.equal(mode(join(project, 'backend')) & 0o2070, 0o2070, 'its folder too, keeping the group')
    assert.equal(mode(key), 0o600, 'a private key stays private')
    assert.equal(mode(dep), 0o600, 'node_modules is not looked at')
    assert.equal(await openTeamFiles([root]), 0, 'nothing left to change')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('what counts as a private key', () => {
  for (const n of ['deploy.pem', 'server.key', 'id_ed25519', 'id_rsa', 'release.keystore']) assert.equal(isKey(n), true, n)
  for (const n of ['.env', '.env.prod', 'id_ed25519.pub', 'keys.json', 'monkey.txt']) assert.equal(isKey(n), false, n)
})
