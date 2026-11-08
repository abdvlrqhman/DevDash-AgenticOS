// Skills (a folder with a SKILL.md) for the member's agents, managed from DevDash's Skills page, all as the member.
// - My skills live in ~/.claude/skills, which Claude Code's default profile and OpenCode both read. Extra Claude profiles
//   run with CLAUDE_CONFIG_DIR and read only <profile>/skills, so each of My skills is linked into every profile there.
//   Turning one off moves it out of every folder an agent scans.
// - A project's skills are its .claude/skills, committed on their own (only that path) so the team gets them.
// - Uploads and GitHub links are unpacked into a new empty review folder first. Nothing from a skill runs, ever: no
//   interpreter, no build step, no git hooks; links and oversized archives are refused. It installs only once the member
//   has looked at it and confirmed.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { PLUGIN_DIR, profileDir, profileNames } from './claude.ts'

const run = promisify(execFile)

// ---------- Rules (pure, tested) ----------

/** Claude's and OpenCode's portable skill name: lowercase letters and digits in hyphen-separated words, up to 64. */
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const DESCRIPTION_MAX = 1024
/** Folders already on disk (made by hand or by another tool) may be named more loosely; only these are touched. */
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Why a skill name can't be used, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return 'Give the skill a name.'
  if (name.length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`
  if (!NAME_RE.test(name)) return 'Use lowercase letters, digits and single hyphens (like pdf-tools), starting and ending with a letter or digit.'
  return null
}

/** Why a description can't be used, or null. Agents pick a skill by its description, so it is required. */
export function descriptionProblem(d: string): string | null {
  if (!d.trim()) return 'Say what the skill does and when to use it.'
  if (d.length > DESCRIPTION_MAX) return `Descriptions are at most ${DESCRIPTION_MAX} characters.`
  if (/[<>]/.test(d)) return 'Descriptions cannot contain < or >.'
  return null
}

const unquote = (v: string) => {
  const t = v.trim()
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t) as string } catch { return t.slice(1, -1) }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/**
 * The name and description from SKILL.md's frontmatter, and the body after it. A small YAML subset: top-level
 * `key: value`, quoted values, `|`/`>` blocks and indented continuation lines; nested maps are skipped.
 */
export function parseSkillMd(text: string): { name: string | null; description: string | null; body: string; frontmatter: boolean } {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t)
  if (!m) return { name: null, description: null, body: t, frontmatter: false }
  const lines = m[1]!.split('\n')
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    const raw = kv[2]!.trim()
    const more: string[] = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (lines[i + 1]!.trim() === '' && i + 2 < lines.length && /^\s+\S/.test(lines[i + 2]!)))) more.push(lines[++i]!)
    if (/^[|>][+-]?$/.test(raw)) {
      const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
      const body = more.map((l) => l.slice(indent))
      fields[key] = (raw.startsWith('|') ? body.join('\n') : body.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ')).trim()
    } else if (more.length && !raw) {
      continue // a nested map (metadata: …), not a value
    } else {
      fields[key] = unquote([raw, ...more.map((l) => l.trim())].join(' '))
    }
  }
  return { name: fields.name || null, description: fields.description || null, body: t.slice(m[0].length), frontmatter: true }
}

/** A SKILL.md for a skill written in DevDash. A JSON string is a valid YAML double-quoted scalar. */
export function buildSkillMd(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim().replace(/\s*\n\s*/g, ' '))}\n---\n\n${body.trim()}\n`
}

export type GithubRef = { owner: string; repo: string; /** Segments after /tree/ or /blob/: a ref, then a path. */ rest: string[]; blob: boolean }

/** A GitHub repo URL, or one pointing at a folder (/tree/<ref>/<path>) or a file in it (/blob/…). Null if it isn't one. */
export function parseGithubUrl(input: string): GithubRef | null {
  let s = input.trim()
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  // URL() would quietly resolve /../ in the path; a link that has one is refused instead.
  if (/\/(\.|%2e){1,2}(\/|$|[?#])/i.test(s)) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (!/^(www\.)?github\.com$/i.test(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) return null
  let segs: string[]
  try { segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { return null }
  if (segs.length < 2) return null
  const owner = segs[0]!
  const repo = segs[1]!.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) return null
  if (segs.length === 2) return { owner, repo, rest: [], blob: false }
  const kind = segs[2]
  if (kind !== 'tree' && kind !== 'blob') return null
  const rest = segs.slice(3)
  if (!rest.length || rest.some((x) => x === '.' || x === '..' || /[\\\0\n\r]/.test(x) || x.startsWith('-'))) return null
  return { owner, repo, rest, blob: kind === 'blob' }
}

/**
 * Splits /tree/<segments> into a ref and a path: refs may contain slashes, so the longest one the repo has wins;
 * otherwise the first segment is the ref (a commit SHA, say). A /blob/ link means the folder that file is in.
 */
export function splitRef(g: GithubRef, refs: string[]): { ref: string | null; path: string } {
  if (!g.rest.length) return { ref: null, path: '' }
  const known = new Set(refs)
  let n = 1
  for (let k = g.rest.length; k >= 1; k--) if (known.has(g.rest.slice(0, k).join('/'))) { n = k; break }
  let path = g.rest.slice(n)
  if (g.blob) path = path.slice(0, -1)
  return { ref: g.rest.slice(0, n).join('/'), path: path.join('/') }
}

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|ksh|py|pyw|js|mjs|cjs|ts|mts|cts|jsx|tsx|rb|pl|pm|php|ps1|psm1|bat|cmd|vbs|lua|r|swift|go|rs|java|kt|scala|groovy|tcl|awk|applescript|scpt|jar|exe|dll|so|dylib|bin|run|command|app|msi|deb|rpm|appimage|wasm)$/i

export type FileKind = 'text' | 'script' | 'binary'
/** What a file is, from its name, its first bytes and its mode: anything that could run is a script or a binary. */
export function fileKind(path: string, head: Buffer): FileKind {
  if (head.subarray(0, 2).toString() === '#!') return 'script'
  if (head.includes(0)) return 'binary'
  if (SCRIPT_EXT.test(path)) return 'script'
  return 'text'
}

// ---------- Places ----------

const home = () => homedir()
export const mySkillsDir = () => join(home(), '.claude', 'skills')
/** Turned-off skills: outside every folder Claude Code or OpenCode scans. */
export const offDir = () => join(home(), '.local', 'share', 'devdash', 'skills-off')
const reviewsDir = () => join(home(), '.cache', 'devdash', 'skill-review')
const projectsRoot = () => process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
/** Only a project's main checkout: <root>/projects/<slug>. */
const projectRe = () => new RegExp(`^${projectsRoot().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects/[a-z0-9][a-z0-9-]{0,39}$`)
const projectSkillsDir = (p: string) => join(p, '.claude', 'skills')
const SOURCE = '.devdash-source.json'
const REVIEW_TTL_MS = 2 * 60 * 60_000

function checkedProject(p: unknown) {
  if (typeof p !== 'string' || !projectRe().test(p) || !existsSync(join(p, '.git'))) throw new Error('not a DevDash project folder')
  return p
}
function checkedFolder(name: unknown) {
  if (typeof name !== 'string' || !FOLDER_RE.test(name)) throw new Error('invalid skill name')
  return name
}

// ---------- Limits ----------

const MB = 1024 * 1024
export const LIMITS = {
  /** A .zip or .skill upload. */
  archive: 10 * MB,
  /** Everything an upload unpacks to, or a GitHub folder checks out to. */
  total: 100 * MB,
  files: 5000,
  /** One skill folder. */
  skill: 20 * MB,
  skillFiles: 500,
  ratio: 100,
}
const SHOWN_MD = 256 * 1024

// ---------- Reading skill folders ----------

export type SkillFile = { path: string; size: number; kind: FileKind; executable: boolean; link: boolean }
export type Source =
  | { kind: 'github'; url: string; repo: string; ref: string | null; path: string; sha: string; installedAt: number }
  | { kind: 'upload'; file: string; installedAt: number }
  | { kind: 'written'; installedAt: number }

async function head(path: string) {
  const fh = await open(path, 'r')
  try {
    const b = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(b, 0, 4096, 0)
    return b.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Every file in a skill folder, with its size and what it is. Links are listed (as links), never followed. */
export async function filesOf(dir: string, max = LIMITS.skillFiles * 4): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  const walk = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return
      const p = join(d, e.name)
      const rel = relative(dir, p)
      if (rel === SOURCE) continue
      if (e.isSymbolicLink()) { out.push({ path: rel, size: 0, kind: 'text', executable: false, link: true }); continue }
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.isFile()) { out.push({ path: rel, size: 0, kind: 'binary', executable: false, link: true }); continue } // fifo, device…
      const s = await lstat(p)
      out.push({ path: rel, size: s.size, kind: fileKind(rel, await head(p)), executable: (s.mode & 0o111) !== 0, link: false })
    }
  }
  await walk(dir)
  return out
}

async function readSource(dir: string): Promise<Source | null> {
  try {
    const v = JSON.parse(await readFile(join(dir, SOURCE), 'utf8')) as Source
    return v && typeof v === 'object' && typeof v.kind === 'string' ? v : null
  } catch {
    return null
  }
}

async function readMd(dir: string) {
  try {
    const fh = await open(join(dir, 'SKILL.md'), 'r')
    try {
      const b = Buffer.alloc(SHOWN_MD)
      const { bytesRead } = await fh.read(b, 0, SHOWN_MD, 0)
      return b.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/** The skill folders directly under `dir` (each has a SKILL.md). Folders named in `skip` and hidden ones are left out. */
async function skillFolders(dir: string, skip: string[] = []) {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: { name: string; dir: string; linked: boolean }[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || skip.includes(name)) continue
    const p = join(dir, name)
    const l = await lstat(p).catch(() => null)
    if (!l) continue
    const linked = l.isSymbolicLink()
    const s = linked ? await stat(p).catch(() => null) : l
    if (s?.isDirectory() && existsSync(join(p, 'SKILL.md'))) out.push({ name, dir: p, linked })
  }
  return out
}

async function summary(f: { name: string; dir: string; linked: boolean }) {
  const md = parseSkillMd((await readMd(f.dir)) ?? '')
  const files = await filesOf(f.dir).catch(() => [] as SkillFile[])
  return {
    name: f.name,
    title: md.name,
    description: md.description,
    linked: f.linked,
    files: files.length,
    runs: files.some((x) => x.kind !== 'text' || x.executable),
    source: await readSource(f.dir),
  }
}

async function detail(dir: string, name: string, extra: Record<string, unknown>) {
  const text = await readMd(dir)
  if (text === null) throw new Error('That skill is not there anymore.')
  const md = parseSkillMd(text)
  return {
    name, title: md.name, description: md.description, markdown: text, files: await filesOf(dir), source: await readSource(dir),
    path: dir, linked: (await lstat(dir)).isSymbolicLink(), ...extra,
  }
}

// ---------- Copying and linking ----------

/** Copies a reviewed folder: regular files and folders only, sane modes (no setuid), never a link. */
async function copyTree(from: string, to: string, shared: boolean) {
  await mkdir(to, { recursive: true, mode: shared ? 0o2775 : 0o755 })
  for (const e of await readdir(from, { withFileTypes: true })) {
    const a = join(from, e.name)
    const b = join(to, e.name)
    if (e.isDirectory()) await copyTree(a, b, shared)
    else if (e.isFile()) {
      const exec = ((await lstat(a)).mode & 0o111) !== 0
      await cp(a, b, { errorOnExist: true, force: false })
      await chmod(b, shared ? (exec ? 0o775 : 0o664) : exec ? 0o755 : 0o644)
    } else throw new Error(`${relative(from, a)} is a link or a special file. Skills with those are not installed.`)
  }
}

async function moveTree(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Links each of My skills into every extra Claude profile (they read only <profile>/skills), and removes links to skills
 * that are gone or off. A profile's own skill folders are never touched. Returns names a profile already has of its own.
 */
export async function syncProfiles() {
  const mine = await skillFolders(mySkillsDir())
  const root = mySkillsDir()
  const shadowed: { profile: string; name: string }[] = []
  for (const p of profileNames().filter((n) => n !== 'default')) {
    const dir = join(profileDir(p), 'skills')
    if (!existsSync(profileDir(p))) continue
    await mkdir(dir, { recursive: true })
    for (const s of mine) {
      const link = join(dir, s.name)
      const l = await lstat(link).catch(() => null)
      if (!l) { await symlink(join(root, s.name), link); continue }
      if (l.isSymbolicLink() && (await readlink(link)) === join(root, s.name)) continue
      if (!l.isSymbolicLink()) shadowed.push({ profile: p, name: s.name })
    }
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const link = join(dir, name)
      const l = await lstat(link).catch(() => null)
      if (!l?.isSymbolicLink()) continue
      const target = await readlink(link)
      if (target.startsWith(`${root}/`) && !mine.some((s) => join(root, s.name) === target)) await unlink(link)
    }
  }
  return shadowed
}

// ---------- Built in: DevDash's own and installed plugins' skills ----------

const readJson = async (p: string): Promise<Record<string, any>> => {
  try {
    const v = JSON.parse(await readFile(p, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

async function builtIn() {
  const out: { name: string; description: string | null; from: string; kind: 'devdash' | 'plugin' | 'account'; enabled: boolean; profiles: string[] }[] = []
  for (const f of await skillFolders(join(PLUGIN_DIR, 'skills'))) {
    out.push({ name: `devdash:${f.name}`, description: parseSkillMd((await readMd(f.dir)) ?? '').description, from: 'DevDash, in every session', kind: 'devdash', enabled: true, profiles: [] })
  }
  const seen = new Map<string, (typeof out)[number]>()
  for (const p of profileNames()) {
    const dir = profileDir(p)
    const installed = (await readJson(join(dir, 'plugins', 'installed_plugins.json'))).plugins ?? {}
    const enabled = (await readJson(join(dir, 'settings.json'))).enabledPlugins ?? {}
    for (const [id, versions] of Object.entries(installed as Record<string, { installPath?: string; version?: string }[]>)) {
      const at = versions?.[0]?.installPath
      if (typeof at !== 'string') continue
      const [plugin, market] = id.split('@')
      for (const f of await skillFolders(join(at, 'skills'))) {
        const key = `${plugin}:${f.name}`
        const hit = seen.get(key)
        if (hit) { hit.profiles.push(p); hit.enabled ||= enabled[id] === true; continue }
        const row = { name: key, description: parseSkillMd((await readMd(f.dir)) ?? '').description, from: `Plugin ${plugin}${market ? ` from ${market}` : ''}${versions[0]?.version ? `, ${versions[0].version.slice(0, 12)}` : ''}`, kind: 'plugin' as const, enabled: enabled[id] === true, profiles: [p] }
        seen.set(key, row)
        out.push(row)
      }
    }
    // Skills from the member's Claude account, which Claude Code keeps in sync itself.
    for (const bucket of await readdir(join(dir, 'skills', 'synced')).catch(() => [] as string[])) {
      if (bucket.startsWith('.')) continue
      for (const f of await skillFolders(join(dir, 'skills', 'synced', bucket))) {
        const key = `account:${f.name}`
        const hit = seen.get(key)
        if (hit) { hit.profiles.push(p); continue }
        const row = { name: f.name, description: parseSkillMd((await readMd(f.dir)) ?? '').description, from: 'Your Claude account, kept in sync by Claude Code', kind: 'account' as const, enabled: true, profiles: [p] }
        seen.set(key, row)
        out.push(row)
      }
    }
  }
  return out
}

// ---------- Review (uploads and GitHub links) ----------

const ID_RE = /^[a-f0-9]{24}$/
type ReviewMeta = { id: string; createdAt: number; source: { kind: 'github'; url: string; repo: string; ref: string | null; path: string; sha: string } | { kind: 'upload'; file: string } }

async function newReview() {
  await mkdir(reviewsDir(), { recursive: true, mode: 0o700 })
  // Old reviews nobody finished: gone after two hours.
  for (const id of await readdir(reviewsDir()).catch(() => [] as string[])) {
    const s = await stat(join(reviewsDir(), id)).catch(() => null)
    if (s && Date.now() - s.mtimeMs > REVIEW_TTL_MS) await rm(join(reviewsDir(), id), { recursive: true, force: true }).catch(() => {})
  }
  const id = randomBytes(12).toString('hex')
  const dir = join(reviewsDir(), id)
  await mkdir(join(dir, 'src'), { recursive: true, mode: 0o700 }) // new and empty: nothing in it but what we fetch
  return { id, dir, src: join(dir, 'src') }
}
const reviewDir = (id: unknown) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('bad review id')
  const dir = join(reviewsDir(), id)
  if (!existsSync(join(dir, 'meta.json'))) throw new Error('This review has expired. Add the skill again.')
  return dir
}

/** Walk a fetched or unpacked tree: refuse links, count bytes and files. */
async function vetTree(dir: string) {
  let bytes = 0
  let files = 0
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) throw new Error(`It contains a link (${relative(dir, p)}). Skills with links are not installed.`)
      if (e.isDirectory()) { if (e.name !== '.git') await walk(p); continue }
      if (!e.isFile()) throw new Error(`It contains a special file (${relative(dir, p)}).`)
      bytes += (await lstat(p)).size
      if (++files > LIMITS.files) throw new Error(`It has more than ${LIMITS.files} files.`)
      if (bytes > LIMITS.total) throw new Error(`It is bigger than ${LIMITS.total / MB} MB.`)
    }
  }
  await walk(dir)
}

/** The SKILL.md folders in a tree, at most six levels down; a skill's own subfolders aren't searched. */
export async function findSkills(root: string) {
  const out: string[] = []
  const walk = async (d: string, depth: number) => {
    if (existsSync(join(d, 'SKILL.md')) && (await lstat(join(d, 'SKILL.md'))).isFile()) return void out.push(d)
    if (depth >= 6) return
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(join(d, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

/** Which existing skills an install under `name` would meet. */
async function collisions(name: string, project?: string) {
  const out: string[] = []
  if (NAME_RE.test(name) || FOLDER_RE.test(name)) {
    if (existsSync(join(mySkillsDir(), name))) out.push('personal')
    if (existsSync(join(offDir(), name))) out.push('personal-off')
    if (project && existsSync(join(projectSkillsDir(project), name))) out.push('project')
    if (existsSync(join(PLUGIN_DIR, 'skills', name))) out.push('devdash')
  }
  return out
}

async function describeReview(dir: string, project?: string) {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as ReviewMeta
  const src = join(dir, 'src')
  const base = meta.source.kind === 'github' && meta.source.path ? join(src, meta.source.path) : src
  const skills = []
  for (const d of await findSkills(base)) {
    const text = (await readMd(d)) ?? ''
    const md = parseSkillMd(text)
    const files = await filesOf(d)
    const folder = d === src ? (meta.source.kind === 'github' ? meta.source.repo.split('/')[1]!.toLowerCase() : 'skill') : d.split('/').pop()!
    const suggested = md.name && !nameProblem(md.name) ? md.name : folder.toLowerCase()
    const size = files.reduce((n, f) => n + f.size, 0)
    const problems = [
      ...(!md.frontmatter ? ['SKILL.md has no frontmatter (the --- block with name and description).'] : []),
      ...(md.description ? (descriptionProblem(md.description) ? [descriptionProblem(md.description)!] : []) : ['SKILL.md has no description, so agents would not know when to use it.']),
      ...(files.some((f) => f.link) ? ['It contains a link or a special file. Skills with those are not installed.'] : []),
      ...(size > LIMITS.skill ? [`It is bigger than ${LIMITS.skill / MB} MB.`] : []),
      ...(files.length > LIMITS.skillFiles ? [`It has more than ${LIMITS.skillFiles} files.`] : []),
    ]
    skills.push({
      path: relative(src, d), folder, title: md.name, description: md.description, markdown: text, files, size, suggested,
      nameProblem: nameProblem(suggested), problems, collisions: await collisions(suggested, project),
    })
  }
  return { id: meta.id, source: meta.source, skills }
}

async function gitIn(dir: string, args: string[], timeout = 120_000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_LFS_SKIP_SMUDGE: '1' }
  // No hooks, no symlinks on disk, no file:// or other protocols: only the https URL built from the parsed link.
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.fsmonitor=false']
  try {
    return (await run('git', ['-C', dir, ...safe, ...args], { env, timeout, maxBuffer: 32 * MB })).stdout
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message: string }
    if (e.killed) throw new Error('GitHub took too long. Try a link to the skill\'s own folder (…/tree/main/<folder>).')
    const text = (e.stderr || e.message).trim()
    if (/could not read Username|Authentication failed|Repository not found|terminal prompts disabled/i.test(text)) {
      throw new Error('GitHub did not give access to that repository. If it is private, connect GitHub in DevDash (Agent setup) first.')
    }
    if (/couldn't find remote ref|not our ref|unadvertised object/i.test(text)) throw new Error('That branch, tag or commit is not in the repository.')
    throw new Error(text.split('\n').filter(Boolean).pop() ?? 'git failed')
  }
}

async function reviewGithub(r: Record<string, unknown>) {
  const url = String(r.url ?? '')
  const g = parseGithubUrl(url)
  if (!g) throw new Error('Paste a GitHub link to a repository or a folder in it, like https://github.com/owner/repo/tree/main/skills/pdf.')
  const remote = `https://github.com/${g.owner}/${g.repo}.git`
  const { id, dir, src } = await newReview()
  try {
    await gitIn(src, ['init', '--quiet'])
    let refs: string[] = []
    if (g.rest.length > 1) {
      const out = await gitIn(src, ['ls-remote', '--heads', '--tags', remote], 60_000)
      refs = out.split('\n').map((l) => l.split('\t')[1] ?? '').map((x) => x.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, '')).filter(Boolean)
    }
    const { ref, path } = splitRef(g, refs)
    // A folder: only its files are downloaded (on checkout). A whole repo: one download, faster than file by file.
    await gitIn(src, ['fetch', '--quiet', '--depth', '1', ...(path ? ['--filter=blob:none'] : []), '--no-tags', '--no-recurse-submodules', remote, ref ?? 'HEAD'])
    const sha = (await gitIn(src, ['rev-parse', 'FETCH_HEAD^{commit}'])).trim()
    // What's there, before anything is written: links (mode 120000) and submodules (160000) are refused, size is capped.
    const tree = (await gitIn(src, ['ls-tree', '-r', '-z', '--full-tree', sha, ...(path ? ['--', path] : [])])).split('\0').filter(Boolean)
    if (!tree.length) throw new Error(path ? `There is no folder ${path} in that repository.` : 'That repository is empty.')
    if (tree.length > LIMITS.files) throw new Error(`That has more than ${LIMITS.files} files. Paste a link to the skill's own folder instead.`)
    const links = tree.filter((l) => /^120000 |^160000 /.test(l)).map((l) => l.split('\t')[1]!)
    await gitIn(src, ['checkout', '--quiet', sha, '--', path || '.'], 180_000)
    await rm(join(src, '.git'), { recursive: true, force: true })
    // core.symlinks=false wrote links as small text files; take them out so no one installs a skill that had one.
    for (const l of links) await rm(join(src, l), { recursive: true, force: true })
    await vetTree(src)
    if (links.length) await writeFile(join(dir, 'links.json'), JSON.stringify(links))
    const meta: ReviewMeta = { id, createdAt: Date.now(), source: { kind: 'github', url: url.trim(), repo: `${g.owner}/${g.repo}`, ref, path, sha } }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
    const review = await describeReview(dir, r.project ? checkedProject(r.project) : undefined)
    if (!review.skills.length) throw new Error(links.length ? 'The skills there are links to other folders, which DevDash does not install.' : 'There is no SKILL.md in that folder or under it.')
    return withLinks(review, links)
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** A skill whose folder had links in the repository: they were left out, so it is not installable as it was. */
function withLinks<T extends { skills: { path: string; problems: string[] }[] }>(review: T, links: string[]) {
  for (const s of review.skills) {
    if (links.some((l) => l === s.path || l.startsWith(`${s.path}/`) || s.path === '')) s.problems.push('It had links in the repository, which were left out. Skills with links are not installed.')
  }
  return review
}

/** zipinfo's listing: each entry's type letter (l = link, d = folder) and size, in archive order. */
export function parseZipinfo(listing: string) {
  return listing.split('\n').filter((l) => /^[-a-z?][-rwxstSTa-z?]{2,9}\s/.test(l)).map((l) => {
    const cols = l.trim().split(/\s+/)
    return { type: l[0]!, size: Number(cols[3]) || 0 }
  })
}

/** Checks an archive's entry names and listing before anything is unpacked. Throws the reason it's refused. */
export function vetZip(names: string[], entries: { type: string; size: number }[], compressed: number) {
  if (!names.length) throw new Error('That file is empty.')
  if (names.length > LIMITS.files) throw new Error(`That archive has more than ${LIMITS.files} files.`)
  for (const n of names) {
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\\') || /[\0-\x1f]/.test(n) || n.split('/').some((s) => s === '..')) {
      throw new Error('That archive has unsafe paths in it. It was not unpacked.')
    }
  }
  if (entries.some((e) => e.type === 'l')) throw new Error('That archive contains links. Skills with links are not installed.')
  if (entries.some((e) => e.type !== '-' && e.type !== 'd')) throw new Error('That archive contains special files. It was not unpacked.')
  const total = entries.reduce((n, e) => n + e.size, 0)
  if (total > LIMITS.total) throw new Error(`That archive unpacks to more than ${LIMITS.total / MB} MB.`)
  if (compressed > 0 && total > 5 * MB && total / compressed > LIMITS.ratio) throw new Error('That archive looks like a zip bomb. It was not unpacked.')
}

async function reviewUpload(r: Record<string, unknown>) {
  const file = String(r.fileName ?? 'skill.zip').slice(0, 200)
  if (!/\.(zip|skill)$/i.test(file)) throw new Error('Upload a .zip or .skill file.')
  const data = Buffer.from(String(r.data ?? ''), 'base64')
  if (!data.length) throw new Error('That file is empty.')
  if (data.length > LIMITS.archive) throw new Error(`Skill archives are at most ${LIMITS.archive / MB} MB.`)
  const { id, dir, src } = await newReview()
  try {
    const zip = join(dir, 'upload.zip')
    await writeFile(zip, data, { mode: 0o600 })
    const names = (await run('unzip', ['-Z', '-1', zip], { maxBuffer: 16 * MB }).catch(() => { throw new Error('That is not a .zip archive (a .skill file is one).') })).stdout.split('\n').filter((s) => s.length)
    const entries = parseZipinfo((await run('unzip', ['-Z', zip], { maxBuffer: 16 * MB })).stdout)
    if (entries.length !== names.length) throw new Error('That archive could not be read safely.')
    vetZip(names, entries, data.length)
    // Into the new empty folder, never over anything (-n); no interpreter or build step involved.
    await run('unzip', ['-qq', '-n', zip, '-d', src], { timeout: 120_000, maxBuffer: 16 * MB })
    await rm(zip, { force: true })
    await vetTree(src) // belt and braces: no links, within the limits
    const meta: ReviewMeta = { id, createdAt: Date.now(), source: { kind: 'upload', file } }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
    const review = await describeReview(dir, r.project ? checkedProject(r.project) : undefined)
    if (!review.skills.length) throw new Error('There is no SKILL.md in that archive.')
    return review
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

// ---------- Project commits ----------

async function identity(cwd: string) {
  const email = await run('git', ['-C', cwd, 'config', 'user.email']).then((x) => x.stdout.trim()).catch(() => '')
  if (email) return []
  const me = userInfo().username
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@users.noreply.devdash`]
}

/**
 * Commits only .claude/skills/<name> in the project's checkout, as the member: whatever else is changed or staged there
 * stays as it was. No hooks run (nothing in a skill may run while it installs).
 */
export async function commitSkill(project: string, name: string, message: string) {
  const path = `.claude/skills/${name}`
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const g = async (args: string[]) => (await run('git', ['-C', project, ...args], { env, timeout: 60_000, maxBuffer: 16 * MB })).stdout
  try {
    await g(['add', '--force', '--all', '--', path])
    const staged = (await g(['diff', '--cached', '--name-only', '--', path])).trim()
    if (!staged) return { sha: null, branch: (await g(['branch', '--show-current'])).trim() || null }
    await g([...(await identity(project)), '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', message, '--only', '--', path])
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    const text = (e.stderr || e.message).trim()
    if (/partial commit during a merge|cannot do a partial commit/i.test(text)) throw new Error('The project\'s checkout is in the middle of a merge. Finish it first.')
    throw new Error(`Could not commit the skill: ${text.split('\n').filter(Boolean).pop() ?? 'git failed'}`)
  }
  return { sha: (await g(['rev-parse', 'HEAD'])).trim(), branch: (await g(['branch', '--show-current'])).trim() || null }
}

/** Where the checkout's branch stands against GitHub, for "Push" after a skill commit. */
async function pushState(project: string) {
  const g = (args: string[]) => run('git', ['-C', project, ...args], { timeout: 20_000 }).then((x) => x.stdout.trim()).catch(() => '')
  const branch = await g(['branch', '--show-current'])
  const upstream = branch ? await g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : ''
  const ahead = upstream ? Number(await g(['rev-list', '--count', '@{u}..HEAD'])) || 0 : 0
  return { branch: branch || null, upstream: upstream || null, ahead }
}

async function pushProject(project: string) {
  const s = await pushState(project)
  if (!s.branch || !s.upstream) throw new Error('This checkout has no GitHub branch to push to.')
  const [remote, ...rest] = s.upstream.split('/')
  try {
    // Never forced: if GitHub has moved on, this fails and says so.
    await run('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', remote!, `HEAD:refs/heads/${rest.join('/')}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes' }, timeout: 120_000,
    })
  } catch (err) {
    const text = ((err as { stderr?: string }).stderr || (err as Error).message).trim()
    if (/rejected|non-fast-forward|fetch first/i.test(text)) throw new Error('GitHub has newer commits on this branch. Bring the checkout up to date first, then push.')
    if (/could not read Username|Authentication failed|Permission denied|Repository not found/i.test(text)) throw new Error('GitHub did not let you push. Connect GitHub in DevDash (Agent setup) first.')
    throw new Error(text.split('\n').filter(Boolean).pop() ?? 'push failed')
  }
  return pushState(project)
}

// ---------- Ops ----------

type Req = Record<string, unknown>
const scopeOf = (r: Req) => (r.scope === 'project' ? { project: checkedProject(r.project) } : { project: null })
const destDir = (project: string | null, name: string) => join(project ? projectSkillsDir(project) : mySkillsDir(), name)

async function placeSkill(project: string | null, name: string, fill: (dir: string) => Promise<void>, replace: boolean) {
  const dest = destDir(project, name)
  const taken = existsSync(dest) || (!project && existsSync(join(offDir(), name)))
  if (taken && !replace) throw new Error(`A skill called ${name} is already there. Replace it, or pick another name.`)
  // Built next to the review folders first, then moved into place in one step.
  await mkdir(reviewsDir(), { recursive: true, mode: 0o700 })
  const stage = join(reviewsDir(), `.stage-${randomBytes(6).toString('hex')}`)
  try {
    await fill(stage)
    if (taken) {
      await rm(dest, { recursive: true, force: true })
      if (!project) await rm(join(offDir(), name), { recursive: true, force: true })
    }
    await moveTree(stage, dest)
    if (project) await chmod(dest, 0o2775).catch(() => {})
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

async function after(project: string | null, name: string, message: string) {
  if (!project) return { shadowed: await syncProfiles() }
  const commit = await commitSkill(project, name, message)
  return { commit, push: await pushState(project) }
}

export const ops = {
  /** My skills (on and off) and the built-in ones; or a project's skills. */
  async list(r: Req) {
    if (r.project) {
      const project = checkedProject(r.project)
      return { skills: await Promise.all((await skillFolders(projectSkillsDir(project))).map(async (f) => ({ ...(await summary(f)), enabled: true }))), push: await pushState(project) }
    }
    const shadowed = await syncProfiles().catch(() => [])
    const on = await Promise.all((await skillFolders(mySkillsDir(), ['synced'])).map(async (f) => ({ ...(await summary(f)), enabled: true })))
    const off = await Promise.all((await skillFolders(offDir())).map(async (f) => ({ ...(await summary(f)), enabled: false })))
    return { skills: [...on, ...off].sort((a, b) => a.name.localeCompare(b.name)), builtIn: await builtIn(), profiles: profileNames(), shadowed }
  },

  async get(r: Req) {
    const name = checkedFolder(r.name)
    const { project } = scopeOf(r)
    if (project) return { skill: await detail(destDir(project, name), name, { enabled: true }) }
    const on = destDir(null, name)
    if (existsSync(on)) return { skill: await detail(on, name, { enabled: true }) }
    return { skill: await detail(join(offDir(), name), name, { enabled: false }) }
  },

  /** A skill written in DevDash: name, description and body. */
  async write(r: Req) {
    const name = String(r.name ?? '')
    const description = String(r.description ?? '')
    const body = String(r.body ?? '')
    const bad = nameProblem(name) ?? descriptionProblem(description) ?? (body.trim() ? null : 'Write what the agent should do.')
    if (bad) throw new Error(bad)
    if (body.length > 200_000) throw new Error('That is too long for one SKILL.md.')
    const { project } = scopeOf(r)
    await placeSkill(project, name, async (dir) => {
      await mkdir(dir, { recursive: true, mode: project ? 0o2775 : 0o755 })
      await writeFile(join(dir, 'SKILL.md'), buildSkillMd(name, description, body), { mode: project ? 0o664 : 0o644 })
      await writeFile(join(dir, SOURCE), `${JSON.stringify({ kind: 'written', installedAt: Math.floor(Date.now() / 1000) } satisfies Source)}\n`, { mode: project ? 0o664 : 0o644 })
    }, r.replace === true)
    return { name, ...(await after(project, name, `Add skill ${name}\n\nWritten in DevDash.`)) }
  },

  reviewGithub,
  reviewUpload,
  async reviewGet(r: Req) {
    const dir = reviewDir(r.id)
    const review = await describeReview(dir, r.project ? checkedProject(r.project) : undefined)
    const links = JSON.parse(await readFile(join(dir, 'links.json'), 'utf8').catch(() => '[]')) as string[]
    return withLinks(review, links)
  },
  async reviewDiscard(r: Req) {
    if (typeof r.id === 'string' && ID_RE.test(r.id)) await rm(join(reviewsDir(), r.id), { recursive: true, force: true })
    return { ok: true }
  },

  /** Installs one reviewed skill, after the member confirmed it. Copies files only; runs nothing. */
  async install(r: Req) {
    const dir = reviewDir(r.id)
    const { project } = scopeOf(r)
    const review = await ops.reviewGet({ id: r.id, project: project ?? undefined })
    const skill = review.skills.find((s) => s.path === r.path)
    if (!skill) throw new Error('That skill is not in this review.')
    if (skill.problems.length) throw new Error(skill.problems[0]!)
    const name = String(r.name ?? skill.suggested)
    const bad = nameProblem(name)
    if (bad) throw new Error(bad)
    const from = join(dir, 'src', skill.path)
    const real = await realpath(from)
    if (real !== (await realpath(join(dir, 'src'))) && !real.startsWith(`${await realpath(join(dir, 'src'))}/`)) throw new Error('That skill is not in this review.')
    const s = review.source
    const now = Math.floor(Date.now() / 1000)
    const source: Source = s.kind === 'github'
      ? { kind: 'github', url: s.url, repo: s.repo, ref: s.ref, path: skill.path, sha: s.sha, installedAt: now }
      : { kind: 'upload', file: s.file, installedAt: now }
    await placeSkill(project, name, async (stage) => {
      await copyTree(real, stage, !!project)
      await writeFile(join(stage, SOURCE), `${JSON.stringify(source)}\n`, { mode: project ? 0o664 : 0o644 })
    }, r.replace === true)
    const from_ = source.kind === 'github' ? `From https://github.com/${source.repo}/tree/${source.sha}/${source.path} (commit ${source.sha}).` : `Uploaded as ${source.file}.`
    return { name, ...(await after(project, name, `Add skill ${name}\n\n${from_}`)) }
  },

  async remove(r: Req) {
    const name = checkedFolder(r.name)
    const { project } = scopeOf(r)
    if (project) {
      const dest = destDir(project, name)
      if (!existsSync(dest)) throw new Error('That skill is not in this project.')
      await rm(dest, { recursive: true, force: true })
      return after(project, name, `Remove skill ${name}`)
    }
    for (const dest of [destDir(null, name), join(offDir(), name)]) {
      const l = await lstat(dest).catch(() => null)
      if (!l) continue
      if (l.isSymbolicLink()) await unlink(dest) // a link the member made: only the link goes
      else await rm(dest, { recursive: true, force: true })
    }
    return after(null, name, '')
  },

  /** Off moves it out of every scanned folder (and its profile links go); on moves it back. */
  async enable(r: Req) {
    const name = checkedFolder(r.name)
    const on = destDir(null, name)
    const off = join(offDir(), name)
    if (r.enabled === true) {
      if (existsSync(on)) throw new Error(`A skill called ${name} is already on. Remove one of them first.`)
      if (!existsSync(off)) throw new Error('That skill is not there anymore.')
      await moveTree(off, on)
    } else {
      if (!existsSync(on)) throw new Error('That skill is not there anymore.')
      if (existsSync(off)) await rm(off, { recursive: true, force: true })
      await moveTree(on, off)
    }
    return after(null, name, '')
  },

  async push(r: Req) {
    return { push: await pushProject(checkedProject(r.project)) }
  },
}
