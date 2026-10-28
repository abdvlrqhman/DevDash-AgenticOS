import { randomBytes } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { canSeeSql } from '../claude/repo.ts'
import type { TasksService } from '../tasks/service.ts'

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const FETCH_EVERY_MS = 5 * 60_000

type Row = {
  id: number; slug: string; name: string; repo_url: string | null; default_branch: string; created_by: number; created_at: number
  fetched_at: number | null; fetch_error: string | null; archived: number; creator_username: string; creator_name: string
  session_sharing: SessionSharing; instructions: string
  open_tasks: number; sessions: number; working: number; waiting: number; active_people: string; last_session_at: number | null
}

export const SESSION_SHARING = ['private', 'shared', 'shared_can_send'] as const
export type SessionSharing = (typeof SESSION_SHARING)[number]

// `sessions` is what the member asking ($me) can open: their own, ones shared with everyone or with them, team roles' included.
// Live Claude work counts every session in the project, private ones too, but only as numbers and owners' names:
// people see that someone's Claude is in the shared checkout, never what it is doing.
const SELECT = `select p.*, u.username as creator_username, u.name as creator_name,
  (select count(*) from tasks t where t.project_id = p.id and t.status != 'done') as open_tasks,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0 and ${canSeeSql('$me')}) as sessions,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0 and s.status = 'working') as working,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0 and s.status = 'waiting') as waiting,
  (select json_group_array(distinct o.name) from claude_sessions s join users o on o.id = s.owner_id
    where s.project_id = p.id and s.archived = 0 and s.status in ('working', 'waiting')) as active_people,
  (select max(s.last_activity_at) from claude_sessions s where s.project_id = p.id) as last_session_at
  from projects p join users u on u.id = p.created_by`

export const slugify = (s: string) => s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'

/**
 * Projects are shared git checkouts in <root>/projects/<slug>. Git always runs as a member (their own credentials),
 * through their agent: cloning as the creator, fetching every few minutes as the creator, worktrees as the session owner.
 * After every fetch the branches are scanned for "fixes #N" (tasks service).
 */
export function projectsService({ db, hub, agents, activity, tasks, gitSafeDir, root, onFetched }: {
  db: Db; hub: Hub; agents: AgentsService; activity: ActivityService; tasks: TasksService
  gitSafeDir: (path: string) => Promise<void>; root: string
  /** After each repo fetch (and its scan): lets "Ready to review" notice branches merged outside DevDash. Injected by the app. */
  onFetched?: (p: { id: number; slug: string; default_branch: string; creator_username: string }) => Promise<void> | void
}) {
  const q = {
    all: db.prepare(`${SELECT} where p.archived = ? order by p.name`),
    bySlug: db.prepare(`${SELECT} where p.slug = ?`),
    byId: db.prepare(`${SELECT} where p.id = ?`),
    insert: db.prepare('insert into projects (slug, name, repo_url, default_branch, created_by, instructions) values (?, ?, ?, ?, ?, ?) returning id'),
    patch: db.prepare('update projects set name = ?, archived = ?, session_sharing = ?, instructions = ? where id = ?'),
    setRepo: db.prepare('update projects set repo_url = ? where id = ?'),
    fetched: db.prepare('update projects set fetched_at = unixepoch(), fetch_error = ?, default_branch = coalesce(?, default_branch) where id = ?'),
    refs: db.prepare('select ref, sha from project_refs where project_id = ?'),
    putRef: db.prepare('insert into project_refs (project_id, ref, sha) values (?, ?, ?) on conflict(project_id, ref) do update set sha = excluded.sha'),
    dropRef: db.prepare('delete from project_refs where project_id = ? and ref = ?'),
    admins: db.prepare("select username from users where role = 'admin' and disabled_at is null"),
  }
  const path = (slug: string) => `${root}/projects/${slug}`
  const changed = () => hub.publish('projects', { type: 'changed' })
  const dto = (p: Row) => ({
    slug: p.slug, name: p.name, repoUrl: p.repo_url, defaultBranch: p.default_branch, path: path(p.slug), createdAt: p.created_at,
    fetchedAt: p.fetched_at, fetchError: p.fetch_error, archived: p.archived === 1, openTasks: p.open_tasks, sessions: p.sessions,
    live: { working: p.working, waiting: p.waiting, people: JSON.parse(p.active_people || '[]') as string[] }, lastSessionAt: p.last_session_at,
    creator: { username: p.creator_username, name: p.creator_name }, sessionSharing: p.session_sharing, instructions: p.instructions,
  })
  // Who is asking, for the session count (0: nobody's own, shared sessions only).
  const me = (userId = 0) => ({ me: userId })
  /** Background .zip imports by upload id (startFromZip); finished ones are kept an hour for the page to read. */
  type ZipImport = { userId: number; slug: string; state: 'importing' | 'done' | 'failed'; project?: ReturnType<typeof dto>; error?: string; at: number }
  const imports = new Map<string, ZipImport>()
  /** A new project's name and short name from the .zip dialog, refused if the short name is taken or being imported. */
  const zipTarget = (input: { name: string; slug?: string }) => {
    const name = input.name.trim()
    if (!name) throw new AppError(400, 'bad_name', 'Give the project a name.')
    const slug = input.slug?.trim() || slugify(name)
    if (!SLUG_RE.test(slug)) throw new AppError(400, 'bad_slug', 'The short name uses lowercase letters, digits and dashes (up to 40).')
    if (q.bySlug.get(me(), slug)) throw new AppError(409, 'taken', `A project called ${slug} already exists.`)
    return { name, slug }
  }
  const byId = (id: number, userId?: number) => q.byId.get(me(userId), id) as Row | undefined
  function find(slug: string, userId?: number) {
    const p = q.bySlug.get(me(userId), slug) as Row | undefined
    if (!p) throw new AppError(404, 'not_found', `There is no project ${slug}.`)
    return p
  }

  /** Git as the creator; if their agent can't, as an admin (e.g. the creator left). */
  async function asMember<T>(p: Row, msg: object, timeoutMs?: number): Promise<T> {
    try {
      return await agents.request<T>(p.creator_username, msg, timeoutMs)
    } catch (err) {
      const admin = (q.admins.all() as { username: string }[]).find((a) => a.username !== p.creator_username)
      if (!admin || !(err instanceof AppError && err.code === 'agent_unavailable')) throw err
      return agents.request<T>(admin.username, msg, timeoutMs)
    }
  }

  const baseRef = (p: Row, refs: Record<string, string>) =>
    refs[`refs/remotes/origin/${p.default_branch}`] ? `refs/remotes/origin/${p.default_branch}` : `refs/heads/${p.default_branch}`

  // Reads commits that are new since the last scan, per branch. The first scan only records where branches are.
  const scanning = new Set<number>()
  async function scan(p: Row) {
    if (scanning.has(p.id)) return
    scanning.add(p.id)
    try {
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(p.slug) })
      const known = new Map((q.refs.all(p.id) as { ref: string; sha: string }[]).map((r) => [r.ref, r.sha]))
      const baseline = known.size === 0
      const base = baseRef(p, refs)
      for (const [ref, sha] of Object.entries(refs)) {
        const old = known.get(ref)
        if (old === sha) continue
        if (!baseline) {
          const onDefault = ref === `refs/heads/${p.default_branch}` || ref === `refs/remotes/origin/${p.default_branch}`
          // A branch seen for the first time: only its commits that aren't on the default branch.
          const range = old ? `${old}..${sha}` : onDefault ? sha : `${refs[base] ?? base}..${sha}`
          const { commits } = await asMember<{ commits: { sha: string; email: string; subject: string; body: string }[] }>(
            p, { op: 'git.log', path: path(p.slug), range, max: 200 }).catch(() => ({ commits: [] }))
          tasks.fromCommits({ id: p.id, slug: p.slug }, commits, { onDefault, branch: ref.replace(/^refs\/(heads|remotes)\//, '') })
        }
        q.putRef.run(p.id, ref, sha)
      }
      for (const ref of known.keys()) if (!(ref in refs)) q.dropRef.run(p.id, ref)
    } finally {
      scanning.delete(p.id)
    }
  }

  async function fetchOne(p: Row) {
    try {
      const r = await asMember<{ fetched: boolean; defaultBranch?: string | null }>(p, { op: 'git.fetch', path: path(p.slug) }, 6 * 60_000)
      q.fetched.run(null, r.defaultBranch ?? null, p.id)
    } catch (err) {
      q.fetched.run((err as Error).message.slice(0, 500), null, p.id)
    }
    await scan(byId(p.id)!).catch((err) => console.error(`scan ${p.slug}:`, (err as Error).message))
    if (onFetched) await Promise.resolve(onFetched({ id: p.id, slug: p.slug, default_branch: p.default_branch, creator_username: p.creator_username }))
      .catch((err) => console.error(`onFetched ${p.slug}:`, (err as Error).message))
    changed()
  }

  let fetching = false
  async function fetchAll() {
    if (fetching) return
    fetching = true
    try {
      for (const p of q.all.all(me(), 0) as Row[]) if (p.repo_url) await fetchOne(p)
    } finally {
      fetching = false
    }
  }
  setInterval(() => void fetchAll(), FETCH_EVERY_MS).unref()

  return {
    path,
    list: (archived = false, userId?: number) => (q.all.all(me(userId), archived ? 1 : 0) as Row[]).map(dto),
    get: (slug: string, userId?: number) => dto(find(slug, userId)),
    idOf: (slug: string) => find(slug).id,
    bySlug: (slug: string) => find(slug),
    /** The project a folder belongs to (a checkout or one of its worktrees), if any. */
    forPath(cwd: string) {
      const m = cwd.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:projects|worktrees)/([a-z0-9][a-z0-9-]{0,39})(?:/|$)`))
      return m ? ((q.bySlug.get(me(), m[1]!) as Row | undefined) ?? null) : null
    },

    async create(user: User, input: { name: string; slug?: string; repoUrl?: string; instructions?: string }) {
      const repoUrl = input.repoUrl?.trim() || null
      const name = input.name.trim() || (repoUrl ? repoUrl.split('/').pop()!.replace(/\.git$/, '') : '')
      if (!name) throw new AppError(400, 'bad_name', 'Give the project a name.')
      const slug = input.slug?.trim() || slugify(name)
      if (!SLUG_RE.test(slug)) throw new AppError(400, 'bad_slug', 'The short name uses lowercase letters, digits and dashes (up to 40).')
      if (q.bySlug.get(me(), slug)) throw new AppError(409, 'taken', `A project called ${slug} already exists.`)
      const r = await agents.request<{ defaultBranch: string }>(user.username,
        repoUrl ? { op: 'git.clone', path: path(slug), url: repoUrl } : { op: 'git.init', path: path(slug) }, 16 * 60_000)
      await gitSafeDir(path(slug))
      const { id } = q.insert.get(slug, name, repoUrl, r.defaultBranch || 'main', user.id, input.instructions?.trim() ?? '') as { id: number }
      await scan(byId(id)!).catch(() => {})
      q.fetched.run(null, null, id)
      activity.record({ projectId: id, userId: user.id, kind: 'project.created', summary: `added project ${name}`, url: `/projects/${slug}` })
      changed()
      return dto(byId(id, user.id)!)
    },

    // Uploading a .zip from the member's PC: the browser streams the zip to this member's agent in 8 MB pieces (temp
    // file keyed to the upload id), then createFromZip unzips it + inits a repo + inserts the row — all in one step, so
    // a failed or garbage zip never leaves a dangling project. See apps/agent/src/project.ts for the safe extraction.
    uploadZip(user: User, uploadId: string, offset: number, data: Buffer, total?: number) {
      return agents.request<{ size: number }>(user.username, { op: 'project.zipChunk', id: uploadId, offset, total, data: data.toString('base64') }, 120_000)
    },
    abortZip(user: User, uploadId: string) {
      return agents.request(user.username, { op: 'project.zipAbort', id: uploadId }, 10_000).catch(() => ({ ok: true }))
    },

    async createFromZip(user: User, input: { name: string; slug?: string; uploadId: string; instructions?: string }) {
      const { name, slug } = zipTarget(input)
      // Extract first (as the uploader): only insert the row once the folder is a real repo. A 20 GB archive takes a while.
      const r = await agents.request<{ defaultBranch: string }>(user.username, { op: 'project.fromZip', id: input.uploadId, dest: path(slug) }, 3 * 3_600_000)
      await gitSafeDir(path(slug))
      const { id } = q.insert.get(slug, name, null, r.defaultBranch || 'main', user.id, input.instructions?.trim() ?? '') as { id: number }
      await scan(byId(id)!).catch(() => {})
      q.fetched.run(null, null, id)
      activity.record({ projectId: id, userId: user.id, kind: 'project.created', summary: `added project ${name}`, url: `/projects/${slug}` })
      changed()
      return dto(byId(id, user.id)!)
    },

    /**
     * Starts creating a project from an uploaded .zip in the background. Unpacking and committing a big archive takes
     * minutes, longer than a request may last behind Cloudflare (100 s), so the page asks `importStatus` how it's going.
     */
    startFromZip(user: User, input: { name: string; slug?: string; uploadId: string; instructions?: string }) {
      for (const [k, v] of imports) if (v.state !== 'importing' && Date.now() - v.at > 3_600_000) imports.delete(k)
      // Asked again (the page lost the answer): say how it's going. After a server restart this map is empty, and starting
      // again is safe: the agent joins the import still running, or reports the finished one (apps/agent/src/project.ts).
      const known = imports.get(input.uploadId)
      if (known && known.userId === user.id) return { uploadId: input.uploadId, slug: known.slug, state: known.state }
      if (known) throw new AppError(409, 'started', 'This upload is already being imported.')
      const { slug } = zipTarget(input)
      if ([...imports.values()].some((i) => i.slug === slug && i.state === 'importing')) throw new AppError(409, 'taken', `A project called ${slug} is being imported right now.`)
      imports.set(input.uploadId, { userId: user.id, slug, state: 'importing', at: Date.now() })
      const done = (v: Partial<ZipImport>) => imports.set(input.uploadId, { ...imports.get(input.uploadId)!, ...v, at: Date.now() })
      void this.createFromZip(user, input).then(
        (project) => done({ state: 'done', project }),
        (err: Error) => done({ state: 'failed', error: err.message || 'The import failed.' }),
      )
      return { uploadId: input.uploadId, slug, state: 'importing' as ZipImport['state'] }
    },

    /** How a background .zip import is going, for the member who started it. */
    importStatus(user: User, uploadId: string) {
      const i = imports.get(uploadId)
      if (!i || i.userId !== user.id) throw new AppError(404, 'not_found', 'No import with that id.')
      return { state: i.state, slug: i.slug, project: i.project ?? null, error: i.error ?? null }
    },

    /** Any member renames it or sets how new sessions start out; archiving is for whoever added it, or an admin. */
    update(user: User, slug: string, patch: { name?: string; archived?: boolean; sessionSharing?: SessionSharing; instructions?: string }) {
      const p = find(slug)
      if (patch.archived !== undefined && user.role !== 'admin' && user.id !== p.created_by) {
        throw new AppError(403, 'forbidden', 'Only the person who added it or an admin can archive a project.')
      }
      q.patch.run(patch.name?.trim() || p.name, patch.archived === undefined ? p.archived : patch.archived ? 1 : 0, patch.sessionSharing ?? p.session_sharing,
        patch.instructions === undefined ? p.instructions : patch.instructions.trim(), p.id)
      changed()
      return dto(find(slug, user.id))
    },

    /**
     * Points an existing project at a git remote (e.g. a project started from a .zip or a local `git init`), so Builds,
     * fetches and remote commits work on it. Wires the `origin` remote on the shared checkout as the member asking (their
     * own credentials), then fetches — any access error is recorded like a normal fetch and the link stays, so the
     * project header can tell them to set up `gh` auth rather than losing the connection.
     */
    async connectRepo(user: User, slug: string, repoUrl: string) {
      const p = find(slug)
      const url = repoUrl.trim()
      if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw new AppError(400, 'bad_url', 'Use an https:// or git@ repository address.')
      await agents.request(user.username, { op: 'git.remote.set', path: path(slug), url }, 60_000)
      q.setRepo.run(url, p.id)
      await fetchOne(find(slug)) // fetch + scan + changed(); records fetch_error if the member's git access isn't set up yet
      activity.record({ projectId: p.id, userId: user.id, kind: 'project.connected', summary: `connected ${p.name} to ${url.replace(/^https:\/\//, '').replace(/\.git$/, '')}`, url: `/projects/${slug}` })
      return dto(find(slug, user.id))
    },

    async fetch(slug: string, userId?: number) {
      await fetchOne(find(slug))
      return dto(find(slug, userId))
    },

    /** Rescan for new local commits (e.g. after a Claude session in the project went quiet). */
    rescan: (projectId: number) => {
      const p = byId(projectId)
      if (p) void scan(p).catch((err) => console.error(`scan ${p.slug}:`, (err as Error).message))
    },

    async commits(slug: string, max = 30) {
      const p = find(slug)
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(slug) })
      const ref = baseRef(p, refs)
      if (!refs[ref]) return []
      return (await asMember<{ commits: { sha: string; author: string; email: string; at: number; subject: string }[] }>(
        p, { op: 'git.log', path: path(slug), range: ref.replace(/^refs\/(heads|remotes)\//, ''), max })).commits
        .map(({ sha, author, at, subject }) => ({ sha, author, at, subject }))
    },

    /** A fresh checkout on its own branch for one Claude session, made as the session's owner. */
    async worktree(user: User, slug: string) {
      const p = find(slug)
      const id = randomBytes(4).toString('hex')
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(slug) })
      const base = baseRef(p, refs).replace(/^refs\/(heads|remotes)\//, '')
      const wt = `${root}/worktrees/${slug}/${id}`
      await agents.request(user.username, { op: 'git.worktree.add', path: path(slug), worktree: wt, branch: `dd/${id}`, base })
      await gitSafeDir(wt)
      return { path: wt, branch: `dd/${id}` }
    },

    async removeWorktree(username: string, slug: string, wt: string) {
      return (await agents.request<{ removed: boolean }>(username, { op: 'git.worktree.remove', path: path(slug), worktree: wt })).removed
    },

    start: () => setTimeout(() => void fetchAll(), 20_000).unref(),
  }
}

export type ProjectsService = ReturnType<typeof projectsService>
