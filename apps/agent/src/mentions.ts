// Files and folders for @ mentions in Chat: what git tracks (plus new, unignored files), else a shallow walk.
// Claude Code reads an @path in a message itself, the same as in the CLI.
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_FILES = 20_000
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache'])
const cache = new Map<string, { at: number; paths: Promise<string[]> }>()

async function walk(root: string) {
  const out: string[] = []
  const visit = async (dir: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) await visit(join(dir, e.name), depth + 1)
      } else if (e.isFile()) out.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
  await visit(root, 0)
  return out
}

async function list(cwd: string) {
  try {
    const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 })
    return stdout.split('\n').filter(Boolean).slice(0, MAX_FILES)
  } catch {
    return walk(cwd)
  }
}

/** Folders appear as "dir/" so Claude gets the whole folder, like @src/ in the CLI. */
function withFolders(files: string[]) {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  return [...dirs, ...files]
}

// Best first: the name starts with the query, then the name contains it, then the path does; shorter paths win ties.
function score(path: string, q: string) {
  const p = path.toLowerCase()
  const name = p.replace(/\/$/, '').split('/').pop()!
  if (!q) return 3
  if (name.startsWith(q)) return 0
  if (name.includes(q)) return 1
  if (p.includes(q)) return 2
  return -1
}

const depth = (p: string) => p.replace(/\/$/, '').split('/').length

export async function search(cwd: string, query: string) {
  if (!isAbsolute(cwd)) throw new Error('invalid folder')
  let hit = cache.get(cwd)
  if (!hit || Date.now() - hit.at > 30_000) {
    hit = { at: Date.now(), paths: list(cwd).then(withFolders) }
    cache.set(cwd, hit)
  }
  const q = query.toLowerCase().replace(/^\.\//, '')
  return (await hit.paths)
    .map((path) => ({ path, s: score(path, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || depth(a.path) - depth(b.path) || a.path.length - b.path.length)
    .slice(0, 30)
    .map((x) => x.path)
}
