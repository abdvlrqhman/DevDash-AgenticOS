import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTailscaleIp, parseHttpResponse } from './pc-bridge.ts'

describe('pc-bridge', () => {
  it('accepts only Tailscale CGNAT 100.64.0.0/10 IPv4 addresses', () => {
    assert.equal(isTailscaleIp('100.64.0.1'), true)
    assert.equal(isTailscaleIp('100.67.118.37'), true)
    assert.equal(isTailscaleIp('100.111.214.117'), true)
    assert.equal(isTailscaleIp('100.127.255.254'), true)

    assert.equal(isTailscaleIp('100.63.255.255'), false)
    assert.equal(isTailscaleIp('100.128.0.1'), false)
    assert.equal(isTailscaleIp('127.0.0.1'), false)
    assert.equal(isTailscaleIp('192.168.1.10'), false)
    assert.equal(isTailscaleIp('169.254.169.254'), false)
    assert.equal(isTailscaleIp('8.8.8.8'), false)
    assert.equal(isTailscaleIp('not-an-ip'), false)
  })

  it('parses JSON Content-Length HTTP responses', () => {
    const body = JSON.stringify({ ok: true, hostname: 'DESKTOP-TEST' })
    const raw = Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      'utf8',
    )
    const res = parseHttpResponse(raw)
    assert.equal(res.httpStatus, 200)
    assert.deepEqual(res.data, { ok: true, hostname: 'DESKTOP-TEST' })
  })

  it('parses chunked HTTP responses', () => {
    const body = '{"ok":true,"count":2}'
    const hex = Buffer.byteLength(body).toString(16)
    const raw = Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${hex}\r\n${body}\r\n0\r\n\r\n`,
      'utf8',
    )
    const res = parseHttpResponse(raw)
    assert.equal(res.httpStatus, 200)
    assert.deepEqual(res.data, { ok: true, count: 2 })
  })
})
