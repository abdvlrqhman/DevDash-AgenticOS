// Which links and code spans in Claude's replies are files, and where they are (pure, so it can be tested on its own).
// Conservative on purpose: `npm test` or `origin/main` stay code; `docs/guide.md` and `/srv/x/README.md:12` open.

/**
 * `also`: where else a relative path may point, tried in order if `path` doesn't exist. In the viewer: `finding` while
 * it looks, and `matches` when the name turned up in several places and the person picks.
 */
export type FileRef = { path: string; line?: number; also?: string[]; finding?: boolean; matches?: string[] }
/** Opening a file from text: where it resolved, `said` (the path as written) and folders to search if it isn't there. */
export type Opening = { path: string; line?: number; also?: string[]; said?: string; lookIn?: string[] }
/**
 * `cwd`: the folder a relative path is relative to; `base`: the session's own folder, tried next when Claude had moved;
 * `near`: folders named in the same reply.
 */
export type Where = { cwd?: string; base?: string; username?: string; near?: string[] }

/** Extensions of files people and Claude mention. A bare name (no folder) needs one of these to count. */
const EXT = new Set(`md mdx markdown txt text rst adoc tex json jsonc json5 yaml yml toml ini cfg conf env lock log csv tsv xml html htm css scss sass less
  js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi rb go rs java kt kts swift m mm c h cc cpp hpp cs fs php sh bash zsh fish ps1 bat sql graphql gql
  proto dart lua pl r scala ex exs erl hs ml clj nix tf hcl gradle properties patch diff svg png jpg jpeg gif webp ico avif bmp pdf ipynb prisma
  sqlite db service plist gitignore dockerignore editorconfig npmrc nvmrc`.split(/\s+/))
/** Files with no extension that are still clearly files. */
const NAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'Caddyfile', 'Procfile', 'Gemfile', 'Rakefile', 'Justfile', 'LICENSE', 'README', 'CHANGELOG', 'CLAUDE', 'AGENTS'])

/** "a/b.ts:42:7" → "a/b.ts", 42; "a/b.ts#L42" → "a/b.ts", 42. */
export function splitLine(s: string): FileRef {
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s)
  return m ? { path: m[1]!, line: Number(m[2] ?? m[3]) } : { path: s }
}

/** "a/./b/../c" → "a/c"; keeps a leading slash. */
export function normalize(p: string) {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${p.startsWith('/') ? '/' : ''}${out.join('/')}`
}

/**
 * Where a path as Claude wrote it can be: "~/" is the session owner's home; the rest is relative to the folder Claude was
 * in when it wrote it, else the session's own folder (Claude may name a file from the project's top even after a cd).
 */
export function resolvePaths(p: string, { cwd, base, username, near }: Where): string[] {
  if (p.startsWith('/')) return [normalize(p)]
  if (p === '~' || p.startsWith('~/')) return username ? [normalize(`/home/${username}${p.slice(1)}`)] : []
  const dirs = [cwd, base, mainCheckout(cwd), mainCheckout(base), ...(near ?? [])].filter((d): d is string => !!d)
  return [...new Set(dirs.map((d) => normalize(`${d}/${p}`)))].slice(0, 8)
}

/** Files Claude worked on (full paths, most recent first) that a relative path it wrote names: theirs ends with it. */
export function knownFor(said: string, touched: string[]): string[] {
  const rel = normalize(splitLine(said.trim()).path)
  if (!rel || rel.startsWith('/') || rel.startsWith('~') || rel.startsWith('..')) return []
  return touched.filter((t) => t.endsWith(`/${rel}`)).slice(0, 4)
}

/** For a folder in a session's worktree (<root>/worktrees/<project>/<id>/…), the same folder in the project's main checkout. */
export function mainCheckout(dir?: string) {
  const m = dir ? /^(.*)\/worktrees\/([^/]+)\/[^/]+(\/.*)?$/.exec(dir) : null
  return m ? `${m[1]}/projects/${m[2]}${m[3] ?? ''}` : undefined
}

/** Where to look for a file Claude named that isn't where its words point: the folders named nearby, the project, the session's. */
export function lookIn({ cwd, base, near }: Where): string[] {
  return [...new Set([...(near ?? []), mainCheckout(base ?? cwd), base, cwd].filter((d): d is string => !!d))].slice(0, 6)
}

/** Folders a reply names (`games/puzzle/store/`, a file's folder): a bare file name further on may be in one of them. */
export function foldersIn(text: string, where: Where): string[] {
  const plain: Where = { cwd: where.cwd, username: where.username }
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:^|[\s(`'"])((?:~|\.{1,2})?\/?[\w@.+-]+(?:\/[\w@.+-]+)+\/?)(?=$|[\s)`'",:;])/gm)) {
    const t = m[1]!
    if (t.includes('://')) continue
    const abs = t.endsWith('/') ? resolvePath(t.replace(/\/+$/, ''), plain) : codeFile(t, plain)?.path && folderOf(codeFile(t, plain)!.path)
    if (abs && abs !== where.cwd && abs !== where.base && abs !== '/') out.add(abs)
    if (out.size >= 4) break
  }
  return [...out]
}
export const resolvePath = (p: string, where: Where) => resolvePaths(p, where)[0] ?? null

const ref = (paths: string[], line?: number): FileRef | null =>
  paths[0] ? { path: paths[0], line, ...(paths.length > 1 ? { also: paths.slice(1) } : {}) } : null

/** The last part names a file: a known extension, or a known extension-less name. With a folder in front, any extension will do. */
function looksLikeFile(p: string) {
  const name = p.replace(/\/+$/, '').split('/').pop() ?? ''
  if (NAMES.has(name) || NAMES.has(name.replace(/\.[^.]+$/, ''))) return true
  if (/^\.[a-z]+(\.[\w-]+)?$/i.test(name)) return EXT.has(name.split('.')[1]!.toLowerCase()) // .env, .env.local, .gitignore
  const ext = /\.([A-Za-z0-9_-]{1,12})$/.exec(name)?.[1]?.toLowerCase()
  if (!ext || !/[a-z]/.test(ext)) return false
  if (p.includes('/')) return true
  // On its own, `console.log` and `process.env` are code, not files.
  return EXT.has(ext) && !(ext === 'log' || ext === 'env')
}

/** An inline code span that is a file path (`docs/guide.md`, `src/main.tsx:42`, `/srv/x/README.md`), or null. */
export function codeFile(text: string, where: Where): FileRef | null {
  const t = text.trim()
  if (!t || t.length > 400 || !/^[\w@~.+\-/[\]]+(?::\d+(?::\d+)?)?$/.test(t) || /^-|^@|:\/\//.test(t) || t.includes('//')) return null
  const { path, line } = splitLine(t)
  if (!looksLikeFile(path)) return null
  return ref(resolvePaths(path, where), line)
}

/** A markdown link's target that is a file (absolute, ~/, ./, ../, file://, or a relative path to a file), or null for web links. */
export function hrefFile(href: string, where: Where): FileRef | null {
  let h = href.trim()
  if (!h || h.startsWith('#') || h.startsWith('//')) return null
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, '')
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null // http:, mailto: and the like
  try { h = decodeURIComponent(h) } catch { /* keep as written */ }
  const { path, line } = splitLine(h.replace(/[?].*$/, ''))
  const explicit = /^(\/|~\/|\.\.?\/)/.test(path)
  if (!explicit && !looksLikeFile(path)) return null
  return ref(resolvePaths(path, where), line)
}

/** The folder a file is in. */
export const folderOf = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

export type FileKind = 'markdown' | 'image' | 'pdf' | 'text'
const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }

/** How the viewer shows a file, by its name. Anything not markdown, an image or a PDF is tried as text. */
export function fileKind(name: string): { kind: FileKind; mime?: string } {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return { kind: 'markdown' }
  if (IMAGES[ext]) return { kind: 'image', mime: IMAGES[ext] }
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  return { kind: 'text' }
}
