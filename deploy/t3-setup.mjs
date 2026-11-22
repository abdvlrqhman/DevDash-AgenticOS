#!/usr/bin/env node
// Interactive & scriptable setup helper for a member's own T3 Code connection.
// Runs strictly as the Linux member (never root). Credentials stay in ~/.config/devdash/t3code.json (0600).
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync, readFileSync } from 'node:fs'
import { access, lstat, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { assertMemberEndpoint, assertRegularMemberUid } from '../apps/agent/src/t3-local.ts'
import { T3Client, readConfig } from '../apps/agent/src/t3-client.ts'
import { connectT3, tokenSessionId } from './t3-connect.mjs'

const runFile = promisify(execFile)
const DEFAULT_T3_BIN = '/opt/devdash/t3code/current/t3'

/** Reads DEVDASH_T3_PORT from the member's private t3-service.env if present. */
export function readServicePort(envFile) {
  try {
    const raw = readFileSync(envFile, 'utf8')
    const match = raw.match(/^\s*DEVDASH_T3_PORT\s*=\s*(\d{2,5})\s*$/m)
    if (!match) return null
    const port = Number(match[1])
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

/** Resolves default member paths for T3 Code, respecting explicit overrides and DEVDASH_T3_* env vars. */
export function resolveT3Paths(overrides = {}) {
  const home = overrides.home ?? (() => { try { return homedir() } catch { return overrides.config ? dirname(resolve(overrides.config)) : process.cwd() } })()
  const config = resolve(overrides.config ?? process.env.DEVDASH_T3_CONFIG ?? join(home, '.config', 'devdash', 't3code.json'))
  const envFile = resolve(overrides.envFile ?? join(home, '.config', 'devdash', 't3-service.env'))
  let existing = null
  try {
    existing = JSON.parse(readFileSync(config, 'utf8'))
  } catch { /* no existing config yet */ }

  const baseDir = resolve(
    overrides.baseDir
    ?? process.env.DEVDASH_T3_BASE_DIR
    ?? (typeof existing?.baseDir === 'string' ? existing.baseDir : join(home, '.local', 'share', 'devdash-t3')),
  )
  const t3Bin = overrides.t3Bin
    ?? process.env.DEVDASH_T3_BIN
    ?? (existsSync(DEFAULT_T3_BIN) ? DEFAULT_T3_BIN : 't3')

  const envPort = readServicePort(envFile)
  const port = overrides.port ? Number(overrides.port) : envPort
  const url = overrides.url
    ?? (port ? `http://127.0.0.1:${port}/mcp` : (typeof existing?.url === 'string' ? existing.url : null))

  return { home, config, envFile, baseDir, t3Bin, port, url }
}

async function revokeSession(t3Bin, baseDir, sessionId) {
  if (!sessionId) return false
  try {
    await runFile(t3Bin, ['auth', 'session', 'revoke', '--base-dir', baseDir, sessionId], {
      cwd: baseDir, timeout: 15_000, maxBuffer: 1024 * 1024,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Connects DevDash to this member's local T3 Code instance, or safely renews an existing connection:
 * mints the new credential to a unique 0600 temp file first, atomically swaps it in, then revokes the old session.
 */
export async function connectOrRenewT3(opts = {}) {
  const uid = assertRegularMemberUid(process.getuid?.())
  const paths = resolveT3Paths(opts)
  if (!paths.url) {
    throw new Error(
      `No local T3 Code port found (checked ${paths.envFile}). Click "Connect T3 Code" in Agent setup or ask an admin to enable devdash-t3 for your account.`,
    )
  }

  let existingInfo = null
  try {
    existingInfo = await lstat(paths.config)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  if (!existingInfo) {
    const res = await connectT3({ t3Bin: paths.t3Bin, baseDir: paths.baseDir, url: paths.url, config: paths.config })
    return { ...res, renewed: false, revokedOld: false, url: paths.url, baseDir: paths.baseDir }
  }

  if (!existingInfo.isFile() || existingInfo.isSymbolicLink() || existingInfo.uid !== uid) {
    throw new Error(`Refusing to replace ${paths.config}: expected a regular file owned by your Linux account.`)
  }

  let oldSessionId = null
  let oldBaseDir = paths.baseDir
  try {
    const old = JSON.parse(readFileSync(paths.config, 'utf8'))
    if (typeof old?.token === 'string') oldSessionId = tokenSessionId(old.token)
    if (typeof old?.baseDir === 'string') oldBaseDir = old.baseDir
  } catch { /* ignore unreadable old file */ }

  const tmp = join(dirname(paths.config), `.t3code.json.new-${randomBytes(8).toString('hex')}`)
  try {
    const res = await connectT3({ t3Bin: paths.t3Bin, baseDir: paths.baseDir, url: paths.url, config: tmp })
    await rename(tmp, paths.config)
    const revokedOld = oldSessionId ? await revokeSession(paths.t3Bin, oldBaseDir, oldSessionId) : false
    return { config: paths.config, expiresAt: res.expiresAt, renewed: true, revokedOld, url: paths.url, baseDir: paths.baseDir }
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** Revokes this member's DevDash OAuth session in T3 Code (best-effort) and deletes their t3code.json. */
export async function disconnectT3(opts = {}) {
  const uid = assertRegularMemberUid(process.getuid?.())
  const paths = resolveT3Paths(opts)
  let info
  try {
    info = await lstat(paths.config)
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, revoked: false }
    throw err
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) {
    throw new Error(`Refusing to remove ${paths.config}: expected a regular file owned by your Linux account.`)
  }
  let oldSessionId = null
  let oldBaseDir = paths.baseDir
  try {
    const old = JSON.parse(readFileSync(paths.config, 'utf8'))
    if (typeof old?.token === 'string') oldSessionId = tokenSessionId(old.token)
    if (typeof old?.baseDir === 'string') oldBaseDir = old.baseDir
  } catch { /* proceed with unlink */ }

  const revoked = oldSessionId ? await revokeSession(paths.t3Bin, oldBaseDir, oldSessionId) : false
  await unlink(paths.config)
  return { removed: true, revoked }
}

async function probeLive(configPathOverride) {
  const prev = process.env.DEVDASH_T3_CONFIG
  if (configPathOverride) process.env.DEVDASH_T3_CONFIG = configPathOverride
  const client = new T3Client(readConfig(), { timeoutMs: 8_000 })
  try {
    await client.connect({ timeoutMs: 8_000 })
    const caps = await client.call('orchestrator_capabilities', {}, { timeoutMs: 8_000 })
    const providers = (caps?.providers ?? []).filter((p) => p.canRunChildTask === true && (p.models?.length ?? 0) > 0)
    return {
      version: client.serverVersion,
      providers: providers.map((p) => ({
        id: p.providerInstanceId,
        name: p.displayName ?? p.providerInstanceId,
        models: p.models.length,
      })),
    }
  } finally {
    await client.close().catch(() => {})
    if (configPathOverride) {
      if (prev === undefined) delete process.env.DEVDASH_T3_CONFIG
      else process.env.DEVDASH_T3_CONFIG = prev
    }
  }
}

function runInteractiveChild(bin, args, cwd) {
  return new Promise((resolveCode) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit' })
    child.on('exit', (code) => resolveCode(code ?? 1))
    child.on('error', () => resolveCode(1))
  })
}

function parseCli(argv) {
  const out = { cmd: 'connect', interactive: false, json: false, t3Bin: undefined, url: undefined, port: undefined, baseDir: undefined, config: undefined }
  let i = 0
  if (argv[0] && !argv[0].startsWith('-')) {
    out.cmd = argv[0]
    i = 1
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') return null
    if (a === '--interactive' || a === '-i') { out.interactive = true; continue }
    if (a === '--json') { out.json = true; continue }
    const map = { '--t3-bin': 't3Bin', '--url': 'url', '--port': 'port', '--base-dir': 'baseDir', '--config': 'config' }
    if (!map[a] || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete option: ${a}`)
    }
    out[map[a]] = argv[++i]
  }
  if (!['connect', 'pair', 'status', 'disconnect'].includes(out.cmd)) {
    throw new Error(`Unknown command "${out.cmd}". Use: connect, pair, status, or disconnect.`)
  }
  return out
}

async function pauseIfInteractive(interactive, paths, offerPair = false) {
  if (!interactive || !process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (offerPair) {
      const answer = (await rl.question('\nPress [p] to print a T3 pairing code/QR, or Enter to close this tab: ')).trim().toLowerCase()
      if (answer === 'p') {
        rl.close()
        console.log('')
        await runInteractiveChild(paths.t3Bin, ['pair', '--base-dir', paths.baseDir, '--label', 'DevDash setup'], paths.baseDir)
        const rl2 = createInterface({ input: process.stdin, output: process.stdout })
        try { await rl2.question('\nPress Enter to close this tab. ') } finally { rl2.close() }
        return
      }
      return
    }
    await rl.question('\nPress Enter to close this tab. ')
  } finally {
    rl.close()
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2))
  if (!cli) {
    console.log([
      'DevDash T3 Code setup helper (run as your Linux member account)',
      '',
      'Usage: node deploy/t3-setup.mjs [connect|pair|status|disconnect] [options]',
      '',
      'Commands:',
      '  connect      Connect DevDash to your local T3 Code instance (or renew credential)',
      '  pair         Print a one-time pairing token & QR code to open T3 Code and connect providers',
      '  status       Check your local T3 binary, service listener, config, and connected providers',
      '  disconnect   Revoke the DevDash OAuth session in T3 Code and remove t3code.json',
      '',
      'Options:',
      '  --interactive    Keep output open and prompt before closing (used in DevDash Terminal)',
      '  --port <port>    Override local loopback port',
      '  --url <url>      Override local T3 MCP URL',
      '  --base-dir <dir> Override private T3 data directory',
      '  --config <path>  Override t3code.json path',
      '  --t3-bin <path>  Override T3 binary path',
    ].join('\n'))
    return
  }

  const paths = resolveT3Paths(cli)

  if (cli.cmd === 'status') {
    console.log('T3 Code connection status')
    console.log('─────────────────────────')
    let binOk = false
    try { await access(paths.t3Bin, constants.X_OK); binOk = true } catch { binOk = paths.t3Bin === 't3' }
    console.log(`Binary:     ${paths.t3Bin} (${binOk ? 'ok' : 'not found'})`)
    console.log(`Data dir:   ${paths.baseDir} (${existsSync(paths.baseDir) ? 'exists' : 'missing'})`)
    console.log(`Service:    ${paths.url ?? 'not configured (no DEVDASH_T3_PORT in t3-service.env)'}`)
    if (paths.url) {
      try {
        await assertMemberEndpoint(paths.url)
        console.log('Listener:   reachable & owned by your Linux account')
      } catch (err) {
        console.log(`Listener:   unreachable (${err.message})`)
      }
    }
    console.log(`Config:     ${paths.config} (${existsSync(paths.config) ? 'present' : 'not connected'})`)
    if (existsSync(paths.config)) {
      try {
        const live = await probeLive(paths.config)
        console.log(`T3 version: ${live.version ?? 'unknown'}`)
        if (live.providers.length) {
          console.log('Providers:')
          for (const p of live.providers) console.log(`  • ${p.name} (${p.models} models)`)
        } else {
          console.log('Providers:  none connected yet — run "pair" to open T3 Code and sign in to a provider.')
        }
      } catch (err) {
        console.log(`Live probe: failed (${err.message})`)
      }
    }
    await pauseIfInteractive(cli.interactive, paths, existsSync(paths.baseDir))
    return
  }

  if (cli.cmd === 'pair') {
    console.log('Pair with your personal T3 Code instance')
    console.log('────────────────────────────────────────')
    console.log('Scan the QR code or use the pairing code in T3 Code to sign into model providers (Claude, Codex, OpenCode, Antigravity).')
    console.log('After connecting providers in T3 Code, return to DevDash → Agent setup → Refresh connection.\n')
    const code = await runInteractiveChild(paths.t3Bin, ['pair', '--base-dir', paths.baseDir, '--label', 'DevDash setup'], paths.baseDir)
    if (code !== 0) process.exitCode = code
    await pauseIfInteractive(cli.interactive, paths, false)
    return
  }

  if (cli.cmd === 'disconnect') {
    const res = await disconnectT3(cli)
    if (cli.json) {
      process.stdout.write(JSON.stringify(res) + '\n')
      return
    }
    if (res.removed) {
      console.log(`Disconnected DevDash from T3 Code (${res.revoked ? 'OAuth session revoked' : 'config removed'}).`)
    } else {
      console.log('T3 Code is already disconnected.')
    }
    await pauseIfInteractive(cli.interactive, paths, false)
    return
  }

  // Default: connect / renew
  if (!cli.json) console.log('Connecting DevDash to your personal T3 Code instance…\n')
  try {
    const res = await connectOrRenewT3(cli)
    if (cli.json) {
      process.stdout.write(JSON.stringify({ config: res.config, expiresAt: res.expiresAt, renewed: res.renewed, revokedOld: res.revokedOld }) + '\n')
      return
    }
    console.log(`✓ ${res.renewed ? 'Renewed' : 'Saved'} member credential (mode 0600): ${res.config}`)
    if (res.renewed) console.log(`  Previous T3 session: ${res.revokedOld ? 'revoked' : 'could not revoke (revoke in T3 settings if still listed)'}`)
    console.log(`  Expires: ${res.expiresAt}`)
    console.log('\nChecking live T3 Code providers…')
    const live = await probeLive(res.config)
    console.log(`✓ Connected to T3 Code${live.version ? ` ${live.version}` : ''}`)
    if (live.providers.length) {
      for (const p of live.providers) console.log(`  • ${p.name} (${p.models} models)`)
      console.log('\nYou are ready to use T3 Code in DevDash sessions and Hamasa!')
      await pauseIfInteractive(cli.interactive, paths, false)
    } else {
      console.log('  No model providers connected in T3 Code yet.')
      console.log('  Pair your T3 Code app/browser to sign in to providers, then click Refresh connection in Agent setup.')
      await pauseIfInteractive(cli.interactive, paths, true)
    }
  } catch (err) {
    if (cli.json) {
      process.stderr.write(`${err.message}\n`)
      process.exitCode = 1
      return
    }
    console.error(`✗ ${err.message}`)
    process.exitCode = 1
    await pauseIfInteractive(cli.interactive, paths, false)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
