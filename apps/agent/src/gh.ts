import { execFile, spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import { promisify } from 'node:util'
import { checkedPath, pushBranch } from './git.ts'
import { send } from './tmux.ts'

// GitHub's API as this member, through their own `gh` login (Account → GitHub). Only repository endpoints.
const run = promisify(execFile)
const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }

function checked(path: unknown) {
  if (typeof path !== 'string' || !/^repos\/[\w.-]+\/[\w.-]+\/[\w./?=&%-]*$/.test(path) || path.includes('..')) throw new Error('invalid GitHub API path')
  return path
}
function friendly(err: unknown): never {
  const e = err as { stderr?: string; code?: string; message: string }
  if (e.code === 'ENOENT') throw new Error('GitHub CLI is not installed on the server.')
  const text = (e.stderr || e.message).trim()
  if (/not logged in|gh auth login|authentication|401/i.test(text)) throw new Error('Connect your GitHub account first (Account → GitHub).')
  if (/HTTP 404/.test(text)) throw new Error('GitHub says not found. Check the repository and that your account can see it.')
  throw new Error(text.split('\n').filter(Boolean).pop() ?? 'GitHub request failed')
}

export const ops = {
  /** GET (JSON or text) or POST with a JSON body. */
  async api(r: Record<string, unknown>) {
    const path = checked(r.path)
    const method = r.method === 'POST' ? 'POST' : 'GET'
    try {
      if (method === 'GET') {
        const { stdout } = await run('gh', ['api', path], { env: ENV, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
        return { text: stdout }
      }
      const child = execFile('gh', ['api', '--method', 'POST', path, '--input', '-'], { env: ENV, timeout: 30_000 }, () => {})
      const out = await new Promise<string>((resolve, reject) => {
        let o = ''
        let e = ''
        child.stdout?.on('data', (d) => (o += d))
        child.stderr?.on('data', (d) => (e += d))
        child.on('close', (code) => (code === 0 ? resolve(o) : reject(Object.assign(new Error(e || `gh exited ${code}`), { stderr: e }))))
        child.stdin?.end(JSON.stringify(r.body ?? {}))
      })
      return { text: out }
    } catch (err) {
      friendly(err)
    }
  },

  /** Pushes a delivery's branch and opens a PR into base (CI runs the tests). Returns an existing PR's URL if there is one. */
  async pr(r: Record<string, unknown>) {
    const path = checkedPath(r.path)
    const branch = String(r.branch ?? '')
    const base = String(r.base ?? '')
    if (!/^[\w./-]+$/.test(base)) throw new Error('invalid base')
    const title = (String(r.title ?? '').trim() || branch).slice(0, 250)
    const body = String(r.body ?? '').slice(0, 4000)
    await pushBranch(path, branch) // reuses git's clear "connect your GitHub" errors
    try {
      const existing = await run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { env: ENV, cwd: path, timeout: 30_000 })
        .then((o) => o.stdout.trim(), () => '')
      if (existing) return { url: existing }
      const { stdout } = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { env: ENV, cwd: path, timeout: 60_000 })
      return { url: stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? stdout.trim() }
    } catch (err) {
      friendly(err)
    }
  },
}

/** Streams a binary download (e.g. an artifact zip) like files.read: header, base64 chunks, {end:true}. */
export async function download(conn: Socket, path: unknown, name: unknown) {
  const p = checked(path)
  const child = spawn('gh', ['api', p], { env: ENV })
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  let started = false
  for await (const chunk of child.stdout) {
    if (!started) {
      started = true
      send(conn, { ok: true, name: String(name ?? 'download'), size: 0 })
    }
    if (!send(conn, { b: (chunk as Buffer).toString('base64') })) await new Promise((r) => conn.once('drain', r))
    if (conn.destroyed) return child.kill()
  }
  const code = await new Promise<number>((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('close', (c) => r(c ?? 1))))
  if (!started) {
    try { friendly(Object.assign(new Error(err), { stderr: err })) } catch (e) { send(conn, { error: (e as Error).message }) }
  } else send(conn, code === 0 ? { end: true } : { error: 'Download stopped early.' })
  conn.end()
}
