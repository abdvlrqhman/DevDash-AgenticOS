import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { T3Client, validateConfig } from './t3-client.ts'

const token = 'test-secret-bearer'
type Json = { id?: number; method: string; params?: Record<string, unknown> }
async function server(onTool: (body: Json, res: ServerResponse) => void, options: { sse?: boolean } = {}) {
  const seen: { method: string; session?: string; protocol?: string }[] = []
  const http = createServer(async (req: IncomingMessage, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    seen.push({ method: req.method!, session: req.headers['mcp-session-id'] as string | undefined, protocol: req.headers['mcp-protocol-version'] as string | undefined })
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as Json
    if (body.method === 'initialize') {
      res.setHeader('mcp-session-id', 'session-1')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }))
    } else if (body.method === 'notifications/initialized') {
      assert.equal(req.headers['mcp-session-id'], 'session-1')
      res.writeHead(202).end()
    } else {
      assert.equal(req.headers['mcp-session-id'], 'session-1')
      res.setHeader('content-type', options.sse ? 'text/event-stream' : 'application/json')
      onTool(body, res)
    }
  }).listen(0, '127.0.0.1')
  await new Promise<void>((r) => http.once('listening', r))
  return {
    seen, url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`,
    close: async () => { http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())) },
  }
}

test('T3 connection config requires a bearer and a literal member-owned loopback endpoint', () => {
  for (const url of ['http://example.com/mcp', 'ftp://localhost/mcp', 'http://localhost/mcp', 'http://[::1]/mcp', 'https://example.com/mcp', 'https://user:password@example.com/mcp', 'http://127.0.0.1/mcp?token=bad', 'http://127.0.0.1/mcp#secret']) {
    assert.throws(() => validateConfig({ url, token }), /T3 Code/)
  }
  assert.equal(validateConfig({ url: 'http://127.0.0.1:3773/mcp', token }).url, 'http://127.0.0.1:3773/mcp')
  assert.throws(() => validateConfig({ url: 'http://127.0.0.1:3773/mcp', token: '\nsecret' }), /bearer/)
})

test('T3 MCP handshake, lazy concurrent callers, typed results and session cleanup', async () => {
  const s = await server((body, res) => {
    assert.deepEqual(body.params, { name: 't3_project_list', arguments: { limit: 1 } })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { projects: [{ id: 'one' }] } } }))
  })
  const client = new T3Client({ url: s.url, token })
  try {
    const results = await Promise.all([client.call('t3_project_list', { limit: 1 }), client.call('t3_project_list', { limit: 1 })])
    assert.deepEqual(results, [{ projects: [{ id: 'one' }] }, { projects: [{ id: 'one' }] }])
    assert.equal(s.seen.length, 4, 'one initialize and one initialized for both calls')
    await client.close()
    assert.equal(s.seen.at(-1)?.method, 'DELETE')
    assert.equal(s.seen.at(-1)?.session, 'session-1')
  } finally { await s.close() }
})

test('T3 MCP reads SSE responses without waiting for the server to close the stream', async () => {
  const s = await server((body, res) => {
    res.write(': heartbeat\r\n\r\n')
    res.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n')
    res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\r\n\r\n`)
  }, { sse: true })
  const client = new T3Client({ url: s.url, token }, { timeoutMs: 2000 })
  try { assert.deepEqual(await client.call('probe'), { ok: true }) } finally { await client.close(); await s.close() }
})

test('T3 MCP errors redact tokens and HTTP response bodies are never surfaced', async () => {
  let variant = 0
  const s = await server((body, res) => {
    if (variant === 0) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: `bad ${token}` }] } }))
    if (variant === 1) res.writeHead(401).end(`private body ${token}`)
    if (variant === 2) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: `bad ${token}` } }))
    if (variant === 3) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id! + 1, result: {} }))
  })
  const client = new T3Client({ url: s.url, token })
  try {
    await assert.rejects(client.call('probe'), /bad \[redacted\]/)
    variant = 1
    await assert.rejects(client.call('probe'), /^Error: T3 Code MCP returned HTTP 401\.$/)
    variant = 2
    await assert.rejects(client.call('probe'), /bad \[redacted\]/)
    variant = 3
    await assert.rejects(client.call('probe'), /mismatched/)
  } finally { await client.close(); await s.close() }
})

test('T3 MCP request timeout is bounded and a mutation is not retried', async () => {
  let calls = 0
  const s = await server(() => { calls++ })
  const client = new T3Client({ url: s.url, token }, { timeoutMs: 2000 })
  try {
    await client.connect()
    await assert.rejects(client.call('t3_thread_send', { message: 'one' }), /timed out/)
    assert.equal(calls, 1)
  } finally { await client.close(); await s.close() }
})
