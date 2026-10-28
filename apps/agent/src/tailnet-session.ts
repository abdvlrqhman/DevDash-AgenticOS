// Routing one Claude session through this member's userspace Tailscale node.
// The session's shell tools get the SOCKS/HTTP proxy in their env; this module adds the two pieces that need code:
//   - socksConnect/startForwarder: a dependency-free local TCP→SOCKS5 forwarder, so the SDK's HTTP MCP client (which
//     can't reach a userspace 100.x address itself) talks to a tailnet MCP through the proxy.
//   - writeSshHelper: a tiny `tailnet-connect` script for `ssh -o ProxyCommand`, put on the session's PATH.
// Everything here runs AS THE MEMBER (the agent is the member), so it can use the owner's isolated proxy; nobody else can.
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Opens a TCP connection to host:port through a no-auth SOCKS5 proxy at 127.0.0.1:socksPort. Resolves with the
 * connected socket (any bytes the peer already sent are pushed back onto it). Pure over the network, so it is tested.
 */
export function socksConnect(socksPort: number, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: '127.0.0.1', port: socksPort })
    const fail = (e: Error) => { s.destroy(); reject(e) }
    s.once('error', fail)
    s.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00]))) // greeting: SOCKS5, one method, no auth
    let stage = 0
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error('SOCKS5 proxy refused the no-auth method'))
        const hb = Buffer.from(host)
        // CONNECT, reserved 0, address type 3 (domain name), len, host, port (big-endian).
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([port >> 8, port & 0xff])]))
        stage = 1
        buf = buf.subarray(2)
      }
      if (stage === 1) {
        if (buf.length < 5) return
        const atyp = buf[3]
        const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + buf[4]! : 0
        if (!need || buf.length < need) return
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 connect failed (reply 0x${(buf[1] ?? 0xff).toString(16)})`))
        s.removeListener('data', onData)
        s.removeListener('error', fail)
        const rest = buf.subarray(need)
        if (rest.length) s.unshift(rest)
        resolve(s)
      }
    }
    s.on('data', onData)
  })
}

export type Forwarder = { port: number; close: () => void }

/**
 * A local TCP server on 127.0.0.1 that pipes every connection through the SOCKS5 proxy to host:port. Returns the
 * ephemeral port it listened on and a close(). Used to make a userspace tailnet MCP reachable at a plain localhost URL.
 */
export function startForwarder(socksPort: number, host: string, port: number): Promise<Forwarder> {
  const server = createServer((client) => {
    client.on('error', () => client.destroy())
    socksConnect(socksPort, host, port).then(
      (up) => {
        const end = () => { client.destroy(); up.destroy() }
        up.on('error', end)
        client.on('close', end)
        up.on('close', end)
        client.pipe(up)
        up.pipe(client)
      },
      () => client.destroy(),
    )
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() })
    })
  })
}

// Does this box's `nc` understand `-X 5 -x` (OpenBSD-style SOCKS5)? GNU netcat does not, so we fall back to Node.
async function ncHasSocks(): Promise<boolean> {
  try {
    const { stdout, stderr } = await run('nc', ['-h'], { timeout: 4000 })
    return /-X\b/.test(stdout + stderr)
  } catch (err) {
    // `nc -h` exits non-zero on some builds but still prints usage to stderr.
    const out = String((err as { stderr?: string }).stderr ?? '')
    return /-X\b/.test(out)
  }
}

/**
 * Writes an executable `tailnet-connect <host> <port>` helper into `dir` and returns its directory (to prepend to the
 * session's PATH). It pipes a TCP stream through the member's SOCKS5 proxy, for `ssh -o ProxyCommand="tailnet-connect %h %p"`.
 * Prefers `nc -X 5` when available, else a dependency-free Node forwarder.
 */
export async function writeSshHelper(dir: string, socksPort: number): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'tailnet-connect')
  const script = (await ncHasSocks())
    ? `#!/bin/sh\n# DevDash: ssh ProxyCommand via this member's Tailscale SOCKS5 proxy.\nexec nc -X 5 -x 127.0.0.1:${socksPort} "$1" "$2"\n`
    : `#!/usr/bin/env node\n// DevDash: ssh ProxyCommand via this member's Tailscale SOCKS5 proxy. Pipes stdio to\n// <host> <port> over SOCKS5, no auth.\nconst net = require('node:net')\nconst [host, port] = [process.argv[2], Number(process.argv[3])]\nconst s = net.createConnection({ host: '127.0.0.1', port: ${socksPort} })\ns.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])))\nlet stage = 0, buf = Buffer.alloc(0)\ns.on('data', (chunk) => {\n  if (stage === 2) return\n  buf = Buffer.concat([buf, chunk])\n  if (stage === 0) {\n    if (buf.length < 2) return\n    if (buf[0] !== 0x05 || buf[1] !== 0x00) { process.exit(1) }\n    const hb = Buffer.from(host)\n    s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([port >> 8, port & 0xff])]))\n    stage = 1; buf = buf.subarray(2)\n  }\n  if (stage === 1) {\n    if (buf.length < 5) return\n    const atyp = buf[3]\n    const need = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + buf[4] : 0\n    if (!need || buf.length < need) return\n    if (buf[1] !== 0x00) process.exit(1)\n    const rest = buf.subarray(need)\n    stage = 2\n    if (rest.length) process.stdout.write(rest)\n    process.stdin.pipe(s); s.pipe(process.stdout)\n  }\n})\ns.on('error', () => process.exit(1))\ns.on('close', () => process.exit(0))\n`
  await writeFile(file, script, { mode: 0o700 })
  await chmod(file, 0o700)
  return dir
}
