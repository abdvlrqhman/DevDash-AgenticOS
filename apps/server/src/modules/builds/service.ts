import type { Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { agentFile } from '../files/stream.ts'
import type { Expiry, SharesService } from '../files/shares.ts'
import type { ProjectsService } from '../projects/service.ts'

/** owner/repo of a github.com remote (https or ssh), or null for anything else. */
export function githubRepo(url: string | null) {
  const m = url?.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

type Target = { id: number; project_id: number; name: string; workflow: string; ref: string; inputs: string; created_at: number }
type Run = { id: number; name: string; display_title: string; status: string; conclusion: string | null; head_branch: string; event: string; run_number: number
  created_at: string; updated_at: string; html_url: string; actor?: { login: string }; path: string; run_started_at?: string }

/**
 * Builds on GitHub Actions, always as the member who asks (their own `gh` login), so access and audit trails stay
 * theirs. Nothing is polled in the background: pages ask while someone is looking.
 */
export function buildsService({ db, agents, projects, shares }: { db: Db; agents: AgentsService; projects: ProjectsService; shares: SharesService }) {
  const q = {
    targets: db.prepare('select * from build_targets where project_id = ? order by name'),
    target: db.prepare('select * from build_targets where id = ? and project_id = ?'),
    insert: db.prepare('insert into build_targets (project_id, name, workflow, ref, inputs, created_by) values (?, ?, ?, ?, ?, ?) returning id'),
    remove: db.prepare('delete from build_targets where id = ? and project_id = ?'),
  }
  function repoOf(slug: string) {
    const p = projects.bySlug(slug)
    const repo = githubRepo(p.repo_url)
    if (!repo) throw new AppError(400, 'not_github', 'Builds need a project cloned from github.com.')
    return { p, repo }
  }
  async function gh<T>(user: User, path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
    const { text } = await agents.request<{ text: string }>(user.username, { op: 'gh.api', path, ...(init ?? {}) }, 45_000)
    try { return (text.trim() ? JSON.parse(text) : {}) as T } catch { return text as T }
  }
  const run = (r: Run) => ({
    id: r.id, title: r.display_title, workflow: r.name, workflowPath: r.path, number: r.run_number, status: r.status, conclusion: r.conclusion,
    branch: r.head_branch, event: r.event, actor: r.actor?.login ?? null, createdAt: r.created_at, updatedAt: r.updated_at, url: r.html_url,
  })
  const target = (t: Target) => ({ id: t.id, name: t.name, workflow: t.workflow, ref: t.ref, inputs: JSON.parse(t.inputs) as Record<string, string> })

  return {
    async overview(user: User, slug: string) {
      const { p, repo } = repoOf(slug)
      const [workflows, runs] = await Promise.all([
        gh<{ workflows: { id: number; name: string; path: string; state: string }[] }>(user, `repos/${repo}/actions/workflows?per_page=100`),
        gh<{ workflow_runs: Run[] }>(user, `repos/${repo}/actions/runs?per_page=20`),
      ])
      return {
        repo, defaultBranch: p.default_branch,
        targets: (q.targets.all(p.id) as Target[]).map(target),
        workflows: workflows.workflows.filter((w) => w.state === 'active').map((w) => ({ name: w.name, file: w.path.split('/').pop()! })),
        runs: runs.workflow_runs.map(run),
      }
    },

    addTarget(user: User, slug: string, t: { name: string; workflow: string; ref: string; inputs: Record<string, string> }) {
      const { p } = repoOf(slug)
      if (!/^[\w.-]+\.ya?ml$/.test(t.workflow)) throw new AppError(400, 'bad_workflow', 'Pick a workflow file like release.yml.')
      const { id } = q.insert.get(p.id, t.name.trim(), t.workflow, t.ref.trim() || p.default_branch, JSON.stringify(t.inputs), user.id) as { id: number }
      return target(q.target.get(id, p.id) as Target)
    },
    removeTarget(slug: string, id: number) {
      q.remove.run(id, projects.bySlug(slug).id)
    },

    /** Starts a target's workflow and returns the new run (GitHub returns it directly when it can; otherwise we find it). */
    async start(user: User, slug: string, id: number) {
      const { p, repo } = repoOf(slug)
      const t = q.target.get(id, p.id) as Target | undefined
      if (!t) throw new AppError(404, 'not_found', 'No such build target.')
      const since = Date.now() - 5_000
      const r = await gh<{ workflow_run_id?: number }>(user, `repos/${repo}/actions/workflows/${t.workflow}/dispatches`, {
        method: 'POST', body: { ref: t.ref, inputs: JSON.parse(t.inputs), return_run_details: true },
      })
      if (r?.workflow_run_id) return { runId: r.workflow_run_id }
      for (let i = 0; i < 8; i++) {
        await new Promise((ok) => setTimeout(ok, 1500))
        const { workflow_runs } = await gh<{ workflow_runs: Run[] }>(user, `repos/${repo}/actions/workflows/${t.workflow}/runs?per_page=5&event=workflow_dispatch`)
        const found = workflow_runs.find((x) => new Date(x.created_at).getTime() >= since)
        if (found) return { runId: found.id }
      }
      return { runId: null }
    },

    async run(user: User, slug: string, runId: number) {
      const { repo } = repoOf(slug)
      const [r, jobs, artifacts] = await Promise.all([
        gh<Run>(user, `repos/${repo}/actions/runs/${runId}`),
        gh<{ jobs: { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null
          steps?: { name: string; status: string; conclusion: string | null; number: number; started_at: string | null; completed_at: string | null }[] }[] }>(user, `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`),
        gh<{ artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean }[] }>(user, `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`),
      ])
      return {
        run: run(r),
        jobs: jobs.jobs.map((j) => ({
          id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, startedAt: j.started_at, completedAt: j.completed_at,
          steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion, startedAt: s.started_at, completedAt: s.completed_at })),
        })),
        artifacts: artifacts.artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired })),
      }
    },

    /** A finished job's full log (GitHub only serves logs once a job is done). */
    async log(user: User, slug: string, jobId: number) {
      const { repo } = repoOf(slug)
      const text = await gh<string>(user, `repos/${repo}/actions/jobs/${jobId}/logs`)
      return typeof text === 'string' ? text : JSON.stringify(text)
    },

    async action(user: User, slug: string, runId: number, what: 'cancel' | 'rerun') {
      const { repo } = repoOf(slug)
      await gh(user, `repos/${repo}/actions/runs/${runId}/${what === 'cancel' ? 'cancel' : 'rerun'}`, { method: 'POST', body: {} })
    },

    async artifactStream(user: User, slug: string, artifactId: number, name: string) {
      const { repo } = repoOf(slug)
      return agentFile(agents.open(user.username, { op: 'gh.download', path: `repos/${repo}/actions/artifacts/${artifactId}/zip`, name: `${name}.zip` }))
    },

    async shareArtifact(user: User, slug: string, artifactId: number, o: { name: string; runNumber: number; expires: Expiry; password?: string }) {
      const f = await this.artifactStream(user, slug, artifactId, o.name)
      return shares.create(user, { name: `${o.name}.zip`, source: `${slug} build #${o.runNumber}`, body: f.body, expires: o.expires, password: o.password })
    },
  }
}

export type BuildsService = ReturnType<typeof buildsService>
