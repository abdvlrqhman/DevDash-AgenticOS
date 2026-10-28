import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const HELPER = new URL('./devdash-helper.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function call(req: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HELPER], {
    input: typeof req === 'string' ? req : JSON.stringify(req) + '\n',
    env: { ...process.env, DEVDASH_HELPER_DRYRUN: '1', ...env },
    encoding: 'utf8',
  })
  return JSON.parse(r.stdout) as { ok: boolean; error?: string; created?: boolean; planned: string[] }
}

const ok = { username: 'alice', name: 'Alice Smith', email: 'alice@example.com', admin: false }

test('creates a new member with argv-only commands', () => {
  const r = call({ cmd: 'user-ensure', args: ok })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.planned[0], 'useradd --create-home --shell /bin/bash --user-group --comment Alice Smith alice')
  assert.ok(r.planned.includes('usermod -aG devdash-users alice'))
  assert.ok(!r.planned.some((c) => c.includes('-aG sudo')), 'members get no sudo')
  assert.equal(r.planned.at(-1), 'systemctl enable --now devdash-agent@alice.socket')
})

test('admins get sudo; existing regular accounts are adopted, system accounts refused', () => {
  const adopt = call({ cmd: 'user-ensure', args: { ...ok, admin: true } }, { DEVDASH_HELPER_FAKE_UID: '1000' })
  assert.equal(adopt.ok, true)
  assert.equal(adopt.created, false)
  assert.ok(adopt.planned.includes('usermod -aG sudo alice'))
  assert.ok(!adopt.planned.some((c) => c.startsWith('useradd')))
  const sys = call({ cmd: 'user-ensure', args: ok }, { DEVDASH_HELPER_FAKE_UID: '33' })
  assert.match(sys.error!, /refused: existing account is not a regular user/)
})

test('rejects bad input and unknown commands', () => {
  for (const username of ['root', 'devdash-build', 'Alice', 'a;rm -rf /', '../x', 'systemd-x']) {
    assert.match(call({ cmd: 'user-ensure', args: { ...ok, username } }).error!, /refused: invalid username/, username)
  }
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, name: 'Eve\nroot' } }).error!, /refused: invalid text/)
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, name: 'a:b' } }).error!, /refused: invalid text/)
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, email: 'x@y' } }).error!, /refused: invalid email/)
  assert.match(call({ cmd: 'sh', args: {} }).error!, /refused: unknown command/)
  assert.match(call({ cmd: 'constructor', args: {} }).error!, /refused: unknown command/)
  assert.match(call('not json\n').error!, /refused/)
  const noEmail = call({ cmd: 'user-ensure', args: { ...ok, email: undefined } })
  assert.equal(noEmail.ok, true, 'email is optional')
  assert.ok(!noEmail.planned.some((c) => c.includes('git config')), 'no git identity without an email')
})

test('set-password: validated, sent to chpasswd on stdin (never on the command line)', () => {
  const r = call({ cmd: 'set-password', args: { username: 'alice', password: 'correct horse' } }, { DEVDASH_HELPER_FAKE_UID: '1000' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.planned, ['chpasswd <stdin>'])
  assert.ok(!JSON.stringify(r.planned).includes('correct horse'))
  assert.match(call({ cmd: 'set-password', args: { username: 'alice', password: '' } }, { DEVDASH_HELPER_FAKE_UID: '1000' }).error!, /refused/)
  assert.match(call({ cmd: 'set-password', args: { username: 'alice', password: 'a:b long enough' } }, { DEVDASH_HELPER_FAKE_UID: '1000' }).error!, /refused/)
  assert.match(call({ cmd: 'set-password', args: { username: 'root', password: 'long enough pw' } }).error!, /refused: invalid username/)
  assert.match(call({ cmd: 'set-password', args: { username: 'alice', password: 'long enough pw' } }, { DEVDASH_HELPER_FAKE_UID: '33' }).error!, /refused: not a member/)
})

test('deploy: only full commit ids, one at a time, in the background', () => {
  const sha = 'a'.repeat(40)
  const r = call({ cmd: 'deploy', args: { sha } })
  assert.equal(r.ok, true)
  assert.equal(r.planned.at(-1), `systemctl start --no-block devdash-deploy@${sha}.service`)
  assert.ok(r.planned[0].startsWith('systemctl list-units'), 'checks for a running deploy first')
  for (const bad of ['main', 'a'.repeat(12), 'A'.repeat(40), `${'a'.repeat(39)};`, `${'a'.repeat(40)} x`, 42]) {
    assert.match(call({ cmd: 'deploy', args: { sha: bad } }).error!, /refused: not a full commit id/, String(bad))
    assert.match(call({ cmd: 'deploy-status', args: { sha: bad } }).error!, /refused: not a full commit id/, String(bad))
  }
  const s = call({ cmd: 'deploy-status', args: { sha } }) as unknown as { ok: boolean; ran: boolean; planned: string[] }
  assert.equal(s.ok, true)
  assert.equal(s.ran, false)
  assert.deepEqual(s.planned, [])
})

test('tailnet-isolate: owner-match REJECT rules per port, uid resolved from the username (not trusted)', () => {
  const r = call({ cmd: 'tailnet-isolate', args: { username: 'alice', ports: [41000, 41001] } }, { DEVDASH_HELPER_FAKE_UID: '1000' })
  assert.equal(r.ok, true)
  // -C (check) then -A (append) for each port, with ! --uid-owner <resolved uid>.
  assert.deepEqual(r.planned, [
    'iptables -C OUTPUT -o lo -p tcp --dport 41000 -m owner ! --uid-owner 1000 -j REJECT',
    'iptables -A OUTPUT -o lo -p tcp --dport 41000 -m owner ! --uid-owner 1000 -j REJECT',
    'iptables -C OUTPUT -o lo -p tcp --dport 41001 -m owner ! --uid-owner 1000 -j REJECT',
    'iptables -A OUTPUT -o lo -p tcp --dport 41001 -m owner ! --uid-owner 1000 -j REJECT',
  ])
})

test('tailnet-unisolate: removes the same rules (-D)', () => {
  const r = call({ cmd: 'tailnet-unisolate', args: { username: 'alice', ports: [41000] } }, { DEVDASH_HELPER_FAKE_UID: '1000' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.planned, [
    'iptables -C OUTPUT -o lo -p tcp --dport 41000 -m owner ! --uid-owner 1000 -j REJECT',
    'iptables -D OUTPUT -o lo -p tcp --dport 41000 -m owner ! --uid-owner 1000 -j REJECT',
  ])
})

test('tailnet-isolate: validates username, uid is a member account, and the ports', () => {
  assert.match(call({ cmd: 'tailnet-isolate', args: { username: 'root', ports: [41000] } }).error, /refused: invalid username/)
  assert.match(call({ cmd: 'tailnet-isolate', args: { username: 'alice', ports: [41000] } }).error, /refused: not a member account/) // no FAKE_UID: unknown account
  assert.match(call({ cmd: 'tailnet-isolate', args: { username: 'alice', ports: [80] } }, { DEVDASH_HELPER_FAKE_UID: '1000' }).error, /refused: invalid port/)
  assert.match(call({ cmd: 'tailnet-isolate', args: { username: 'alice', ports: [] } }, { DEVDASH_HELPER_FAKE_UID: '1000' }).error, /refused: give 1-8 ports/)
  assert.match(call({ cmd: 'tailnet-isolate', args: { username: 'alice', ports: 41000 } }, { DEVDASH_HELPER_FAKE_UID: '1000' }).error, /refused: give 1-8 ports/)
})

test('claude-update starts the update unit without waiting; its status is read-only', () => {
  const r = call({ cmd: 'claude-update' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.planned, ['systemctl start --no-block devdash-claude-update.service'])
  const s = call({ cmd: 'claude-update-status' }) as unknown as { ok: boolean; state: string; planned: string[] }
  assert.equal(s.ok, true)
  assert.equal(s.state, 'inactive')
  assert.deepEqual(s.planned, [])
})
