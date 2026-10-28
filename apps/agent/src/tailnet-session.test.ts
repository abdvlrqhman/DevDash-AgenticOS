import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net'
import { socksConnect, startForwarder } from './tailnet-session.ts'

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

/** A minimal no-auth SOCKS5 proxy that CONNECTs to the requested host:port and pipes both ways. */
function fakeSocks() {
  const server = createServer((c) => {
    let stage = 0
    let buf = Buffer.alloc(0)
    c.on('data', (chunk) => {
      if (stage === 2) return
      buf = Buffer.concat([buf, chunk])
      if (stage === 0) {
        if (buf.length < 2) return
        c.write(Buffer.from([0x05, 0x00])) // no-auth accepted
        stage = 1
        buf = buf.subarray(buf[1]! + 2)
      }
      if (stage === 1) {
        if (buf.length < 5 || buf[3] !== 0x03) return
        const len = buf[4]!
        if (buf.length < 7 + len) return
        const host = buf.subarray(5, 5 + len).toString()
        const port = buf.readUInt16BE(5 + len)
        const rest = buf.subarray(7 + len)
        stage = 2
        const up = createConnection({ host, port }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // success, bound 0.0.0.0:0
          if (rest.length) up.write(rest)
          c.pipe(up)
          up.pipe(c)
        })
        up.on('error', () => c.destroy())
      }
    })
    c.on('error', () => c.destroy())
  })
  return server
}

test('socksConnect reaches a target through a SOCKS5 proxy and round-trips data', async () => {
  // echo target
  const target = createServer((s: Socket) => s.pipe(s))
  const targetPort = await listen(target)
  const socks = fakeSocks()
  const socksPort = await listen(socks)

  const sock = await socksConnect(socksPort, '127.0.0.1', targetPort)
  const reply = await new Promise<string>((resolve) => {
    sock.once('data', (d) => resolve(d.toString()))
    sock.write('ping')
  })
  assert.equal(reply, 'ping')
  sock.destroy()
  target.close()
  socks.close()
})

test('startForwarder exposes a localhost port that tunnels through the proxy to the target', async () => {
  const target = createServer((s: Socket) => s.write('hello from tailnet'))
  const targetPort = await listen(target)
  const socks = fakeSocks()
  const socksPort = await listen(socks)

  const fwd = await startForwarder(socksPort, '127.0.0.1', targetPort)
  assert.ok(fwd.port > 0)
  const got = await new Promise<string>((resolve, reject) => {
    const c = createConnection({ host: '127.0.0.1', port: fwd.port })
    c.once('data', (d) => { resolve(d.toString()); c.destroy() })
    c.once('error', reject)
  })
  assert.equal(got, 'hello from tailnet')
  fwd.close()
  target.close()
  socks.close()
})
