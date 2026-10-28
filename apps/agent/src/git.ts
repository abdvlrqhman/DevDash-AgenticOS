import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

// Git as this member, in shared checkouts under /srv/devdash. Never prompts: missing credentials fail fast with a clear message.
const ROOT = process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
const PATH_RE = new RegExp(`^${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(projects/[a-z0-9][a-z0-9-]{0,39}|worktrees/[a-z0-9][a-z0-9-]{0,39}/[a-z0-9-]{1,40})$`)
const run = promisify(execFile)
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes',
}

function checked(p: unknown) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) throw new Error('not a DevDash project folder')
  return p
}

async function git(args: string[], timeout = 60_000) {
  try {
    return (await run('git', args, { env: ENV, timeout, maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message: string }
    const text = (e.stderr || e.message).trim()
    if (e.killed) throw new Error('git took too long and was stopped.')
    if (/could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled|Repository not found|could not read from remote/i.test(text)) {
      throw new Error(`This repository needs your GitHub access. Run \`gh auth login\` (then \`gh auth setup-git\`) in your DevDash terminal, or add an SSH key, then try again. Git said: ${text.split('\n').pop()}`)
    }
    throw new Error(text.split('\n').filter(Boolean).slice(-2).join(' ') || 'git failed')
  }
}

async function identity(cwd: string) {
  const email = await git(['-C', cwd, 'config', 'user.email']).catch(() => '')
  if (email.trim()) return []
  const me = userInfo().username
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@users.noreply.devdash`]
}

const remoteHead = async (path: string) => {
  const ref = await git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  return ref.trim().replace(/^origin\//, '') || null
}

// A DevDash worktree branch (projects/service.ts worktree()): dd/<hex>. Everything "Ready to review" acts on is one.
const BRANCH_RE = /^dd\/[a-z0-9-]{1,40}$/
const branchName = (b: unknown) => {
  if (typeof b !== 'string' || !BRANCH_RE.test(b)) throw new Error('invalid branch')
  return b
}
const baseName = (b: unknown) => {
  if (typeof b !== 'string' || !/^[\w./-]+$/.test(b)) throw new Error('invalid base')
  return b
}
/** The base to diff against, mirroring projects/service.ts baseRef: the remote default branch if we have it, else local. */
async function baseRef(path: string, base: string) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    if (await git(['-C', path, 'rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)) return ref
  }
  return base
}
/** "3 files changed, 40 insertions(+), 5 deletions(-)" → numbers (any part may be absent). */
function parseShortstat(line: string) {
  const n = (re: RegExp) => Number(line.match(re)?.[1] ?? 0)
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) }
}

/** Pushes a worktree branch to origin (sets upstream). Shared by gh.pr; reuses git()'s clear auth errors. */
export async function pushBranch(path: unknown, branch: unknown) {
  await git(['-C', checked(path), 'push', '-u', 'origin', branchName(branch)], 120_000)
}
export { checked as checkedPath }

export const ops = {
  /** Clones into a new shared folder; the repo stays writable for the whole group. */
  async clone(r: Record<string, unknown>) {
    const path = checked(r.path)
    const url = String(r.url ?? '')
    if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw new Error('Use an https:// or git@ repository address.')
    if (existsSync(path)) throw new Error('That folder already exists on the server.')
    await git(['clone', '--quiet', '--config', 'core.sharedRepository=group', url, path], 15 * 60_000)
    return { defaultBranch: (await remoteHead(path)) || (await git(['-C', path, 'branch', '--show-current'])).trim() || 'main' }
  },

  /** A project that only lives here: an empty repo with one empty commit, so branches and worktrees work. */
  async init(r: Record<string, unknown>) {
    const path = checked(r.path)
    if (existsSync(path)) throw new Error('That folder already exists on the server.')
    await git(['init', '--quiet', '--initial-branch=main', '--shared=group', path])
    await git(['-C', path, ...(await identity(path)), 'commit', '--quiet', '--allow-empty', '-m', 'Start'])
    return { defaultBranch: 'main' }
  },

  async fetch(r: Record<string, unknown>) {
    const path = checked(r.path)
    const remotes = await git(['-C', path, 'remote'])
    if (!remotes.split('\n').includes('origin')) return { fetched: false }
    await git(['-C', path, 'fetch', '--quiet', '--prune', 'origin'], 5 * 60_000)
    return { fetched: true, defaultBranch: await remoteHead(path) }
  },

  /** Points an existing checkout at a remote by adding or updating `origin` (for connecting a local/zip project to
   *  GitHub). Local only: the server fetches afterwards, recording any access error the way a normal fetch does. */
  async remoteSet(r: Record<string, unknown>) {
    const path = checked(r.path)
    const url = String(r.url ?? '')
    if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw new Error('Use an https:// or git@ repository address.')
    const remotes = (await git(['-C', path, 'remote'])).split('\n').map((s) => s.trim())
    await git(['-C', path, 'remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', url])
    return { ok: true }
  },

  /**
   * Whether a dd/* branch is already an ancestor of the default branch — true when it was merged outside DevDash
   * (--no-ff or fast-forward). Returns the merge commit (the --no-ff merge, or the branch tip for a fast-forward) and
   * its time. A branch that no longer exists is reported as not merged (can't tell).
   */
  async isAncestor(r: Record<string, unknown>) {
    const path = checked(r.path)
    const branch = branchName(r.branch)
    const base = await baseRef(path, baseName(r.base ?? 'main'))
    const tip = (await git(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim()
    if (!tip) return { ancestor: false, mergeCommit: null, mergedAt: null }
    const ancestor = await new Promise<boolean>((resolve, reject) => {
      // merge-base --is-ancestor exits 0 (yes), 1 (no), or >1 (error); git() can't tell them apart, so run it directly.
      execFile('git', ['-C', path, 'merge-base', '--is-ancestor', tip, base], { env: ENV, timeout: 20_000 }, (err) => {
        if (!err) return resolve(true)
        if ((err as { code?: unknown }).code === 1) return resolve(false)
        reject(new Error(`merge-base failed: ${(err as Error).message}`))
      })
    })
    if (!ancestor) return { ancestor: false, mergeCommit: null, mergedAt: null }
    const merges = (await git(['-C', path, 'rev-list', '--ancestry-path', '--merges', '--reverse', `${tip}..${base}`]).catch(() => '')).trim().split('\n').filter(Boolean)
    const mergeCommit = merges[0] ?? tip
    const mergedAt = Number((await git(['-C', path, 'show', '-s', '--format=%ct', mergeCommit]).catch(() => '')).trim()) || null
    return { ancestor: true, mergeCommit, mergedAt }
  },

  async refs(r: Record<string, unknown>) {
    const path = checked(r.path)
    const out = await git(['-C', path, 'for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin'])
    return { refs: Object.fromEntries(out.trim().split('\n').filter((l) => l && !l.startsWith('refs/remotes/origin/HEAD\t')).map((l) => l.split('\t') as [string, string])) }
  },

  /** Commits in `range` (e.g. "a..b" or a ref), newest first. */
  async log(r: Record<string, unknown>) {
    const path = checked(r.path)
    const range = String(r.range ?? '')
    if (!/^[\w./-]+(\.\.[\w./-]+)?$/.test(range)) throw new Error('invalid range')
    const max = Math.min(500, Math.max(1, Number(r.max) || 100))
    const out = await git(['-C', path, 'log', `--max-count=${max}`, '--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e', range, '--'])
    return {
      commits: out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
        const [sha, author, email, at, subject, body] = c.split('\x1f')
        return { sha: sha!, author: author!, email: email!, at: Number(at), subject: subject!, body: body ?? '' }
      }),
    }
  },

  /** A separate checkout on its own branch, so parallel Claude sessions don't step on each other. */
  async worktreeAdd(r: Record<string, unknown>) {
    const path = checked(r.path)
    const wt = checked(r.worktree)
    const branch = String(r.branch ?? '')
    const base = String(r.base ?? '')
    if (!/^dd\/[a-z0-9-]{1,40}$/.test(branch) || !/^[\w./-]+$/.test(base)) throw new Error('invalid branch')
    await git(['-C', path, 'worktree', 'add', '--quiet', '-b', branch, wt, base])
    return { ok: true }
  },

  /** Removes a worktree only when it has nothing uncommitted; otherwise it stays for someone to look at. */
  async worktreeRemove(r: Record<string, unknown>) {
    const path = checked(r.path)
    const wt = checked(r.worktree)
    if (!existsSync(wt)) return { removed: true }
    if ((await git(['-C', wt, 'status', '--porcelain'])).trim()) return { removed: false }
    await git(['-C', path, 'worktree', 'remove', wt])
    return { removed: true }
  },

  /** How far a delivery's branch is ahead of the base: commits, and the diffstat (files, +adds/−dels). */
  async branchStat(r: Record<string, unknown>) {
    const path = checked(r.path)
    const branch = branchName(r.branch)
    const base = await baseRef(path, baseName(r.base))
    const commits = Number((await git(['-C', path, 'rev-list', '--count', `${base}..${branch}`])).trim()) || 0
    const shortstat = (await git(['-C', path, 'diff', '--shortstat', `${base}...${branch}`])).trim()
    return { commits, ...parseShortstat(shortstat) }
  },

  /** The branch's whole change as a unified diff, for the "View changes" panel; capped (~200 KB) with a truncation flag. */
  async branchDiff(r: Record<string, unknown>) {
    const path = checked(r.path)
    const branch = branchName(r.branch)
    const base = await baseRef(path, baseName(r.base))
    const max = Math.min(500_000, Math.max(10_000, Number(r.max) || 200_000))
    const full = await git(['-C', path, 'diff', `${base}...${branch}`])
    const truncated = full.length > max
    return { diff: truncated ? full.slice(0, max) : full, truncated }
  },

  /** Non-GitHub fallback: merge the branch into the base here, as this member. Conflicts abort, leaving the checkout clean. */
  async mergeBranch(r: Record<string, unknown>) {
    const path = checked(r.path)
    const branch = branchName(r.branch)
    const base = baseName(r.base)
    const id = await identity(path)
    await git(['-C', path, ...id, 'checkout', base])
    try {
      await git(['-C', path, ...id, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch])
    } catch (err) {
      await git(['-C', path, 'merge', '--abort']).catch(() => {})
      throw new Error(`Couldn't merge ${branch} into ${base}: ${(err as Error).message}. The merge was rolled back — open a PR, or resolve it by hand.`)
    }
    return { ok: true }
  },
}
