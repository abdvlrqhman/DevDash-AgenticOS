import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// The member's cloud storage as an rclone remote (`drive:`) in their own rclone config. The
// remote holds no Google secret: its refresh token is an opaque DevDash handle that the server's loopback token endpoint
// trades for short-lived Google access tokens, so disconnecting in DevDash cuts it off. rclone itself caches the
// access token in this file, so we only rewrite the section when the handle or folder changed.
export type Storage = { remote: string; account: string; folderId: string; handle: string; tokenUrl: string }

const confPath = () => process.env.RCLONE_CONFIG || join(homedir(), '.config', 'rclone', 'rclone.conf')
const SECTION = /^\s*\[([^\]]+)\]\s*$/

/** The config as [name, lines] blocks; text before the first section (comments) is kept under ''. */
function blocks(text: string) {
  const out: [string, string[]][] = [['', []]]
  for (const line of text.split('\n')) {
    const m = SECTION.exec(line)
    if (m) out.push([m[1]!, [line]])
    else out.at(-1)![1].push(line)
  }
  return out
}
const value = (lines: string[], key: string) => lines.map((l) => /^\s*([^=#;]+?)\s*=\s*(.*)$/.exec(l)).find((m) => m?.[1] === key)?.[2]
const join2 = (bs: [string, string[]][]) => bs.flatMap(([, lines]) => lines).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')

/** Whether a section is the one DevDash manages: it points at DevDash's token endpoint. */
const ours = (lines: string[], tokenUrl: string) => value(lines, 'token_url') === tokenUrl

/**
 * The config with the remote set to `s`, or null when it's already right (same handle and folder), so the access token
 * rclone cached there is kept. Other remotes are left exactly as they were.
 */
export function withRemote(text: string, s: Storage): string | null {
  const bs = blocks(text)
  const current = bs.find(([name]) => name === s.remote)
  if (current && ours(current[1], s.tokenUrl) && value(current[1], 'root_folder_id') === s.folderId) {
    try {
      if ((JSON.parse(value(current[1], 'token') ?? '{}') as { refresh_token?: string }).refresh_token === s.handle) return null
    } catch { /* unreadable token: rewrite it */ }
  }
  // rclone only refreshes a token that has some access token; an empty one makes it drop the refresh token.
  const token = JSON.stringify({ access_token: 'devdash', token_type: 'Bearer', refresh_token: s.handle, expiry: '2000-01-01T00:00:00Z' })
  const section = [
    `[${s.remote}]`,
    'type = drive',
    'client_id = devdash', // the real client and secret stay on the DevDash server; its token endpoint ignores these
    'client_secret = devdash',
    'scope = drive.file',
    `root_folder_id = ${s.folderId}`,
    `token_url = ${s.tokenUrl}`,
    `token = ${token}`,
    '',
  ]
  const rest = bs.filter(([name]) => name !== s.remote)
  return `${join2([...rest, [s.remote, section]]).trimEnd()}\n`
}

/** The config without DevDash's remote, or null when there's nothing of ours to remove (a member's own remote stays). */
export function withoutRemote(text: string, remote: string, tokenUrl: string): string | null {
  const bs = blocks(text)
  const current = bs.find(([name]) => name === remote)
  if (!current || !ours(current[1], tokenUrl)) return null
  const left = join2(bs.filter((b) => b !== current)).trimEnd()
  return left ? `${left}\n` : ''
}

async function update(change: (text: string) => string | null) {
  const path = confPath()
  const text = await readFile(path, 'utf8').catch(() => '')
  const next = change(text)
  if (next === null) return false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.devdash-${process.pid}`
  await writeFile(tmp, next, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  return true
}

/** Every value lands in an INI file: refuse anything that could add a line or a section. */
function check(s: Storage) {
  const ok = /^[\w-]{1,40}$/.test(s.remote) && /^[\w-]{1,200}$/.test(s.folderId) && /^ddh_[\w-]{20,200}$/.test(s.handle)
    && /^http:\/\/127\.0\.0\.1:\d{2,5}\/internal\/storage\/token$/.test(s.tokenUrl) && !/[\r\n]/.test(s.account)
  if (!ok) throw new Error('invalid storage settings')
  return s
}

/** Sets up (or refreshes) the remote. Called when the member connects and before each session starts. */
export const configure = (s: Storage) => update((text) => withRemote(text, check(s)))
export const remove = (remote: string, tokenUrl: string) => update((text) => withoutRemote(text, remote, tokenUrl))

/** The Drive folder a session's files go in: its project (shared checkout or worktree), else its own folder's name. */
export function driveFolder(cwd: string) {
  const m = /^\/srv\/devdash\/(?:projects|worktrees)\/([^/]+)/.exec(cwd)
  if (m) return m[1]!
  const base = basename(cwd).replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '')
  return cwd.replace(/\/+$/, '') === homedir() || !base ? 'files' : base
}

/**
 * What Claude is told. Not a recipe for one kind of file: a rule to apply with judgment — anything heavy that doesn't
 * have to live on the shared server goes to the member's Drive, on Claude's own initiative, organised by project.
 */
export function note(s: Storage | null | undefined, folder = 'files') {
  if (!s) {
    return `No cloud storage is connected for this person. If the work produces heavy files that don't need to stay on this server (videos, audio, renders, builds, datasets, archives — roughly 100 MB or more), suggest they connect their Google Drive on DevDash's Storage page; meanwhile keep only what the work needs and clean up the rest.`
  }
  const d = `${s.remote}:${folder}`
  return `Heavy files belong in ${s.account}'s Google Drive, not on this server — its disk is small and shared by the whole team. The Drive is the rclone remote \`${s.remote}:\` (a "DevDash" folder in their Drive; you only see what DevDash put there, never the rest of their Drive). Apply this with judgment, on your own initiative, without waiting to be asked:
- What goes there: anything heavy (roughly 100 MB or more, or many files adding up) that the work doesn't need on the server to keep going — finished videos, audio, renders and image sets, exported builds (APK, IPA, zips), datasets and large downloads you're done with, recordings, backups, dumps and archives.
- What stays: what the work runs on (source and git repos, node_modules, SDKs, caches, virtualenvs, databases in use, files a service serves), and anything secret — never upload .env files, keys or credentials.
- When: as soon as a heavy thing is finished, not at the end of the task. Keep what you still need locally; once a big input is used up, delete the local copy.
- Where: this session's folder is \`${d}/\`; group by kind inside it (\`${d}/videos/\`, \`${d}/builds/\`, \`${d}/data/\`).
- How: a file \`rclone move <file> ${d}/<kind>/ --drive-chunk-size 128M --stats 30s\` (the local copy is deleted only after a successful upload); a folder \`rclone move <dir> ${d}/<dir> --delete-empty-src-dirs\`; thousands of small files: archive first (\`tar czf name.tgz <dir>\`) — Drive is slow per file. Use \`rclone copy\` instead of move when the server still needs it.
- Back and around: \`rclone lsf ${d}/\`, \`rclone copy ${d}/<path> .\`, \`rclone link ${d}/<path>\` (a link they can open or send), \`rclone about ${s.remote}:\` (free space: personal accounts have 15 GB shared with Gmail; check before multi-GB uploads and tell them when it's nearly full).
- Then say what you moved: the \`${s.remote}:\` path and a link.`
}
