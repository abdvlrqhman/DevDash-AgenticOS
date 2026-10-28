import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'
import type { AgentsService } from '../agents/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'

type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>
type Row = {
  id: number; sha: string; status: 'requested' | 'declined' | 'running' | 'done' | 'failed'; note: string | null
  requested_by: number | null; requester: string | null; session_id: string | null; session_title: string | null
  decided_by: number | null; decider: string | null; log: string | null; created_at: number; started_at: number | null; finished_at: number | null
}
export type Commit = { sha: string; message: string; author: string; at: number; url: string }
type Me = { id: number; name: string; role: string }

const SELECT = `select d.*, r.name as requester, a.name as decider, s.title as session_title from deploys d
  left join users r on r.id = d.requested_by left join users a on a.id = d.decided_by left join claude_sessions s on s.id = d.session_id`
const COMMITS = 40
const short = (sha: string) => sha.slice(0, 7)
const firstLine = (s: string) => s.split('\n')[0]!.slice(0, 120)

/** "owner/name" of a GitHub repository URL (https or ssh), lowercased; null for anything else. */
export function githubRepo(url: string | null | undefined) {
  const m = url?.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return m ? m[1]!.toLowerCase() : null
}

/**
 * Updating DevDash itself. A member (or their Claude session in DevDash's own project) asks; an admin approves on the
 * Server page; the root helper starts deploy/self-deploy.sh as its own systemd unit, which fetches the commit from
 * GitHub, builds it, switches over, restarts this server and rolls back if it isn't healthy. Claude never gets root:
 * it can only ask, and only for commits already on the repository's main branch.
 */
/** When a GitHub token stops working, from the header GitHub adds to its answers ("2027-01-01 00:00:00 UTC"), in seconds. */
export function tokenExpiry(headers: Headers) {
  const v = headers.get('github-authentication-token-expiration')
  const t = v ? Date.parse(v.replace(' UTC', 'Z').replace(' ', 'T')) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

export function deployService({ db, agents, projects, notify, runDir, repo, token = null, live, rootHelper, github = fetch, pollMs = 5000 }: {
  db: Db; agents: AgentsService; projects: ProjectsService; notify: Notify; runDir: string
  /** GitHub "owner/name" this server runs. */
  repo: string
  /** The live release: the first 12 characters of its commit id (deploy.sh and self-deploy.sh name releases so). */
  live: () => { id: string; since: number } | null
  /** Tests: stand-ins for the root helper and GitHub. */
  rootHelper?: (cmd: string, args: unknown) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>
  github?: typeof fetch
  /** The read-only GitHub token a private repository needs (config.githubToken). */
  token?: string | null
  pollMs?: number
}) {
  const q = {
    byId: db.prepare(`${SELECT} where d.id = ?`),
    open: db.prepare(`${SELECT} where d.status in ('requested', 'running') order by d.id`),
    last: db.prepare(`${SELECT} where d.status in ('done', 'failed') order by d.id desc limit 1`),
    pendingFor: db.prepare(`select id from deploys where status = 'requested' and sha = ?`),
    insert: db.prepare(`insert into deploys (sha, status, note, requested_by, session_id, decided_by, started_at)
      values (?, ?, ?, ?, ?, ?, case when ?2 = 'running' then unixepoch() end) returning id`),
    start: db.prepare(`update deploys set status = 'running', decided_by = ?, started_at = unixepoch() where id = ? and status = 'requested'`),
    decline: db.prepare(`update deploys set status = 'declined', decided_by = ?, finished_at = unixepoch() where id = ? and status = 'requested'`),
    finish: db.prepare(`update deploys set status = ?, log = ?, finished_at = unixepoch() where id = ? and status = 'running'`),
    covered: db.prepare(`update deploys set status = 'done', finished_at = unixepoch(), note = coalesce(note || char(10), '') || 'Included in a later deploy.' where id = ? and status = 'requested'`),
    // A newer request already includes this commit, so this older pending one is redundant: drop it from the waiting
    // list (declined, not done — it never ran, so it must not read as the last deploy). ?1 = the newer request's id.
    supersede: db.prepare(`update deploys set status = 'declined', finished_at = unixepoch(),
      note = trim(coalesce(note || char(10), '') || 'Superseded by a newer request (#' || cast(?1 as integer) || ').') where status = 'requested' and sha = ?2`),
    user: db.prepare("select id, name, role from users where username = ? and disabled_at is null"),
    admins: db.prepare("select id from users where role = 'admin' and disabled_at is null"),
    adminNames: db.prepare("select name from users where role = 'admin' and disabled_at is null order by name"),
    sessionRepo: db.prepare('select p.repo_url from claude_sessions s join projects p on p.id = s.project_id where s.id = ? and s.owner_id = ?'),
  }

  // What's on GitHub: the newest commits on main, asked at most every 2 minutes (GitHub allows 60 calls an hour without a token).
  // `tokenExpires`: when the token stops working, as GitHub says on every answer, so the Server page can warn in time.
  let seen: { at: number; commits: Commit[] | null; error: string | null; tokenExpires: number | null } = { at: 0, commits: null, error: null, tokenExpires: null }
  async function mainCommits(force = false) {
    if (!force && Date.now() - seen.at < 120_000) return seen
    try {
      const r = await github(`https://api.github.com/repos/${repo}/commits?sha=main&per_page=${COMMITS}`, {
        headers: {
          accept: 'application/vnd.github+json', 'user-agent': 'DevDash', 'x-github-api-version': '2022-11-28',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) {
        throw new Error(r.status === 401 ? "GitHub turned down DevDash's token (DEVDASH_GITHUB_TOKEN): it expired or was revoked. Make a new one."
          : r.status === 404 && !token ? `GitHub doesn't show ${repo}. A private repository needs a read-only GitHub token in the server's settings (DEVDASH_GITHUB_TOKEN).`
          : r.status === 404 ? `DevDash's GitHub token (DEVDASH_GITHUB_TOKEN) can't read ${repo}: give it Contents read access to that repository.`
          : r.status === 403 || r.status === 429 ? 'GitHub is limiting requests; try again in a few minutes.' : `GitHub answered ${r.status}.`)
      }
      const list = await r.json() as { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null } }[]
      seen = {
        at: Date.now(), error: null, tokenExpires: tokenExpiry(r.headers),
        commits: list.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author?.name ?? '', at: Math.floor(Date.parse(c.commit.author?.date ?? '') / 1000) || 0, url: c.html_url })),
      }
    } catch (err) {
      seen = { at: Date.now(), commits: seen.commits, error: `Could not check GitHub: ${(err as Error).message}`, tokenExpires: seen.tokenExpires }
    }
    return seen
  }

  /** The commits on main newer than the live release (newest first), or null when the live commit isn't among them. */
  function ahead(commits: Commit[]) {
    const id = live()?.id
    const i = id ? commits.findIndex((c) => c.sha.startsWith(id)) : -1
    return i < 0 ? null : commits.slice(0, i)
  }

  // A request whose commit went live since (an admin deployed it or something newer) is settled. One made after that
  // for an older commit is a rollback and stays.
  function settle(commits: Commit[]) {
    const l = live()
    const i = l ? commits.findIndex((c) => c.sha.startsWith(l.id)) : -1
    if (i < 0) return
    for (const r of q.open.all() as Row[]) {
      const j = commits.findIndex((c) => c.sha === r.sha)
      if (r.status === 'requested' && j >= i && r.created_at <= l!.since) q.covered.run(r.id)
    }
  }

  const dto = (r: Row) => ({
    id: r.id, sha: r.sha, status: r.status, note: r.note,
    by: r.requester, session: r.session_id ? { id: r.session_id, title: r.session_title ?? 'Claude session' } : null,
    decidedBy: r.decider, log: r.log, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  })

  const canDeploy = !!runDir || !!rootHelper
  const helper = <T>(cmd: string, args: unknown, timeoutMs = 15_000) =>
    (rootHelper ? rootHelper(cmd, args) as Promise<{ ok: boolean; error?: string } & T> : requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd, args }, timeoutMs))
      .then((r) => { if (!r.ok) throw new AppError(409, 'deploy_failed', r.error ?? `${cmd} failed`); return r })

  const tell = (ids: (number | null)[], n: { title: string; body?: string }, kind: NotificationKind = 'finished') => {
    for (const id of new Set(ids.filter((x): x is number => x !== null))) void notify(id, kind, { ...n, url: '/server', tag: 'devdash-deploy' }).catch(() => {})
  }

  // Follows a running deploy to its end, also across the restart it causes: the new server picks it up again (resume).
  const watching = new Set<number>()
  async function watch(id: number) {
    if (watching.has(id)) return
    watching.add(id)
    try {
      const row = () => q.byId.get(id) as Row | undefined
      const began = Date.now()
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs))
        const r = row()
        if (r?.status !== 'running') return
        const s = await helper<{ state: string; result: string; ran: boolean; log?: string }>('deploy-status', { sha: r.sha }).catch(() => null)
        // The unit itself stops after 30 minutes; past that, stop waiting for an answer that won't come.
        if (Date.now() - began > 45 * 60_000) {
          q.finish.run('failed', s?.log?.trim() || 'Lost track of the deploy: no answer from the server\'s helper.', id)
          return
        }
        if (!s) continue
        if (s.state === 'activating' || s.state === 'active' || s.state === 'reloading') continue
        // systemd forgets a finished one-shot unit (it then reads as never run), so the live release is the proof it worked.
        const isLive = live()?.id === r.sha.slice(0, 12)
        // The unit hasn't started yet (or systemd forgot it): give it a minute before calling it lost.
        if (!s.ran && !isLive && s.state !== 'failed' && Date.now() - began < 12 * pollMs) continue
        const ok = isLive && (s.ran ? s.result === 'success' : s.state !== 'failed')
        q.finish.run(ok ? 'done' : 'failed', ok ? null : (s.log?.trim() || (s.ran ? 'The deploy failed.' : 'The deploy never started.')), id)
        tell([r.requested_by, r.decided_by], ok
          ? { title: `DevDash updated to ${short(r.sha)}`, body: 'The new version is live.' }
          : { title: `DevDash update to ${short(r.sha)} failed`, body: 'The previous version is still running. The Server page has the output.' }, ok ? 'finished' : 'errors')
        if (ok) void mainCommits(true).then((m) => m.commits && settle(m.commits))
        return
      }
    } finally {
      watching.delete(id)
    }
  }

  /** Finds the commit on main a request or a deploy names: a full or abbreviated id, or the newest when none. */
  async function target(commit: string | undefined) {
    const m = await mainCommits(true)
    if (!m.commits) throw new AppError(409, 'github', m.error ?? 'Could not read the repository from GitHub.')
    const want = commit?.trim().toLowerCase()
    if (want && !/^[0-9a-f]{7,40}$/.test(want)) throw new AppError(400, 'bad_commit', 'Give a commit id (at least 7 characters) or nothing for the newest.')
    const c = want ? m.commits.find((x) => x.sha.startsWith(want)) : m.commits[0]
    if (!c) throw new AppError(404, 'not_on_main', `${want} isn't among the newest ${COMMITS} commits on ${repo}'s main branch. Push it to main first.`)
    if (live()?.id && c.sha.startsWith(live()!.id)) throw new AppError(409, 'already_live', `${short(c.sha)} is already live.`)
    // What it would bring: the commits from it down to the live one (none for a rollback to an older commit).
    const newer = ahead(m.commits)
    const i = newer ? newer.findIndex((x) => x.sha === c.sha) : -1
    return { commit: c, pending: i >= 0 ? newer!.slice(i) : null }
  }

  async function request(me: Me, o: { commit?: string; note?: string; sessionId?: string | null }) {
    const { commit, pending } = await target(o.commit)
    const existing = q.pendingFor.get(commit.sha) as { id: number } | undefined
    const note = o.note?.trim().slice(0, 2000) || null
    const id = existing?.id ?? (q.insert.get(commit.sha, 'requested', note, me.id, o.sessionId ?? null, null) as { id: number }).id
    let superseded = 0
    if (!existing) {
      // Retire any older pending request for a commit this one already includes, so only the latest shows.
      for (const c of (pending ?? []).slice(1)) superseded += Number(q.supersede.run(id, c.sha).changes)
      const n = pending?.length
      tell((q.admins.all() as { id: number }[]).map((a) => a.id), {
        title: `${me.name} asks to update DevDash`,
        body: `${n ? `${n} new commit${n === 1 ? '' : 's'}, up to ` : ''}${short(commit.sha)}: ${firstLine(commit.message)}${note ? `\n${note}` : ''}`,
      }, 'needs_you')
    }
    return { id, commit, pending, existing: !!existing, superseded }
  }

  async function start(me: Me, o: { sha?: string; requestId?: number }) {
    if (me.role !== 'admin') throw new AppError(403, 'forbidden', 'Only admins deploy.')
    if (!canDeploy) throw new AppError(409, 'unavailable', 'Deploying needs DevDash\'s server setup; this one runs without it (a development machine).')
    if ((q.open.all() as Row[]).some((r) => r.status === 'running')) throw new AppError(409, 'busy', 'A deploy is already running.')
    const req = o.requestId ? q.byId.get(o.requestId) as Row | undefined : undefined
    if (o.requestId && req?.status !== 'requested') throw new AppError(409, 'gone', 'That request was already handled.')
    const { commit } = await target(req?.sha ?? o.sha)
    let id: number
    if (req && commit.sha === req.sha) { q.start.run(me.id, req.id); id = req.id }
    else id = (q.insert.get(commit.sha, 'running', null, me.id, null, me.id) as { id: number }).id
    try {
      await helper('deploy', { sha: commit.sha })
    } catch (err) {
      q.finish.run('failed', (err as Error).message, id)
      throw err
    }
    void watch(id).catch((err) => console.error('deploy watch:', err))
    return dto(q.byId.get(id) as Row)
  }

  /** Everything the Server page shows about updating DevDash. */
  async function state(admin: boolean, force = false) {
    const m = await mainCommits(force)
    if (m.commits) settle(m.commits)
    const open = (q.open.all() as Row[]).map(dto)
    const last = q.last.get() as Row | undefined
    return {
      repo, live: live(), checkedAt: Math.floor(m.at / 1000) || null, error: m.error, tokenExpires: m.tokenExpires,
      newest: m.commits?.[0] ?? null,
      ahead: m.commits ? ahead(m.commits) : null,
      running: open.find((r) => r.status === 'running') ?? null,
      requests: open.filter((r) => r.status === 'requested'),
      last: last ? dto(last) : null,
      canAct: admin && canDeploy,
    }
  }

  return {
    request, start, state,

    decline(me: Me, id: number) {
      if (me.role !== 'admin') throw new AppError(403, 'forbidden', 'Only admins decide on deploys.')
      const r = q.byId.get(id) as Row | undefined
      if (!q.decline.run(me.id, id).changes || !r) throw new AppError(409, 'gone', 'That request was already handled.')
      tell([r.requested_by].filter((x) => x !== me.id), { title: `${me.name} declined the DevDash update to ${short(r.sha)}` })
    },

    /** After a restart (a deploy restarts this server): keep following deploys that were running. */
    resume() {
      for (const r of q.open.all() as Row[]) if (r.status === 'running') void watch(r.id).catch((err) => console.error('deploy watch:', err))
    },

    /** Claude's tools (packages/claude-plugin/mcp/devdash.mjs), only in sessions of DevDash's own project. */
    registerMcp() {
      const context = (username: string, params: unknown) => {
        const p = (params ?? {}) as { sessionId?: string | null; cwd?: string; args?: Record<string, unknown> }
        const me = q.user.get(username) as Me | undefined
        if (!me) throw new AppError(403, 'forbidden', 'Unknown member.')
        const url = (p.sessionId ? (q.sessionRepo.get(p.sessionId, me.id) as { repo_url: string | null } | undefined)?.repo_url : undefined)
          ?? (typeof p.cwd === 'string' ? projects.forPath(p.cwd)?.repo_url : undefined)
        return { me, here: githubRepo(url) === repo.toLowerCase(), sessionId: p.sessionId ?? null, args: p.args ?? {} }
      }
      const own = (username: string, params: unknown) => {
        const c = context(username, params)
        if (!c.here) throw new AppError(403, 'forbidden', `Only sessions in the project of DevDash's own repository (${repo}) can do this.`)
        return c
      }
      agents.onRpc('mcp.devdash_here', (username, params) => ({ here: context(username, params).here }))
      agents.onRpc('mcp.devdash_deploy_status', async (username, params) => {
        own(username, params)
        const s = await state(false, true)
        return {
          repository: s.repo,
          live: s.live ? { commit: s.live.id, since: new Date(s.live.since * 1000).toISOString() } : 'unknown (not deployed by DevDash\'s scripts)',
          newestOnMain: s.newest && { commit: short(s.newest.sha), message: firstLine(s.newest.message) },
          notDeployedYet: s.ahead ? s.ahead.map((c) => `${short(c.sha)} ${firstLine(c.message)}`) : 'unknown: the live commit is not among the newest commits on main',
          running: s.running && `${short(s.running.sha)}, started by ${s.running.decidedBy ?? 'an admin'}`,
          lastDeploy: s.last && { commit: short(s.last.sha), result: s.last.status, finished: s.last.finishedAt && new Date(s.last.finishedAt * 1000).toISOString(), output: s.last.status === 'failed' ? s.last.log : undefined },
          waitingForApproval: s.requests.map((r) => `#${r.id} ${short(r.sha)} asked by ${r.by ?? 'someone'}`),
          error: s.error ?? undefined,
        }
      })
      agents.onRpc('mcp.devdash_deploy_request', async (username, params) => {
        const c = own(username, params)
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
        const r = await request(c.me, { commit: str(c.args.commit), note: str(c.args.note), sessionId: c.sessionId })
        const admins = (q.adminNames.all() as { name: string }[]).map((a) => a.name).join(', ')
        return [
          r.existing ? `Already waiting for approval (request #${r.id}).` : `Asked the admins (${admins}) to deploy ${short(r.commit.sha)} (request #${r.id}).`,
          r.pending?.length ? `It brings ${r.pending.length} commit${r.pending.length === 1 ? '' : 's'}: ${r.pending.map((x) => short(x.sha)).join(', ')}.` : '',
          r.superseded ? `It replaces ${r.superseded} earlier request${r.superseded === 1 ? '' : 's'} for commits it already includes.` : '',
          'An admin approves it on the Server page; then the server builds, restarts and checks itself (and rolls back if unhealthy). Check with devdash_deploy_status; nothing more to do here.',
        ].filter(Boolean).join(' ')
      })
    },
  }
}
