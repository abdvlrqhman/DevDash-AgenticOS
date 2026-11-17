import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertMemberEndpoint, assertOwnedConnection, assertOwnedListener, assertRegularMemberUid, listenerUids, memberFetch, validateMemberUrl } from './t3-local.ts'

const row = (address: string, port: number, uid: number, state = '0A') => ` 0: ${address}:${port.toString(16).padStart(4, '0').toUpperCase()} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 123 1`

test('T3 local endpoints reject remote, root-oriented aliases and alternate paths', () => {
  assert.equal(validateMemberUrl('http://127.0.0.1:3781/mcp').port, '3781')
  for (const url of ['https://127.0.0.1:3781/mcp', 'http://localhost:3781/mcp', 'http://[::1]:3781/mcp', 'https://example.com/mcp', 'http://127.0.0.1:3781/', 'http://127.0.0.1:3781/mcp?x=1', 'http://127.0.0.1:3781/mcp#x', 'http://user:pass@127.0.0.1:3781/mcp']) {
    assert.throws(() => validateMemberUrl(url), /T3 Code/)
  }
})

test('T3 listener ownership checks reject root, another member, ambiguous sockets and absent listeners', () => {
  assertRegularMemberUid(1001)
  for (const uid of [0, 999, 65534, -1, NaN, undefined]) assert.throws(() => assertRegularMemberUid(uid), /regular DevDash member/)
  assertOwnedListener(row('0100007F', 3781, 1001), '', 3781, 1001)
  assertOwnedListener(row('00000000', 3781, 1001), '', 3781, 1001)
  assertOwnedListener('', row('00000000000000000000000000000000', 3781, 1001), 3781, 1001)
  assertOwnedListener('', row('0000000000000000FFFF00000100007F', 3781, 1001), 3781, 1001)
  assert.deepEqual(listenerUids(`${row('0100007F', 3781, 1001)}\n${row('0100007F', 3782, 0)}\n${row('0100007F', 3781, 0, '01')}`, '', 3781), [1001])
  assert.throws(() => assertOwnedListener(row('0100007F', 3781, 0), '', 3781, 1001), /belongs to root or another/)
  assert.throws(() => assertOwnedListener(row('0100007F', 3781, 1002), '', 3781, 1001), /belongs to root or another/)
  assert.throws(() => assertOwnedListener(row('0100007F', 3781, 1001), row('00000000000000000000000000000000', 3781, 1002), 3781, 1001), /belongs to root or another/)
  assert.throws(() => assertOwnedListener('', '', 3781, 1001), /No local T3 Code listener/)
})

test('T3 verifies the real local socket owner and refuses a listener which has gone away', async (t) => {
  if (!process.getuid || process.getuid() < 1000 || process.getuid() >= 65534) { t.skip('positive real-socket check runs in the unprivileged test job'); return }
  const http = createServer((_req, res) => res.end()).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => http.once('listening', resolve))
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
  try { await assertMemberEndpoint(url) } finally { await new Promise<void>((resolve) => http.close(() => resolve())) }
  await assert.rejects(assertMemberEndpoint(url), /No local T3 Code listener/)
})


test('T3 connected-peer checks match the reverse established tuple and reject a port-rebind owner change', () => {
  const established = (uid: number, server = 3781, client = 45000) => `0: 0100007F:${server.toString(16).padStart(4, '0')} 0100007F:${client.toString(16).padStart(4, '0')} 01 0:0 00:0 0 ${uid} 0 123`
  assertOwnedConnection(established(1001), '', 3781, 45000, 1001)
  assert.throws(() => assertOwnedConnection(established(0), '', 3781, 45000, 1001), /No credentials were sent/)
  assert.throws(() => assertOwnedConnection(established(1002), '', 3781, 45000, 1001), /No credentials were sent/)
  assert.throws(() => assertOwnedConnection(established(1001, 3782), '', 3781, 45000, 1001), /No credentials were sent/)
  assert.throws(() => assertOwnedConnection(established(1001, 3781, 45001), '', 3781, 45000, 1001), /No credentials were sent/)
})

test('T3 verified member transport supports headers, body, SSE cancellation and never follows redirects', async (t) => {
  if (!process.getuid || process.getuid() < 1000 || process.getuid() >= 65534) { t.skip('positive transport check runs as an unprivileged member'); return }
  let requests = 0
  const http = createServer(async (req, res) => {
    requests++
    assert.equal(req.headers.authorization, 'Bearer fixture-token')
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.method === 'POST') { assert.equal(body, 'hello'); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hello\n\n') }
    else res.writeHead(302, { location: '/mcp?redirected=1' }).end()
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => http.once('listening', resolve))
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
  const controller = new AbortController()
  try {
    const response = await memberFetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-token' }, body: 'hello', signal: controller.signal })
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: hello\n\n')
    controller.abort()
    await assert.rejects(reader.read(), /abort/i)
    const redirect = await memberFetch(url, { method: 'GET', headers: { Authorization: 'Bearer fixture-token' }, signal: AbortSignal.timeout(3000) })
    assert.equal(redirect.status, 302)
    await redirect.body?.cancel()
    assert.equal(requests, 2)
  } finally { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())) }
})

test('T3 root and different-user listeners receive zero HTTP headers', async (t) => {
  if (process.getuid?.() !== 0) { t.skip('cross-UID process test requires the isolated root test job'); return }
  const dir = await mkdtemp('/var/tmp/dd-t3-owner-')
  await chmod(dir, 0o755)
  await copyFile(new URL('./t3-local.ts', import.meta.url), join(dir, 't3-local.ts'))
  const moduleUrl = pathToFileURL(join(dir, 't3-local.ts')).href
  const probe = (url: string) => new Promise<void>((resolve, reject) => {
    const code = `import {memberFetch} from ${JSON.stringify(moduleUrl)}; try { await memberFetch(${JSON.stringify(url)}, {method:'POST',headers:{Authorization:'Bearer fixture-secret'},body:'credential-body',signal:AbortSignal.timeout(3000)});process.exitCode=1 } catch(e) { if(!/belongs to root or another/.test(e.message)) { console.error(e.message);process.exitCode=1 } }`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { uid: 65001, gid: 65001, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', (data: Buffer) => { error += data.toString() })
    child.on('error', reject)
    child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(error || 'cross-user connection was not rejected')))
  })
  let rootHeaders = 0
  const root = createServer((_req, res) => { rootHeaders++; res.end() }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => root.once('listening', resolve))
  const other = spawn(process.execPath, ['--input-type=module', '-e', `import{createServer}from'node:http';let headers=0;const s=createServer((q,r)=>{headers++;r.end()}).listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));process.on('message',()=>process.send({headers}));`], { uid: 65002, gid: 65002, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  try {
    const port = await new Promise<number>((resolve, reject) => { other.once('message', (m) => resolve((m as { port: number }).port)); other.once('error', reject) })
    await probe(`http://127.0.0.1:${(root.address() as { port: number }).port}/mcp`)
    await probe(`http://127.0.0.1:${port}/mcp`)
    assert.equal(rootHeaders, 0)
    const count = new Promise<number>((resolve) => other.once('message', (m) => resolve((m as { headers: number }).headers)))
    other.send('count')
    assert.equal(await count, 0)
  } finally {
    other.kill()
    root.closeAllConnections()
    await new Promise<void>((resolve) => root.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
