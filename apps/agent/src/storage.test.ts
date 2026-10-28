import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, driveFolder, note, remove, withoutRemote, withRemote, type Storage } from './storage.ts'

const URL_ = 'http://127.0.0.1:8787/internal/storage/token'
const s: Storage = { remote: 'drive', account: 'bob@gmail.com', folderId: 'F1abc', handle: `ddh_${'a'.repeat(43)}`, tokenUrl: URL_ }
const OWN = '# my remotes\n[s3]\ntype = s3\nprovider = AWS\n'

test("the Drive remote goes in next to the member's own remotes, with a handle instead of any Google secret", () => {
  const text = withRemote(OWN, s)!
  assert.ok(text.startsWith('# my remotes\n[s3]\ntype = s3\nprovider = AWS\n'))
  assert.match(text, /\n\[drive\]\ntype = drive\n/)
  assert.match(text, /\nscope = drive\.file\nroot_folder_id = F1abc\ntoken_url = http:\/\/127\.0\.0\.1:8787\/internal\/storage\/token\n/)
  const token = JSON.parse(/\ntoken = (.*)\n/.exec(text)![1]!) as Record<string, string>
  // rclone drops a refresh token that comes with an empty access token, so there is always a placeholder.
  assert.deepEqual(token, { access_token: 'devdash', token_type: 'Bearer', refresh_token: s.handle, expiry: '2000-01-01T00:00:00Z' })

  // Already right (rclone has since cached a real access token there): left alone.
  const cached = text.replace(/"access_token":"devdash"/, '"access_token":"ya29.real"')
  assert.equal(withRemote(cached, s), null)
  // A new handle (they reconnected) or folder rewrites just that section.
  const next = withRemote(cached, { ...s, handle: `ddh_${'b'.repeat(43)}` })!
  assert.equal(next.match(/\[drive\]/g)!.length, 1)
  assert.ok(next.includes('[s3]') && !next.includes('ya29.real'))
})

test("removing takes out only DevDash's remote, never a member's own remote of the same name", () => {
  const text = withRemote(OWN, s)!
  assert.equal(withoutRemote(text, 'drive', URL_), '# my remotes\n[s3]\ntype = s3\nprovider = AWS\n')
  const theirs = `${OWN}\n[drive]\ntype = drive\nscope = drive\n`
  assert.equal(withoutRemote(theirs, 'drive', URL_), null)
  assert.equal(withRemote('', s)!.startsWith('[drive]\n'), true)
  assert.equal(withoutRemote(withRemote('', s)!, 'drive', URL_), '')
})

test('configure writes the rclone config privately and refuses values that could break out of the INI file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-rclone-'))
  process.env.RCLONE_CONFIG = join(dir, 'sub', 'rclone.conf')
  try {
    assert.equal(await configure(s), true)
    assert.equal(statSync(process.env.RCLONE_CONFIG).mode & 0o777, 0o600)
    assert.equal(await configure(s), false) // nothing to change
    writeFileSync(process.env.RCLONE_CONFIG, `${OWN}\n${readFileSync(process.env.RCLONE_CONFIG, 'utf8')}`)
    await assert.rejects(() => configure({ ...s, folderId: 'F1\n[evil]' }), /invalid/)
    await assert.rejects(() => configure({ ...s, tokenUrl: 'https://evil.example/token' }), /invalid/)
    assert.equal(await remove('drive', URL_), true)
    assert.equal(readFileSync(process.env.RCLONE_CONFIG, 'utf8'), OWN)
  } finally {
    delete process.env.RCLONE_CONFIG
  }
})

test('Claude gets a rule for anything heavy, not a recipe for one kind of file, filed under the session\'s project', () => {
  const n = note(s, 'my-app')
  assert.match(n, /Heavy files belong in bob@gmail\.com's Google Drive/)
  assert.match(n, /on your own initiative/)
  for (const kind of ['videos', 'audio', 'exported builds', 'datasets', 'backups', 'archives']) assert.ok(n.includes(kind), kind)
  assert.match(n, /never upload \.env files, keys or credentials/)
  assert.match(n, /this session's folder is `drive:my-app\/`/)
  assert.match(n, /rclone move <file> drive:my-app\/<kind>\/ --drive-chunk-size 128M/)
  assert.match(n, /archive first/)
  assert.match(note(null), /heavy files .* connect their Google Drive on DevDash's Storage page/)
})

test("a session's Drive folder is its project, or its own folder's name", () => {
  assert.equal(driveFolder('/srv/devdash/projects/games'), 'games')
  assert.equal(driveFolder('/srv/devdash/projects/games/apps/web'), 'games')
  assert.equal(driveFolder('/srv/devdash/worktrees/shop/7e122970'), 'shop')
  assert.equal(driveFolder(`${homedir()}/sessions/Trailer edit`), 'Trailer-edit')
  assert.equal(driveFolder(homedir()), 'files')
  assert.equal(driveFolder(`${homedir()}/`), 'files')
})
