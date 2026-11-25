// Each session worktree gets its own copy of the project's dev database, so parallel branches never run their migrations
// against one shared database. Opt-in per project: the main checkout's env names the variable(s) holding a dev database
// on this server, e.g. `DEVDASH_WORKTREE_DB=DATABASE_URL`. Opt-in because a database that looks local (127.0.0.1) can
// be an SSH tunnel to production.
// - A new worktree gets the main checkout's untracked .env files (git leaves them out), and for each named Postgres
//   variable a database of its own, which the worktree's copy of the variable points at. A branch's migrations touch
//   only its copy; the main database changes once the code is merged and migrated there.
// - Disk: a database up to COPY_MAX is copied whole; a bigger one gets its tables without their rows (or starts empty).
// - The copy goes with the worktree (removed by DevDash or the janitor); copies whose worktree is gone are swept.
// - `devdash db` shows a worktree's copy; `devdash db reset` copies the main database again (after main moved on).
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)
export const OPT_IN = 'DEVDASH_WORKTREE_DB'
/** The biggest database copied whole; above it, its tables come without rows. */
export const COPY_MAX = 256 * 1024 * 1024
const ENV_FILE_RE = /^\.env(\.[\w-]+)*$/ // .env, .env.local, .env.development.local…
const URL_RE = /^postgres(ql)?(\+\w+)?:\/\//i

/** KEY=value lines of an env file (`export`, quotes and comments allowed). Pure. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let v = m[2]!
    const q = /^(['"])(.*)\1$/.exec(v)
    v = q ? q[2]! : v.replace(/\s+#.*$/, '')
    out.set(m[1]!, v)
  }
  return out
}

/** The same env text with KEY's value replaced on every line that sets it, keeping quotes and `export`. Pure. */
export function setEnv(text: string, key: string, value: string) {
  return text.replace(new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=\\s*)(['"]?)[^\\n]*?\\2(\\s*(?:#.*)?)$`, 'gm'), (_m, head: string, q: string, tail: string) => `${head}${q}${value}${q}${tail}`)
}

/** A Postgres URL's database name, and the same URL on another database. Null when it isn't one. Pure. */
export function dbOf(url: string): { name: string; on: (db: string) => string } | null {
  if (!URL_RE.test(url)) return null
  const scheme = url.slice(0, url.indexOf('://'))
  let u: URL
  try { u = new URL(url.replace(/^[^:]+:/, 'postgres:')) } catch { return null }
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!name || name.includes('/')) return null
  return { name, on: (db) => { const v = new URL(u); v.pathname = `/${encodeURIComponent(db)}`; return v.toString().replace(/^postgres:/, `${scheme}:`) } }
}

/** The worktree's database: the main one's name and the worktree's folder name, within Postgres's 63 bytes. Pure. */
export const copyName = (main: string, worktree: string) => `${main.slice(0, 63 - 4 - worktree.length)}_wt_${worktree}`.toLowerCase()
/** Only databases DevDash made for a worktree are ever dropped. Pure. */
export const isCopy = (name: string) => /_wt_[a-z0-9-]{1,40}$/.test(name)

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`

/** The project's untracked env files in a checkout (not inside ignored folders like node_modules), relative paths. */
async function envFiles(checkout: string) {
  const { stdout } = await run('git', ['-C', checkout, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split('\0').filter((p) => p && !p.endsWith('/') && ENV_FILE_RE.test(basename(p)) && p.split('/').length <= 4)
}

/** Which variables the project opted in, and their URLs, from the env files of a checkout. */
async function optedIn(dir: string, files: string[]) {
  const env = new Map<string, string>()
  for (const f of files) for (const [k, v] of parseEnv(await readFile(join(dir, f), 'utf8').catch(() => ''))) if (!env.has(k)) env.set(k, v)
  const names = (env.get(OPT_IN) ?? '').split(/[,\s]+/).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
  return names.map((name) => ({ name, url: env.get(name) ?? '' })).filter((x) => dbOf(x.url))
}

async function admin<T>(url: string, fn: (c: pg.Client) => Promise<T>) {
  // CREATE and DROP DATABASE run from another database: the maintenance one, else template1.
  for (const db of ['postgres', 'template1']) {
    const c = new pg.Client({ connectionString: dbOf(url)!.on(db), connectionTimeoutMillis: 8000 })
    try {
      await c.connect()
    } catch (err) {
      if ((err as { code?: string }).code === '3D000') continue // no such database
      throw err
    }
    try { return await fn(c) } finally { await c.end().catch(() => {}) }
  }
  throw new Error('no maintenance database to work from')
}

const hasPgDump = () => run('pg_dump', ['--version']).then(() => true, () => false)
/** pg_dump | pg_restore, from a live database without disturbing it (a snapshot; nobody is disconnected). */
function dumpRestore(from: string, to: string, schemaOnly: boolean) {
  return new Promise<void>((resolve, reject) => {
    const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', ...(schemaOnly ? ['--schema-only'] : []), '--dbname', from], { stdio: ['ignore', 'pipe', 'pipe'] })
    const restore = spawn('pg_restore', ['--no-owner', '--no-acl', '--dbname', to], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    dump.stderr.on('data', (d) => { err += d })
    restore.stderr.on('data', (d) => { err += d })
    restore.stdin.on('error', () => {}) // pg_restore quit early: its exit code says so
    dump.stdout.pipe(restore.stdin)
    let left = 2
    let failed = false
    const done = (code: number | null) => {
      failed ||= code !== 0
      if (--left === 0) failed ? reject(new Error(err.trim().split('\n').pop() || 'pg_dump/pg_restore failed')) : resolve()
    }
    dump.on('close', done)
    restore.on('close', done)
  })
}

export type Copy = { variable: string; database: string; how: 'copied' | 'tables only' | 'empty'; bytes: number | null; error?: string }

/** Makes `target` a copy of `url`'s database: whole when small, else its tables only, else empty. Replaces an old one. */
async function copyInto(url: string, target: string): Promise<Pick<Copy, 'how' | 'bytes'>> {
  const main = dbOf(url)!.name
  const bytes = await admin(url, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${quote(target)} WITH (FORCE)`)
    return Number((await c.query('SELECT pg_database_size($1) AS n', [main])).rows[0]?.n ?? 0)
  })
  const small = bytes <= COPY_MAX
  // Fast and whole: a file-level copy, possible only while nobody is connected to the main database.
  if (small) {
    try {
      await admin(url, (c) => c.query(`CREATE DATABASE ${quote(target)} TEMPLATE ${quote(main)}`))
      return { how: 'copied', bytes }
    } catch (err) {
      if ((err as { code?: string }).code !== '55006') throw err // 55006: the main database is in use
    }
  }
  await admin(url, (c) => c.query(`CREATE DATABASE ${quote(target)}`))
  if (await hasPgDump()) {
    try {
      await dumpRestore(url, dbOf(url)!.on(target), !small)
      return { how: small ? 'copied' : 'tables only', bytes }
    } catch (err) {
      console.error(`worktree db ${target}: pg_dump/pg_restore failed, it starts empty:`, (err as Error).message)
      await admin(url, async (c) => { await c.query(`DROP DATABASE IF EXISTS ${quote(target)} WITH (FORCE)`); await c.query(`CREATE DATABASE ${quote(target)}`) })
    }
  }
  return { how: 'empty', bytes }
}

/**
 * Sets up a new session worktree from its main checkout: copies the untracked env files it lacks, then, when the project
 * opted in, gives each named database variable a database of its own. Never throws: what failed is in the result.
 */
export async function setup(checkout: string, worktree: string): Promise<Copy[]> {
  const files = await envFiles(checkout).catch(() => [] as string[])
  for (const f of files) {
    const to = join(worktree, f)
    if (existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(checkout, f), to)
  }
  const out: Copy[] = []
  for (const v of await optedIn(checkout, files)) {
    const target = copyName(dbOf(v.url)!.name, basename(worktree))
    try {
      const r = await copyInto(v.url, target)
      for (const f of files) {
        const p = join(worktree, f)
        const text = await readFile(p, 'utf8').catch(() => null)
        if (text !== null && parseEnv(text).has(v.name)) await writeFile(p, setEnv(text, v.name, dbOf(v.url)!.on(target)))
      }
      out.push({ variable: v.name, database: target, ...r })
    } catch (err) {
      out.push({ variable: v.name, database: target, how: 'empty', bytes: null, error: (err as Error).message })
    }
  }
  return out
}

/** The worktree's own databases, from its env files: only ones DevDash made (named …_wt_<folder>). */
async function copiesOf(worktree: string) {
  const files = await envFiles(worktree).catch(() => [] as string[])
  return (await optedIn(worktree, files)).filter((v) => isCopy(dbOf(v.url)!.name) && dbOf(v.url)!.name.endsWith(`_wt_${basename(worktree).toLowerCase()}`))
}

/** Drops a worktree's own databases (before the worktree itself goes). Never throws. */
export async function teardown(worktree: string) {
  for (const v of await copiesOf(worktree).catch(() => [])) {
    const name = dbOf(v.url)!.name
    await admin(v.url, (c) => c.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`)).catch((err: Error) => console.error(`worktree db ${name}:`, err.message))
  }
}

/** The main checkout a worktree belongs to. */
async function mainOf(worktree: string) {
  const { stdout } = await run('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return dirname(stdout.trim())
}

/** `devdash db`: this worktree's own databases, or `reset`: copy the main database into them again. */
export async function cli(cwd: string, action: string) {
  const top = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => ({ stdout: '' }))).stdout.trim()
  if (!top) return 'Not in a git checkout.'
  const main = await mainOf(top)
  if (main === top) {
    const v = await optedIn(main, await envFiles(main))
    return v.length
      ? `This is the main checkout. New worktrees get their own copy of: ${v.map((x) => `${x.name} (${dbOf(x.url)!.name})`).join(', ')}.`
      : `This is the main checkout. To give each new worktree its own copy of a dev database on this server, add ${OPT_IN}=DATABASE_URL (the variable's name) to its .env. Never for a tunnel to production.`
  }
  if (action === 'reset') {
    const done = await setup(main, top) // also brings the env files a worktree made before this lacks
    if (!done.length) return `The project hasn't opted in (${OPT_IN} in the main checkout's .env).`
    return `Copied the main database again: ${done.map((d) => `${d.variable} → ${d.database} (${d.error ? `failed: ${d.error}` : d.how})`).join(', ')}. Run this branch's migrations on it now.`
  }
  const own = await copiesOf(top)
  if (!own.length) return `This worktree has no database of its own. ${(await optedIn(main, await envFiles(main))).length ? 'Run `devdash db reset` to make one.' : `The project hasn't opted in (${OPT_IN} in the main checkout's .env).`}`
  const sized = await Promise.all(own.map(async (v) => {
    const n = await admin(v.url, (c) => c.query('SELECT pg_database_size($1) AS n', [dbOf(v.url)!.name])).then((r) => Number(r.rows[0]?.n), () => null)
    return `${v.name} → ${dbOf(v.url)!.name}${n === null ? '' : ` (${(n / 1024 / 1024).toFixed(1)} MB)`}`
  }))
  return `This worktree's own databases: ${sized.join(', ')}. Its migrations touch only these. \`devdash db reset\` copies the main database again.`
}

/** Drops copies whose worktree folder is gone (removed by hand, or before this existed). Never throws. */
export async function sweep(checkout: string, worktreesRoot: string) {
  for (const v of await optedIn(checkout, await envFiles(checkout).catch(() => [])).catch(() => [])) {
    const main = dbOf(v.url)!.name
    await admin(v.url, async (c) => {
      const rows = (await c.query("SELECT datname FROM pg_database WHERE datname LIKE '%\\_wt\\_%'")).rows as { datname: string }[]
      for (const { datname } of rows) {
        const folder = /_wt_([a-z0-9-]{1,40})$/.exec(datname)?.[1]
        // Only this project's copies (named exactly as setup names them) whose worktree folder is gone.
        if (!folder || copyName(main, folder) !== datname || existsSync(join(worktreesRoot, folder))) continue
        await c.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`)
      }
    }).catch((err: Error) => console.error(`worktree db sweep (${main}):`, err.message))
  }
}
