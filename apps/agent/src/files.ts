import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { send } from './tmux.ts'

// Files as this member: their home, the shared project checkouts, the sessions' worktrees and the team's shared folder,
// plus /tmp, where Claude often leaves screenshots and builds. Linux permissions apply on top; paths are resolved
// (symlinks included) and must stay inside one of these.
const SRV = process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
export const roots = () => [
  { id: 'home', label: 'Home', path: homedir() },
  { id: 'projects', label: 'Projects', path: `${SRV}/projects` },
  { id: 'worktrees', label: 'Worktrees', path: `${SRV}/worktrees` },
  { id: 'shared', label: 'Shared', path: `${SRV}/files` },
]
const inside = (p: string) => [...roots().map((r) => r.path), '/tmp'].some((r) => p === r || p.startsWith(`${r}/`))

const FIND_SKIP = new Set(['node_modules', '.git', '.godot', '.gradle', '.cache', '.venv', 'venv', '__pycache__', '.tools', '.next', 'target', '.pub-cache', '.dart_tool'])
const FIND_DEPTH = 6
const FIND_MAX = 10
const FIND_ENTRIES = 50_000

/** An existing path, after symlinks. */
async function existing(p: unknown) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Use a full path.')
  const real = await realpath(p).catch(() => null)
  if (!real) throw new Error('That file or folder does not exist.')
  if (!inside(real)) throw new Error('That is outside the folders DevDash can show.')
  return real
}
/** A path that may not exist yet: its folder must exist and be allowed; the name must be plain. */
async function creatable(p: unknown) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Use a full path.')
  const name = basename(p)
  if (!name || name === '.' || name === '..' || name.includes('\0')) throw new Error('Choose another name.')
  return join(await existing(dirname(resolve(p))), name)
}

export const ops = {
  roots: () => ({ roots: roots() }),

  /** The first of these paths that exists and can be shown: a file Claude named can be relative to more than one folder. */
  async first(r: Record<string, unknown>) {
    const paths = Array.isArray(r.paths) ? r.paths.slice(0, 8) : []
    for (const p of paths) if (await existing(p).then(() => true, () => false)) return { path: p as string }
    return { path: null }
  },

  /**
   * Files called `name` under these folders, newest first: one Claude named without its folder. Shallow ones first, the
   * heavy folders (dependencies, git, SDKs, caches) skipped, and bounded in time and size so it always answers quickly.
   */
  async find(r: Record<string, unknown>) {
    const name = typeof r.name === 'string' ? r.name : ''
    if (!name || name.includes('/') || name === '.' || name === '..' || name.includes('\0')) throw new Error('Give a file name.')
    const given = Array.isArray(r.dirs) ? r.dirs.slice(0, 6) : []
    const real = (await Promise.all(given.map((d) => existing(d).catch(() => null)))).filter((d): d is string => !!d)
    // A folder inside another one listed is searched as part of it.
    const roots = [...new Set(real)].filter((d, _, all) => !all.some((o) => o !== d && d.startsWith(`${o}/`)))
    const found = new Map<string, number>()
    const deadline = Date.now() + 2500
    let seen = 0
    let level = roots
    for (let depth = 0; level.length && depth <= FIND_DEPTH && found.size < FIND_MAX; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (Date.now() > deadline || seen > FIND_ENTRIES || found.size >= FIND_MAX) break
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        seen += entries.length
        for (const e of entries) {
          const p = join(dir, e.name)
          if (e.name === name && (e.isFile() || e.isSymbolicLink())) {
            const s = await stat(p).catch(() => null)
            if (s?.isFile()) found.set(p, s.mtimeMs)
          } else if (e.isDirectory() && !FIND_SKIP.has(e.name)) next.push(p)
        }
      }
      level = next
    }
    return { paths: [...found].sort((a, b) => b[1] - a[1]).map(([p]) => p) }
  },

  async list(r: Record<string, unknown>) {
    const path = await existing(r.path ?? homedir())
    const names = await readdir(path)
    const entries = await Promise.all(names.map(async (name) => {
      const s = await lstat(join(path, name)).catch(() => null)
      if (!s) return null
      const link = s.isSymbolicLink()
      const t = link ? await stat(join(path, name)).catch(() => null) : s
      return { name, dir: !!t?.isDirectory(), link, size: t?.isFile() ? t.size : null, mtime: Math.floor((t ?? s).mtimeMs / 1000) }
    }))
    return {
      path,
      entries: entries.filter((e) => e !== null).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    }
  },

  async mkdir(r: Record<string, unknown>) {
    await mkdir(await creatable(r.path))
    return { ok: true }
  },

  async rename(r: Record<string, unknown>) {
    const from = await existing(r.from)
    const to = await creatable(r.to)
    if (roots().some((x) => x.path === from)) throw new Error('That folder cannot be renamed.')
    await rename(from, to)
    return { ok: true }
  },

  async remove(r: Record<string, unknown>) {
    const path = await existing(r.path)
    if (roots().some((x) => x.path === path)) throw new Error('That folder cannot be deleted.')
    await rm(path, { recursive: true })
    return { ok: true, path }
  },

  /** Creates a folder and any missing parents, inside the member's folders (a new session's own folder). */
  async mkdirp(r: Record<string, unknown>) {
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error('Use a full path.')
    const target = resolve(r.path)
    let base = target
    while (!(await lstat(base).catch(() => null))) base = dirname(base)
    if (!inside(await realpath(base))) throw new Error('That is outside the folders DevDash can show.')
    await mkdir(target, { recursive: true })
    return { path: target }
  },

  /** Whether a shared file is still there (share links stop working once their file is gone). */
  async exists(r: Record<string, unknown>) {
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error('Use a full path.')
    const real = await realpath(r.path).catch(() => null)
    return { exists: !!real && inside(real) }
  },

  /** One chunk of an upload. offset 0 starts the file over; chunks arrive in order. */
  async write(r: Record<string, unknown>) {
    const path = await creatable(r.path)
    const offset = Number(r.offset) || 0
    const data = Buffer.from(String(r.data ?? ''), 'base64')
    const fh = await open(path, offset === 0 ? 'w' : 'r+')
    try {
      await fh.write(data, 0, data.length, offset)
    } finally {
      await fh.close()
    }
    return { ok: true, size: offset + data.length }
  },
}

/**
 * Streams a file over the connection: a header line, then base64 chunks as JSON lines, then {end:true}.
 * (The protocol is JSON lines; base64 costs a third more but keeps one framing for everything.)
 */
export async function read(conn: Socket, path: unknown) {
  const real = await existing(path)
  const s = await stat(real)
  if (!s.isFile()) throw new Error('That is a folder, not a file.')
  send(conn, { ok: true, name: basename(real), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) })
  const stream = createReadStream(real, { highWaterMark: 768 * 1024 })
  for await (const chunk of stream) {
    if (!send(conn, { b: (chunk as Buffer).toString('base64') })) await new Promise((r) => conn.once('drain', r))
    if (conn.destroyed) return stream.destroy()
  }
  send(conn, { end: true })
  conn.end()
}
