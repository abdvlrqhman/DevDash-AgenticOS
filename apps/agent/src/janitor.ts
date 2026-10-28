import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Worktree janitor: runs AS the member (one agent per member) and prunes leftover worktrees so they stop filling the
// shared disk. Two kinds:
//   1. Claude Code's own subagent worktrees, <repo>/.claude/worktrees/agent-<id> — one `npm ci` grows them ~400 MB.
//   2. DevDash's session worktrees, /srv/devdash/worktrees/<slug>/<hex> — an abandoned session leaves one behind (and an
//      agent that re-downloads an SDK/node_modules into it can make it gigabytes). Only the ones THIS member owns.
// We only ever remove something PROVABLY safe — stale, with no uncommitted edits, and nothing unmerged to lose (git keeps
// the branch's commits regardless). Any doubt → skip and log. We never touch a main checkout.

const run = promisify(execFile)
const ROOT = () => process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'

// Thresholds (tuned for safety; a sweep is cheap and rare, so err on the side of leaving things alone).
export const STALE_MS = 24 * 60 * 60_000 // "abandoned": nothing in the worktree changed for 24h (agents finish in minutes)
const FIRST_SWEEP_MS = 2 * 60_000 // first sweep ~2 min after the agent starts (off the critical path)
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000 // then every ~6h
const WALK_BUDGET = 5000 // cap entries walked when dating a tree, so a huge worktree can't make the sweep expensive

const AGENT_RE = /^agent-[\w-]+$/ // the ONLY folder names we ever touch under a repo's .claude/worktrees
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

type Registered = { path: string; branch: string | null; locked: boolean }
export type WorktreeState = {
  ageMs: number // time since last activity (newest mtime in the tree)
  dirty: boolean // `git status --porcelain` non-empty
  aheadOfBase: number // commits on this branch not in base (0 = nothing would be lost)
  mergedIntoBase: boolean // this branch's HEAD is an ancestor of base
  locked: boolean // the worktree is locked (someone wants it kept)
  gitError: boolean // its git state could not be read safely
}
export type Decision = { remove: boolean; reason: string }
type Base = { ref: string; name: string }
type Result = { removed: number; skipped: number }

/**
 * The whole safety policy, with NO I/O so it is unit-testable. Only returns remove when the worktree is stale AND clean
 * AND provably loses nothing. Any uncertainty (locked, unreadable, recent, dirty, unmerged) → keep.
 */
export function decide(w: WorktreeState, staleMs = STALE_MS): Decision {
  if (w.gitError) return { remove: false, reason: 'git state unreadable' }
  if (w.locked) return { remove: false, reason: 'worktree is locked' }
  if (w.ageMs < staleMs) return { remove: false, reason: 'still recent' }
  if (w.dirty) return { remove: false, reason: 'uncommitted changes' }
  if (w.mergedIntoBase || w.aheadOfBase === 0) return { remove: true, reason: 'stale, clean, nothing unmerged' }
  return { remove: false, reason: `${w.aheadOfBase} unmerged commit(s) ahead of base` }
}

/** git in a repo, never prompting; returns the exit code instead of throwing so callers can treat failure as "unsure". */
async function git(cwd: string, args: string[], timeout = 30_000) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { env: ENV, timeout, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, out: stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string }
    return { ok: false, out: e.stdout ?? '', code: typeof e.code === 'number' ? e.code : null }
  }
}

const canon = (p: string) => realpath(p).catch(() => p)

/** Newest mtime (ms) anywhere in the tree, else the dir's own. Does NOT follow symlinks (so a symlinked node_modules is
 *  never walked) and is bounded by WALK_BUDGET. On total failure returns now, so an unreadable tree reads as "recent". */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0
  let budget = WALK_BUDGET
  const stack = [dir]
  while (stack.length && budget > 0) {
    const d = stack.pop()!
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (--budget <= 0) break
      const p = join(d, e.name)
      const s = await lstat(p).catch(() => null) // lstat: a symlink's own mtime, not its target's
      if (!s) continue
      if (s.mtimeMs > newest) newest = s.mtimeMs
      if (e.isDirectory()) stack.push(p) // Dirent.isDirectory() is false for symlinks, so we never descend one
    }
  }
  const self = await lstat(dir).catch(() => null)
  if (self && self.mtimeMs > newest) newest = self.mtimeMs
  return newest || Date.now()
}

/** The registered worktrees of a repo, keyed by their real path; null if git state can't be read (→ touch nothing). */
async function registered(repo: string): Promise<Map<string, Registered> | null> {
  const r = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  const byReal = new Map<string, Registered>()
  let cur: Registered | null = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9), branch: null, locked: false }
    else if (!cur) continue
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === '') { if (cur) byReal.set(await canon(cur.path), cur); cur = null }
  }
  if (cur) byReal.set(await canon(cur.path), cur)
  return byReal
}

/** The base to compare branches against, mirroring projects/service.ts: origin/<default> else <default>, else main/master. */
async function baseRef(repo: string): Promise<Base> {
  let name = ''
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok) name = head.out.trim().replace(/^origin\//, '')
  for (const c of ['main', 'master']) {
    if (name) break
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${c}`])).ok) name = c
  }
  if (!name) {
    const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    name = cur.ok ? cur.out.trim() : 'main'
  }
  const origin = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])
  return { ref: origin.ok ? `refs/remotes/origin/${name}` : name, name }
}

/** Reads a registered worktree's safety state. Skips the git work for recent/locked ones (they're kept regardless). */
async function inspect(repo: string, path: string, reg: Registered, base: Base, ageMs: number): Promise<WorktreeState> {
  const s: WorktreeState = { ageMs, dirty: false, aheadOfBase: 0, mergedIntoBase: false, locked: reg.locked, gitError: false }
  if (reg.locked || ageMs < STALE_MS) return s
  const status = await git(path, ['status', '--porcelain'])
  if (!status.ok) return { ...s, gitError: true }
  s.dirty = status.out.trim().length > 0
  const head = await git(path, ['rev-parse', 'HEAD'])
  if (!head.ok) return { ...s, gitError: true }
  const sha = head.out.trim()
  const ahead = await git(repo, ['rev-list', '--count', `${base.ref}..${sha}`])
  if (!ahead.ok) return { ...s, gitError: true }
  s.aheadOfBase = Number(ahead.out.trim()) || 0
  const merged = await git(repo, ['merge-base', '--is-ancestor', sha, base.ref]) // exit 0 = merged, 1 = not, other = error
  if (merged.code !== 0 && merged.code !== 1) return { ...s, gitError: true }
  s.mergedIntoBase = merged.code === 0
  return s
}

/** Removes a proven-safe worktree: force-remove, prune admin state, delete its now-merged branch (never a base branch). */
async function removeWorktree(repo: string, path: string, reg: Registered, base: Base): Promise<void> {
  const res = await git(repo, ['worktree', 'remove', '--force', path])
  if (!res.ok) throw new Error('git worktree remove failed')
  await git(repo, ['worktree', 'prune'])
  const b = reg.branch
  if (b && b !== base.name && b !== 'main' && b !== 'master') await git(repo, ['branch', '-D', b])
}

/** An agent-* dir that is NOT a registered worktree. Only rm leftover files with no git state of their own; else keep. */
async function handleOrphan(path: string, ageMs: number, out: Result): Promise<void> {
  if (ageMs < STALE_MS) return // recent → leave it alone (silent)
  if (existsSync(join(path, '.git'))) { // a repo/worktree of its own may hold unpushed work — be conservative
    out.skipped++
    console.log(`janitor: kept ${path} — not a registered worktree but has git state`)
    return
  }
  await rm(path, { recursive: true, force: true })
  out.removed++
  console.log(`janitor: removed orphan ${path} (leftover files, no git state)`)
}

/** This member's own uid, to only ever touch worktrees they own (so one agent never fights another's permissions). */
const myUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

/**
 * DevDash's session worktrees (/srv/devdash/worktrees/<slug>/<hex>, branch dd/<hex>): remove this member's abandoned
 * ones with the same safety policy as the subagent ones. Stale + clean + merged/nothing-ahead only; git keeps the branch.
 */
async function sweepDevdashWorktrees(now: number, out: Result): Promise<void> {
  const wtRoot = join(ROOT(), 'worktrees')
  const uid = myUid()
  let slugs: string[]
  try {
    slugs = (await readdir(wtRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return } // no worktrees root, or no access
  for (const slug of slugs) {
    const repo = join(ROOT(), 'projects', slug)
    if (!existsSync(join(repo, '.git'))) continue
    let hexes: string[]
    try {
      hexes = (await readdir(join(wtRoot, slug), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch { continue }
    if (!hexes.length) continue
    const reg = await registered(repo)
    if (!reg) continue // can't read git state → touch nothing in this repo
    const base = await baseRef(repo)
    for (const hex of hexes) {
      const path = join(wtRoot, slug, hex)
      try {
        const st = await lstat(path)
        if (uid >= 0 && st.uid !== uid) continue // only this member's own worktrees
        const r = reg.get(await canon(path))
        if (!r) continue // not a registered worktree (half-removed / unexpected) → leave it
        const ageMs = now - (await newestMtimeMs(path))
        const d = decide(await inspect(repo, path, r, base, ageMs))
        if (d.remove) {
          await removeWorktree(repo, path, r, base)
          out.removed++
          console.log(`janitor: removed session worktree ${path} (${d.reason})`)
        } else if (ageMs >= STALE_MS) {
          out.skipped++
          console.log(`janitor: kept ${path} — ${d.reason}`)
        }
      } catch (err) {
        out.skipped++
        console.log(`janitor: kept ${path} — ${(err as Error).message}`)
      }
    }
  }
}

/**
 * Partial .zip uploads (apps/agent/src/project.ts) whose page never finished or threw them away — closed mid-upload, or
 * the server restarted at the wrong moment: this member's, untouched for a day, go. They can be gigabytes.
 */
async function sweepUploads(now: number, out: Result): Promise<void> {
  const dir = join(ROOT(), 'projects', '.dd-uploads')
  const uid = myUid()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch { return } // nothing uploaded yet
  for (const name of names) {
    if (!/^[a-f0-9]{8,64}\.(zip|x)$/.test(name)) continue // only what project.ts makes
    const path = join(dir, name)
    try {
      const st = await lstat(path)
      if (uid >= 0 && st.uid !== uid) continue
      const ageMs = now - (st.isDirectory() ? await newestMtimeMs(path) : st.mtimeMs)
      if (ageMs < STALE_MS) continue
      await rm(path, { recursive: true, force: true })
      out.removed++
      console.log(`janitor: removed abandoned upload ${path}`)
    } catch (err) {
      console.log(`janitor: kept ${path} — ${(err as Error).message}`)
    }
  }
}

/** How long a message's attachments stay on the server once nothing touches them (they can be 250 MB). */
export const ATTACHMENTS_MS = 14 * 24 * 60 * 60_000

/**
 * Files attached to this member's Claude messages (~/.cache/devdash/uploads/<session>/<message or upload>), including
 * big uploads whose message was never sent: a folder untouched for two weeks goes, and an emptied session folder too.
 */
async function sweepAttachments(now: number, out: Result): Promise<void> {
  const root = join(homedir(), '.cache', 'devdash', 'uploads')
  let sessions: string[]
  try {
    sessions = await readdir(root)
  } catch { return } // nothing attached yet
  for (const session of sessions) {
    const dir = join(root, session)
    let items: string[]
    try {
      items = await readdir(dir)
    } catch { continue }
    for (const item of items) {
      const path = join(dir, item)
      try {
        if (now - (await newestMtimeMs(path)) < ATTACHMENTS_MS) continue
        await rm(path, { recursive: true, force: true })
        out.removed++
        console.log(`janitor: removed old attachments ${path}`)
      } catch (err) {
        console.log(`janitor: kept ${path} — ${(err as Error).message}`)
      }
    }
    if (!(await readdir(dir).catch(() => ['?'])).length) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** One full sweep across the member's project checkouts. Never throws; returns how many it removed vs. kept. */
export async function sweep(now = Date.now()): Promise<Result> {
  const out: Result = { removed: 0, skipped: 0 }
  let repos: string[]
  try {
    repos = (await readdir(join(ROOT(), 'projects'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(ROOT(), 'projects', e.name))
  } catch { repos = [] } // no projects root, or no access (the member's own attachments are still swept below)
  for (const repo of repos) {
    const wtDir = join(repo, '.claude', 'worktrees')
    let names: string[]
    try {
      names = (await readdir(wtDir, { withFileTypes: true })).filter((e) => e.isDirectory() && AGENT_RE.test(e.name)).map((e) => e.name)
    } catch { continue } // no worktrees here, or no access
    if (!names.length || !existsSync(join(repo, '.git'))) continue
    const reg = await registered(repo)
    if (!reg) { out.skipped += names.length; continue } // can't read git state → touch nothing in this repo
    const base = await baseRef(repo)
    for (const name of names) {
      const path = join(wtDir, name)
      try {
        const ageMs = now - (await newestMtimeMs(path))
        const r = reg.get(await canon(path))
        if (!r) { await handleOrphan(path, ageMs, out); continue }
        const d = decide(await inspect(repo, path, r, base, ageMs))
        if (d.remove) {
          await removeWorktree(repo, path, r, base)
          out.removed++
          console.log(`janitor: removed ${path} (${d.reason})`)
        } else if (ageMs >= STALE_MS) { // stale but unsafe — say why; recent ones stay silent
          out.skipped++
          console.log(`janitor: kept ${path} — ${d.reason}`)
        }
      } catch (err) {
        out.skipped++
        console.log(`janitor: kept ${path} — ${(err as Error).message}`)
      }
    }
  }
  await sweepDevdashWorktrees(now, out).catch((err) => console.log(`janitor: devdash worktrees sweep failed — ${(err as Error).message}`))
  await sweepUploads(now, out).catch((err) => console.log(`janitor: uploads sweep failed — ${(err as Error).message}`))
  await sweepAttachments(now, out).catch((err) => console.log(`janitor: attachments sweep failed — ${(err as Error).message}`))
  if (out.removed || out.skipped) console.log(`janitor: removed ${out.removed}, kept ${out.skipped} stale/uncertain worktree(s)`)
  return out
}

/** Schedules the sweep off the agent's critical path: once ~2 min after start, then every ~6h. Never blocks or throws. */
export function startJanitor(): void {
  const once = () => void sweep().catch((err) => console.log(`janitor: sweep failed — ${(err as Error).message}`))
  setTimeout(() => { once(); setInterval(once, SWEEP_INTERVAL_MS).unref() }, FIRST_SWEEP_MS).unref()
}
