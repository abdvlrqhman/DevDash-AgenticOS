import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, chown, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tokenSessionId } from './t3-connect.mjs'

const payload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

test('T3 cleanup reads the native signed payload and JWT claims, never a JWT header', () => {
  assert.equal(tokenSessionId(`${payload({ sid: 'session-native' })}.signature`), 'session-native')
  assert.equal(tokenSessionId(`${payload({ sid: 'header-decoy' })}.${payload({ sid: 'session-jwt' })}.signature`), 'session-jwt')
  for (const token of ['', 'opaque', 'bad.signature', `${payload({})}.sig`, `${payload({ sid: '../bad' })}.sig`, `${payload({ sid: 123 })}.sig`]) {
    assert.equal(tokenSessionId(token), null)
  }
})

// Run the complete helper with an actual HTTP peer and fake CLI as an ordinary Linux user.
// The fixture copies only these two source files, with no home, service environment or real T3 state.
async function helperFixture() {
  const { default: assert } = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  const { chmod, mkdir, readFile, stat, symlink, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { connectT3 } = await import('./deploy/t3-connect.mjs')
  const root = fileURLToPath(new URL('.', import.meta.url))
  const cli = join(root, 'fake-t3.mjs')
  await writeFile(cli, `#!${process.execPath}\nimport{appendFileSync}from'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.DD_FIXTURE_LOG,JSON.stringify(a)+'\\n');if(a[2]==='create')process.stdout.write(JSON.stringify({id:'pairing-fixture',credential:'fixture-pairing'}));\n`, { mode: 0o755 })
  let mode = '', output = '', requests: string[] = [], verifier = ''
  const token = `${Buffer.from(JSON.stringify({ sid: 'session-fixture' })).toString('base64url')}.fixture-signature`
  const http = createServer(async (req, res) => {
    requests.push(req.url!)
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/mcp/register') {
      assert.equal(JSON.parse(body).token_endpoint_auth_method, 'none')
      res.end(JSON.stringify({ client_id: 'client-fixture' }))
    } else if (req.url === '/oauth/mcp/decision') {
      const { authorization, decision } = JSON.parse(body)
      assert.equal(decision.code, 'fixture-pairing')
      assert.equal(decision.access, 'full-access')
      verifier = authorization.code_challenge
      const redirect = new URL(authorization.redirect_uri)
      redirect.searchParams.set('code', 'code-fixture')
      redirect.searchParams.set('state', mode === 'callback' ? 'wrong-state' : authorization.state)
      res.end(JSON.stringify({ redirectTo: redirect.href }))
    } else if (req.url === '/oauth/mcp/token') {
      const params = new URLSearchParams(body)
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded')
      assert.equal(params.get('code'), 'code-fixture')
      const { createHash } = await import('node:crypto')
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), verifier)
      if (mode === 'collision') await mkdir(output)
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: mode === 'metadata' ? 'invalid' : 3600 }))
    } else { res.writeHead(404).end() }
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => http.once('listening', resolve))
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  try {
    for (const scenario of ['success', 'collision', 'callback', 'metadata', 'existing']) {
      mode = scenario; requests = []
      const dir = join(root, scenario), base = join(dir, 'base')
      await mkdir(base, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      output = join(dir, 't3code.json')
      const log = join(dir, 'cli.jsonl')
      process.env.DD_FIXTURE_LOG = log
      if (scenario === 'existing') await symlink('/does-not-exist', output)
      const action = connectT3({ t3Bin: cli, baseDir: base, url, config: output })
      if (scenario === 'success') {
        const result = await action
        assert.equal(result.config, output)
        const config = JSON.parse(await readFile(output, 'utf8'))
        assert.equal(config.token, token)
        assert.equal(config.url, `${url}/mcp`)
        assert.equal(config.baseDir, base)
        const info = await stat(output)
        assert.equal(info.mode & 0o777, 0o600)
        assert.equal(info.uid, process.getuid!())
      } else {
        await assert.rejects(action, scenario === 'callback' ? /callback validation/ : scenario === 'metadata' ? /valid bearer/ : scenario === 'existing' ? /already exists/ : /EEXIST/)
      }
      if (scenario === 'existing') {
        assert.deepEqual(requests, [])
        await assert.rejects(readFile(log), { code: 'ENOENT' })
        continue
      }
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
      assert(calls[0]!.includes(base))
      assert(calls[0]!.includes('settings:write'))
      assert(calls.some((args) => args[0] === 'auth' && args[1] === 'pairing' && args[2] === 'revoke' && args.at(-1) === 'pairing-fixture'))
      assert.equal(calls.some((args) => args[1] === 'session' && args[2] === 'revoke' && args.at(-1) === 'session-fixture'), ['collision', 'metadata'].includes(scenario))
      if (scenario === 'collision') assert((await stat(output)).isDirectory())
      if (scenario === 'callback') assert.equal(requests.includes('/oauth/mcp/token'), false)
    }
  } finally {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}

test('T3 member helper validates OAuth, writes a private config and revokes unused grants', { timeout: 20000 }, async (t) => {
  if (process.platform !== 'linux' || !process.getuid) { t.skip('Linux member socket ownership is required'); return }
  const uid = process.getuid() === 0 ? 65001 : process.getuid()
  if (uid < 1000 || uid >= 65534) { t.skip('requires an ordinary member UID or root to start one'); return }
  const dir = await mkdtemp(join(tmpdir(), 'dd-t3-helper-'))
  try {
    await mkdir(join(dir, 'deploy'))
    await mkdir(join(dir, 'apps/agent/src'), { recursive: true })
    await copyFile(new URL('./t3-connect.mjs', import.meta.url), join(dir, 'deploy/t3-connect.mjs'))
    await copyFile(new URL('../apps/agent/src/t3-local.ts', import.meta.url), join(dir, 'apps/agent/src/t3-local.ts'))
    await writeFile(join(dir, 'fixture.ts'), `await (${helperFixture.toString()})()\n`)
    if (process.getuid() === 0) await chown(dir, uid, uid)
    await chmod(dir, 0o700)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, 'fixture.ts')], {
        ...(process.getuid!() === 0 ? { uid, gid: uid } : {}),
        env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr.on('data', (data: Buffer) => { output += data.toString() })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output || `fixture exited ${code}`)))
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
