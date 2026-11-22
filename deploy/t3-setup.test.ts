import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readServicePort } from './t3-setup.mjs'

test('readServicePort parses valid loopback DEVDASH_T3_PORT and rejects invalid values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-t3-port-'))
  try {
    const file = join(dir, 't3-service.env')
    assert.equal(readServicePort(file), null)
    await writeFile(file, '# comment\nDEVDASH_T3_PORT=3789\n', { mode: 0o600 })
    assert.equal(readServicePort(file), 3789)
    await writeFile(file, 'DEVDASH_T3_PORT=80\n', { mode: 0o600 })
    assert.equal(readServicePort(file), null)
    await writeFile(file, 'DEVDASH_T3_PORT=notaport\n', { mode: 0o600 })
    assert.equal(readServicePort(file), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function setupFixture() {
  const { default: assert } = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  const { chmod, mkdir, readFile, stat, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { connectOrRenewT3, disconnectT3 } = await import('./deploy/t3-setup.mjs')

  const root = fileURLToPath(new URL('.', import.meta.url))
  const cli = join(root, 'fake-t3.mjs')
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const a = process.argv.slice(2)
appendFileSync(process.env.DD_SETUP_LOG, JSON.stringify(a) + '\\n')
if (a[0] === 'auth' && a[1] === 'pairing' && a[2] === 'create') {
  process.stdout.write(JSON.stringify({ id: 'pairing-setup', credential: 'setup-pairing-code' }))
}
`,
    { mode: 0o755 },
  )

  let seq = 0
  let verifier = ''
  const http = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/mcp/register') {
      res.end(JSON.stringify({ client_id: 'client-setup' }))
    } else if (req.url === '/oauth/mcp/decision') {
      const { authorization } = JSON.parse(body)
      verifier = authorization.code_challenge
      res.end(JSON.stringify({ redirectTo: `${authorization.redirect_uri}?code=auth-code&state=${encodeURIComponent(authorization.state)}` }))
    } else if (req.url === '/oauth/mcp/token') {
      seq += 1
      const sid = `session-v${seq}`
      const token = `${Buffer.from(JSON.stringify({ sid })).toString('base64url')}.sig-${seq}`
      assert.ok(verifier)
      res.end(JSON.stringify({ token_type: 'Bearer', access_token: token, expires_in: 86400 }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/mcp`

  try {
    const dir = join(root, 'home')
    const baseDir = join(dir, 't3-data')
    const config = join(dir, 't3code.json')
    const log = join(dir, 'cli.jsonl')
    await mkdir(baseDir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    process.env.DD_SETUP_LOG = log

    // 1. Initial connect
    const first = await connectOrRenewT3({ t3Bin: cli, baseDir, url, config })
    assert.equal(first.renewed, false)
    assert.equal(first.revokedOld, false)
    const cfg1 = JSON.parse(await readFile(config, 'utf8'))
    assert.equal(cfg1.url, url)
    assert.equal((await stat(config)).mode & 0o777, 0o600)

    // 2. Atomic renewal replaces config and revokes old session
    const second = await connectOrRenewT3({ t3Bin: cli, baseDir, url, config })
    assert.equal(second.renewed, true)
    assert.equal(second.revokedOld, true)
    const cfg2 = JSON.parse(await readFile(config, 'utf8'))
    assert.notEqual(cfg2.token, cfg1.token)
    assert.equal((await stat(config)).mode & 0o777, 0o600)

    // 3. Disconnect revokes active session and deletes config; second call is idempotent
    const disc1 = await disconnectT3({ t3Bin: cli, baseDir, config })
    assert.deepEqual(disc1, { removed: true, revoked: true })
    await assert.rejects(readFile(config), { code: 'ENOENT' })
    const disc2 = await disconnectT3({ t3Bin: cli, baseDir, config })
    assert.deepEqual(disc2, { removed: false, revoked: false })

    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[])
    assert.ok(calls.some((a) => a[0] === 'auth' && a[1] === 'session' && a[2] === 'revoke' && a.at(-1) === 'session-v1'))
    assert.ok(calls.some((a) => a[0] === 'auth' && a[1] === 'session' && a[2] === 'revoke' && a.at(-1) === 'session-v2'))
  } finally {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}

test('T3 setup helper connects, atomically renews with old-session revocation, and disconnects cleanly', { timeout: 20000 }, async (t) => {
  if (process.platform !== 'linux' || !process.getuid) { t.skip('Linux member socket ownership is required'); return }
  const uid = process.getuid() === 0 ? 65001 : process.getuid()
  if (uid < 1000 || uid >= 65534) { t.skip('requires an ordinary member UID or root to start one'); return }
  const dir = await mkdtemp(join(tmpdir(), 'dd-t3-setup-'))
  try {
    await mkdir(join(dir, 'deploy'))
    await mkdir(join(dir, 'apps/agent/src'), { recursive: true })
    await copyFile(new URL('./t3-connect.mjs', import.meta.url), join(dir, 'deploy/t3-connect.mjs'))
    await copyFile(new URL('./t3-setup.mjs', import.meta.url), join(dir, 'deploy/t3-setup.mjs'))
    await copyFile(new URL('../apps/agent/src/t3-local.ts', import.meta.url), join(dir, 'apps/agent/src/t3-local.ts'))
    await copyFile(new URL('../apps/agent/src/t3-client.ts', import.meta.url), join(dir, 'apps/agent/src/t3-client.ts'))
    await writeFile(join(dir, 'fixture.ts'), `await (${setupFixture.toString()})()\n`)
    if (process.getuid() === 0) await chown(dir, uid, uid)
    await chmod(dir, 0o700)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, 'fixture.ts')], {
        ...(process.getuid!() === 0 ? { uid, gid: uid } : {}),
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr.on('data', (data: Buffer) => { output += data.toString() })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output || `fixture exited ${code}`)))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('t3-setup.mjs CLI executes main() even when invoked through a symlinked release path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-t3-symlink-'))
  try {
    const link = join(dir, 'current')
    await symlink(new URL('..', import.meta.url).pathname, link)
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(link, 'deploy/t3-setup.mjs'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)))
    })
    assert.match(out, /DevDash T3 Code setup helper/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
