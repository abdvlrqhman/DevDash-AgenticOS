// Where each of My skills, and each Claude Code plugin, is used: everywhere (the default), or only in some folders.
// One file per member; applied when a session starts, so Claude Code and OpenCode follow the same choice:
// - Claude Code: the session's flag settings get skillOverrides {<folder name>: 'off'} and enabledPlugins {<id>: bool}.
// - OpenCode: a deny rule per hidden skill (its skill id is the folder name too; the last matching rule wins).
// Both checked against the real agents (Claude Code 2.x, OpenCode 2.3) before this was written.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

export type Scopes = { skills: Record<string, string[]>; plugins: Record<string, string[]> }
/** For one session: the skills it doesn't get, and the plugins it turns on (true) or off (false). */
export type SessionSkills = { hide: string[]; plugins: Record<string, boolean> }

export const MAX_FOLDERS = 50
export const scopesFile = () => join(homedir(), '.local', 'share', 'devdash', 'skill-scopes.json')
const projectsRoot = () => process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'

const list = (v: unknown) => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string' && f.startsWith('/')) : [])
const table = (v: unknown): Record<string, string[]> =>
  Object.fromEntries(Object.entries(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}).map(([k, f]) => [k, list(f)] as const).filter(([, f]) => f.length))

export async function readScopes(): Promise<Scopes> {
  try {
    const v = JSON.parse(await readFile(scopesFile(), 'utf8')) as Record<string, unknown>
    return { skills: table(v.skills), plugins: table(v.plugins) }
  } catch {
    return { skills: {}, plugins: {} }
  }
}

/** Sets (or, with null, clears: everywhere again) where one skill or plugin is used. */
export async function setScope(kind: keyof Scopes, key: string, folders: string[] | null) {
  const s = await readScopes()
  if (folders) s[kind][key] = folders
  else delete s[kind][key]
  const file = scopesFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

/** Is `cwd` in one of `folders`? A project's folder also covers its session worktrees (<root>/worktrees/<slug>/…). Pure. */
export function within(folders: string[], cwd: string, root = projectsRoot()) {
  return folders.some((f) => {
    if (cwd === f || cwd.startsWith(`${f}/`)) return true
    const slug = f.startsWith(`${root}/projects/`) ? f.slice(root.length + 10) : ''
    return /^[a-z0-9][a-z0-9-]*$/.test(slug) && cwd.startsWith(`${root}/worktrees/${slug}/`)
  })
}

/** What a session in `cwd` gets. Pure. */
export function forSession(s: Scopes, cwd: string, root?: string): SessionSkills {
  return {
    hide: Object.entries(s.skills).filter(([, f]) => !within(f, cwd, root)).map(([name]) => name),
    plugins: Object.fromEntries(Object.entries(s.plugins).map(([id, f]) => [id, within(f, cwd, root)])),
  }
}

export const sessionSkills = async (cwd: string) => forSession(await readScopes(), cwd)

/** The folders as given (absolute, or ~ for the member's home), checked and tidied. Throws what's wrong. Pure. */
export function cleanFolders(v: unknown, home = homedir()): string[] {
  if (!Array.isArray(v) || !v.length) throw new Error('Pick at least one folder, or use it everywhere.')
  if (v.length > MAX_FOLDERS) throw new Error(`At most ${MAX_FOLDERS} folders.`)
  const out = new Set<string>()
  for (const raw of v) {
    if (typeof raw !== 'string') throw new Error('Folders are paths, like ~/projects/app.')
    let f = raw.trim()
    if (f === '~' || f.startsWith('~/')) f = home + f.slice(1)
    if (!f.startsWith('/') || f.length > 500 || /[\0\n\r]/.test(f) || f.split('/').includes('..')) throw new Error(`${raw} is not a full folder path, like ~/projects/app.`)
    f = normalize(f).replace(/\/+$/, '')
    if (!f) throw new Error('Not the whole server: pick folders in it.')
    out.add(f)
  }
  return [...out]
}
