import { execFile } from 'node:child_process'
import { chmod, lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'

// The shared folders are the team's: every member works in every project (install.sh: setgid folders, umask 0002). Some
// tools still write files only their creator can read (a .env saved 0600, say), and then a teammate's session can't open
// the project's own settings. This runs AS the member and gives the team back read and write on the member's own files
// there. Private keys stay private: ssh refuses a key others can read. So does any folder with a `.devdash-private` file
// in it (a backup of someone's server, say): its owner keeps it to themselves.

const run = promisify(execFile)
const ROOT = () => process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
const FIRST_MS = 3 * 60_000
const EVERY_MS = 15 * 60_000
/** Folders that hold tools and caches, not the project's own files: skipped, so a sweep stays cheap. */
const SKIP = ['node_modules', '.git', '.venv', 'venv', '.tools', '__pycache__', '.gradle', '.next', '.cache']
/** Private keys and certificates, which must stay readable by their owner alone. */
export const isKey = (name: string) => /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || /^id_[a-z0-9]+$/i.test(name)

/** A folder that keeps its own permissions, by its owner's choice. */
export const PRIVATE_MARK = '.devdash-private'

// find exits non-zero when it meets a folder it can't read (someone else's): what it printed is still right.
const find = (args: string[]) =>
  run('find', args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
    .then((r) => r.stdout.split('\0').filter(Boolean))

/** This member's files and folders in the shared folders that the team can't read and write. */
async function closed(roots: string[]): Promise<string[]> {
  const me = String(process.getuid?.() ?? '')
  if (!me) return []
  const skip = SKIP.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]))
  const marked = (await find([...roots, '(', ...skip, ')', '-prune', '-o', '-name', PRIVATE_MARK, '-print0'])).map((p) => p.slice(0, -PRIVATE_MARK.length - 1))
  const prune = [...skip, ...marked.flatMap((dir) => ['-o', '-path', dir])]
  return find([...roots, '(', ...prune, ')', '-prune', '-o', '-user', me, '(',
    '-type', 'f', '!', '-perm', '-g+rw', '-o', '-type', 'd', '!', '-perm', '-g+rwx', ')', '-print0'])
}

/** Opens this member's files in the shared folders to the team; returns how many it changed. */
export async function openTeamFiles(roots = ['projects', 'worktrees', 'files'].map((d) => `${ROOT()}/${d}`)): Promise<number> {
  let changed = 0
  for (const path of await closed(roots)) {
    try {
      const s = await lstat(path)
      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) await chmod(path, (s.mode & 0o7777) | 0o2070)
      else if (s.isFile() && !isKey(basename(path))) await chmod(path, (s.mode & 0o7777) | 0o060)
      else continue
      changed++
    } catch { /* gone, or not ours after all */ }
  }
  if (changed) console.log(`team files: opened ${changed} file(s) in the shared folders to the team`)
  return changed
}

/** Off the agent's critical path: once a few minutes after start, then every quarter of an hour. */
export function startTeamFiles(): void {
  const once = () => void openTeamFiles().catch((err: Error) => console.log(`team files: ${err.message}`))
  setTimeout(() => { once(); setInterval(once, EVERY_MS).unref() }, FIRST_MS).unref()
}
