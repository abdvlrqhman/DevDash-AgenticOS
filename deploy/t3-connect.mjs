#!/usr/bin/env node
// Run as the member who owns the local T3 instance. Never export another user's T3 authority.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { assertMemberEndpoint, assertRegularMemberUid, memberFetch, validateMemberUrl } from '../apps/agent/src/t3-local.ts'

const runFile = promisify(execFile)
// T3 0.1.9's full-access OAuth grant requires exactly this bundle, including settings/source-control.
// They are confined to this member-owned instance. The server has no supported narrower full-access grant.
const scopes = ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write']

function options(argv) {
  const result = { t3Bin: 't3', url: null, config: null, baseDir: null }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--help' || key === '-h') return null
    if (!['--t3-bin', '--url', '--config', '--base-dir'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Usage: node deploy/t3-connect.mjs --base-dir /home/member/.local/share/devdash-t3 --url http://127.0.0.1:<port> --config /home/member/.config/devdash/t3code.json [--t3-bin /path/to/t3]')
    }
    result[{ '--t3-bin': 't3Bin', '--url': 'url', '--config': 'config', '--base-dir': 'baseDir' }[key]] = argv[++i]
  }
  if (!result.config || !result.baseDir || !result.url) throw new Error('--base-dir, --url and --config are required. Use this member’s own private T3 directory and local listener.')
  return result
}

function endpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid local T3 server URL.') }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp'
  return validateMemberUrl(url.href).href
}

async function privateDirectory(path, uid) {
  const directory = resolve(path)
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('T3 data and connection config directories must be private (0700), real directories owned by this Linux member.')
  }
  await access(directory, constants.W_OK)
  return realpath(directory)
}

async function t3Json(t3Bin, baseDir, args) {
  let stdout
  try {
    ({ stdout } = await runFile(t3Bin, ['auth', ...args.slice(0, 2), '--base-dir', baseDir, ...args.slice(2)], { cwd: baseDir, timeout: 30_000, maxBuffer: 1024 * 1024 }))
  } catch { throw new Error('T3 authentication command failed. Check this member’s T3 executable and private data directory.') }
  try { return JSON.parse(stdout) } catch { throw new Error('T3 authentication command returned invalid JSON.') }
}

async function revoke(t3Bin, baseDir, kind, id) {
  await runFile(t3Bin, ['auth', kind, 'revoke', '--base-dir', baseDir, id], { cwd: baseDir, timeout: 30_000, maxBuffer: 1024 * 1024 })
}

async function post(mcp, path, body, form = false) {
  // Verify again immediately before any request carrying a pairing credential or authorization code.
  await assertMemberEndpoint(mcp)
  let response
  try {
    response = await memberFetch(new URL(path, mcp).href, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    })
  } catch { throw new Error(`Could not reach the member’s T3 OAuth endpoint ${path}.`) }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`T3 OAuth endpoint ${path} returned HTTP ${response.status}.`) }
  try { return await response.json() } catch { throw new Error(`T3 OAuth endpoint ${path} returned invalid JSON.`) }
}

/** T3 0.1.9 uses payload.signature, not a JWT header.payload.signature. Also accept JWT if a later version adopts it. */
export function tokenSessionId(token) {
  try {
    const parts = token.split('.')
    const payload = parts.length === 2 ? parts[0] : parts.length === 3 ? parts[1] : null
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof claims.sid === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(claims.sid) ? claims.sid : null
  } catch { return null }
}

/** Mint a separately revocable credential only for a listener and private T3 directory owned by this Linux member. */
export async function connectT3({ t3Bin = 't3', url, config, baseDir }) {
  const uid = assertRegularMemberUid(process.getuid?.())
  if (!config || !baseDir || !url) throw new Error('--base-dir, --url and --config are required.')
  const mcp = endpoint(url)
  const base = await privateDirectory(baseDir, uid)
  const output = resolve(config)
  // Refuse an existing destination, including symlinks, before issuing any credentials.
  try { await lstat(output); throw new Error('The config destination already exists. Choose a new file or revoke the old credential explicitly.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await privateDirectory(dirname(output), uid)
  await assertMemberEndpoint(mcp)

  let pairing, issuedToken
  let saved = false, createdFile = false
  try {
    pairing = await t3Json(t3Bin, base, ['pairing', 'create', '--ttl', '5m', '--label', 'DevDash member connection', ...scopes.flatMap(scope => ['--scope', scope]), '--json'])
    if (typeof pairing.credential !== 'string' || typeof pairing.id !== 'string') throw new Error('T3 returned an invalid pairing credential.')
    const redirectUri = 'http://127.0.0.1/devdash-t3-callback'
    const client = await post(mcp, '/oauth/mcp/register', {
      client_name: 'DevDash member T3 Code connection', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    })
    if (typeof client.client_id !== 'string') throw new Error('T3 did not return an OAuth client ID.')
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('base64url')
    const authorization = {
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: mcp, state,
    }
    const decision = await post(mcp, '/oauth/mcp/decision', { authorization, decision: { _tag: 'pairing-code', access: 'full-access', code: pairing.credential } })
    let redirect
    try { redirect = new URL(decision.redirectTo) } catch { throw new Error('T3 did not return a valid OAuth callback.') }
    const expected = new URL(redirectUri)
    if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname || redirect.searchParams.get('state') !== state || !redirect.searchParams.get('code') || redirect.searchParams.has('error')) throw new Error('T3 OAuth callback validation failed.')
    const result = await post(mcp, '/oauth/mcp/token', {
      grant_type: 'authorization_code', code: redirect.searchParams.get('code'), redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier, resource: mcp,
    }, true)
    // Keep a returned token available for revocation even if the remaining grant metadata is invalid.
    if (typeof result.access_token === 'string') issuedToken = result.access_token
    if (!issuedToken?.trim() || /[\r\n]/.test(issuedToken) || result.token_type !== 'Bearer' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('T3 did not return a valid bearer credential.')
    const expiry = new Date(Date.now() + result.expires_in * 1000)
    if (!Number.isFinite(expiry.getTime())) throw new Error('T3 did not return a valid bearer expiry.')
    const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    createdFile = true
    try { await handle.writeFile(`${JSON.stringify({ url: mcp, token: issuedToken, baseDir: base }, null, 2)}\n`); await handle.sync() }
    finally { await handle.close() }
    saved = true
    return { config: output, expiresAt: expiry.toISOString() }
  } finally {
    if (pairing?.id) {
      try { await revoke(t3Bin, base, 'pairing', pairing.id) }
      catch { process.stderr.write('The temporary T3 pairing credential could not be revoked; it expires after five minutes.\n') }
    }
    if (!saved && issuedToken) {
      const sessionId = tokenSessionId(issuedToken)
      if (sessionId) {
        try { await revoke(t3Bin, base, 'session', sessionId) }
        catch { process.stderr.write('The unused member T3 session could not be revoked. Revoke the DevDash connection in this member’s T3 settings.\n') }
      } else process.stderr.write('The unused member T3 session could not be identified. Revoke the DevDash connection in this member’s T3 settings.\n')
    }
    if (!saved && createdFile) await unlink(output).catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2))
    if (!args) process.stdout.write('Run as the member: node deploy/t3-connect.mjs --base-dir /home/member/.local/share/devdash-t3 --url http://127.0.0.1:<port> --config /home/member/.config/devdash/t3code.json [--t3-bin /path/to/t3]\n')
    else {
      const result = await connectT3(args)
      process.stdout.write(`Member T3 connection saved with mode 0600: ${result.config}\nCredential expires: ${result.expiresAt}\n`)
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
