import { Hono, type Context } from 'hono'
import type { Config } from './core/config.ts'
import type { Db } from './core/db.ts'
import { createHub } from './core/hub.ts'
import { AppError, clientIp, sameOrigin } from './core/http.ts'
import { agentsService } from './modules/agents/service.ts'
import { authMiddleware, authRoutes } from './modules/auth/routes.ts'
import { authService } from './modules/auth/service.ts'
import { claudeRoutes } from './modules/claude/routes.ts'
import { claudeService } from './modules/claude/service.ts'
import { activityService } from './modules/activity/service.ts'
import { registerMcp } from './modules/mcp/rpc.ts'
import { filesRoutes, publicShareRoutes } from './modules/files/routes.ts'
import { sharesService } from './modules/files/shares.ts'
import { buildsRoutes } from './modules/builds/routes.ts'
import { vaultRoutes } from './modules/vault/routes.ts'
import { browserRoutes, watchRoutes } from './modules/browser/routes.ts'
import { browserService } from './modules/browser/service.ts'
import { statusRoutes } from './modules/status/routes.ts'
import { servicePages } from './modules/previews/service.ts'
import { statusService } from './modules/status/service.ts'
import { deployService } from './modules/status/deploy.ts'
import { vaultService } from './modules/vault/service.ts'
import { pinsRoutes } from './modules/pins/routes.ts'
import { pinsService, type Resolved } from './modules/pins/service.ts'
import { spacePagesRoutes } from './modules/storage/pages.ts'
import { releasesRoutes } from './modules/releases/routes.ts'
import { releasesService } from './modules/releases/service.ts'
import { storageRoutes, storageTokenRoutes } from './modules/storage/routes.ts'
import { storageService } from './modules/storage/service.ts'
import { tailnetRoutes } from './modules/tailnet/routes.ts'
import { tailnetService, type TailnetService } from './modules/tailnet/service.ts'
import { buildsService } from './modules/builds/service.ts'
import { notesRoutes } from './modules/notes/routes.ts'
import { notesService } from './modules/notes/service.ts'
import { projectsRoutes } from './modules/projects/routes.ts'
import { projectsService } from './modules/projects/service.ts'
import { searchRoutes } from './modules/search/routes.ts'
import { searchService } from './modules/search/service.ts'
import { tasksRoutes, type GiveToClaude } from './modules/tasks/routes.ts'
import { tasksService } from './modules/tasks/service.ts'
import { servicesRoutes } from './modules/services/routes.ts'
import { servicesService } from './modules/services/service.ts'
import { avatarsService } from './modules/members/avatars.ts'
import { membersRoutes } from './modules/members/routes.ts'
import { apnsService } from './modules/notifications/apns.ts'
import { ntfyService } from './modules/notifications/ntfy.ts'
import { notificationsRoutes } from './modules/notifications/routes.ts'
import { notificationsService } from './modules/notifications/service.ts'
import { provisioningService } from './modules/provisioning/service.ts'
import { terminalsRoutes } from './modules/terminals/routes.ts'
import { terminalsService } from './modules/terminals/service.ts'
import { teamPlugin } from './modules/team/index.ts' // Team (optional)
import { reviewsRoutes } from './modules/reviews/routes.ts'
import { reviewsService } from './modules/reviews/service.ts'

export function createApp({ db, config }: { db: Db; config: Config }) {
  const auth = authService({ db, masterKey: config.masterKey, spaceName: config.spaceName })
  const hub = createHub()
  const agents = agentsService({ runDir: config.runDir })
  const provisioning = provisioningService({ db, runDir: config.runDir, onReady: (username) => agents.watch(username) })
  const terms = terminalsService({ agents })
  // The iPhone app's notifications while it's closed, with the space's APNs key.
  const apns = apnsService({ db, masterKey: config.masterKey, origin: config.origin })
  // Phones whose DevDash app can't get Apple push (a sideloaded iPhone app): through the ntfy app instead.
  const ntfy = ntfyService({ db, masterKey: config.masterKey, origin: config.origin })
  const notifications = notificationsService({ db, hub, dataDir: config.dataDir, origin: config.origin, apns, ntfy })
  hub.authorize('notifications', () => true)
  const shares = sharesService({
    db, dataDir: config.dataDir, masterKey: config.masterKey, origin: config.origin,
    exists: (username, path) => agents.request(username, { op: 'fs.exists', path }, 5_000)
      .then((r) => (r as { exists?: unknown }).exists === false ? false : (r as { exists?: unknown }).exists === true ? true : null, () => null),
  })
  const activity = activityService({ db, hub })
  const search = searchService({ db })
  // Team and reviews (both built further down) are read late, like tailnet: tasks show "From thread #N" and each repo
  // fetch lets "Ready to review" notice branches merged outside DevDash.
  let team: ReturnType<typeof teamPlugin> | undefined
  let reviews: ReturnType<typeof reviewsService> | undefined
  const tasks = tasksService({ db, hub, activity, search, threadOf: (id) => team?.service?.taskThread(id) ?? null, onClosed: (id) => team?.service?.taskClosed(id) })
  const notes = notesService({ db, hub, activity, search })
  const projects = projectsService({ db, hub, agents, activity, tasks, root: config.projectsRoot, gitSafeDir: (p) => provisioning.gitSafeDir(p), onFetched: (p) => reviews?.checkMerges(p) })
  for (const topic of ['projects', 'tasks', 'notes', 'activity']) hub.authorize(topic, () => true)
  // Per-user tailnets: claude asks whether the owner has a connected node before letting a session route through it.
  // The tailnet service is built further down (it needs Team's isRole), so this reads it late, like Team's own wiring.
  let tailnet: TailnetService | undefined
  // Members' own Google Drive: rclone in their account trades a handle for tokens on loopback.
  const storage = storageService({
    db, agents, masterKey: config.masterKey, origin: config.origin, tokenUrl: `http://127.0.0.1:${config.port}/internal/storage/token`,
  })
  const claude = claudeService({
    db, agents, hub, notify: notifications.notify, projects, tailnetConnected: (userId) => !!tailnet?.isConnected(userId),
    storageFor: (userId) => storage.forLaunch(userId),
  })

  // "Give to Claude": a Chat session in the task's project (its own worktree by default), linked to the task.
  const giveToClaude: GiveToClaude = async (user, slug, number, o) => {
    const t = tasks.get(slug, number)
    const d = claude.defaults(user) as { profile: string; model: string | null; effort: string | null; permission_mode: string } | undefined
    const prompt = [
      `Work on task ${t.key}: ${t.title}`,
      t.body.trim(),
      o.note.trim(),
      `When it's done, commit with "fixes #${t.number}" in the message: DevDash moves the task to Review on a branch and to Done on the default branch. Comment a short summary on the task with the DevDash tools.`,
    ].filter(Boolean).join('\n\n')
    const s = await claude.create(user, {
      prompt, images: [], cwd: '', profile: o.profile ?? d?.profile ?? 'default', model: d?.model ?? null, effort: d?.effort ?? null,
      permissionMode: d?.permission_mode ?? 'bypassPermissions', mode: 'chat', project: slug, worktree: o.worktree,
    })
    tasks.linkSession(slug, number, s.id, s.title)
    if (t.status !== 'in_progress') tasks.update({ user }, slug, number, { status: 'in_progress', assignee: t.assignee?.id ?? user.id })
    return { sessionId: s.id }
  }
  const previews = servicePages({ db, auth, origin: config.origin, port: config.servicesPort })
  const services = servicesService({ db, agents, hub, notify: notifications.notify, previewUrl: previews.urlOf, basePath: previews.basePathOf })
  hub.authorize('services', () => true)
  const mw = authMiddleware(auth)
  const ip = (c: Context) => clientIp(c, config.trustCfIp)

  const builds = buildsService({ db, agents, projects, shares })
  const vault = vaultService({ db })
  const browser = browserService({ db, runDir: config.runDir, dataDir: config.dataDir, masterKey: config.masterKey, origin: config.origin })
  // "Ready to review": a role's approved code proposal, finished with commits, ships in one tap. Team detects it (it has
  // the proposal context) and calls reviews.record; the claude module never imports Team.
  reviews = reviewsService({ db, hub, agents, projects, notify: notifications.notify, onMerged: (d, commit) => team?.service?.noteDeliveryMerged(d.session_id, commit) })
  team = teamPlugin({ db, hub, agents, claude, projects, activity, tasks, notify: notifications.notify, masterKey: config.masterKey, mw, onProposalIdle: (s) => void reviews!.record(s) }) // Team
  // Per-user tailnets: keep net_* tools out of team role sessions (Team may be off, so roleOf is optional).
  tailnet = tailnetService({ db, agents, masterKey: config.masterKey, runDir: config.runDir, isRole: (u, s) => !!team?.service?.roleOf(u, s) })
  const status = statusService({ db, agents, services, browser, runDir: config.runDir, dataDir: config.dataDir, version: config.version })
  const deploys = deployService({ db, agents, projects, notify: notifications.notify, runDir: config.runDir, repo: config.repo, token: config.githubToken, live: status.release })
  const avatars = avatarsService({ db, hub })
  // Each member's sidebar pins: every module shows its own items, by its own visibility rules (pins imports none of them).
  const pins = pinsService({ db, hub })
  const each = (refs: string[], fn: (ref: string) => Resolved) =>
    new Map(refs.flatMap((r) => { try { return [[r, fn(r)] as const] } catch { return [] } })) // gone, or not theirs to see
  pins.register('project', (u, refs) => each(refs, (slug) => {
    const p = projects.get(slug, u.id)
    return { title: p.name, url: `/projects/${slug}`, detail: p.archived ? 'archived' : null }
  }))
  pins.register('session', (u, refs) => claude.pinned(u, refs))
  pins.register('task', (_u, refs) => each(refs, (ref) => {
    const [slug, n] = ref.split('/')
    const t = tasks.get(slug!, Number(n))
    return { title: `#${t.number} ${t.title}`, url: `/tasks/${slug}/${n}`, state: t.status, detail: slug ?? null }
  }))
  pins.register('note', (u, refs) => each(refs, (id) => {
    const n = notes.get(u, Number(id))
    return { title: n.title, url: `/notes/${id}` }
  }))
  pins.register('service', (u, refs) => each(refs, (name) => {
    const s = services.get(u, name)
    return { title: s.name, url: `/services/${name}/view`, state: s.state } // a pinned service opens inside DevDash
  }))
  const app = new Hono()
    // Requests from the services site (port 8443) are proxied to services, never mixed with DevDash's routes.
    .use('*', previews.middleware)
    // Public: lets the native shell check that a domain is a DevDash space before loading it.
    .get('/.well-known/devdash.json', (c) => {
      c.header('access-control-allow-origin', '*')
      c.header('cache-control', 'no-store')
      return c.json({ app: 'devdash', name: config.spaceName, version: config.version, api: 1 })
    })
    // Public share links (the only public pages): a small download page, no app, no listing.
    .route('/s', publicShareRoutes(shares, ip))
    .route('/watch', watchRoutes(browser, ip))
    .route('/api/app', releasesRoutes(releasesService({ repo: config.repo, token: config.githubToken, origin: config.origin }), { name: config.spaceName, origin: config.origin }, ip))
    // What this space is and its privacy policy, public for Google's app review (Caddy proxies just these two paths).
    .route('/', spacePagesRoutes(() => ({ name: config.spaceName, origin: config.origin, contact: storage.contactEmail() })))
    // rclone's token endpoint for members' Drives: loopback only, Caddy never proxies /internal.
    .route('/internal/storage', storageTokenRoutes(storage))
    .use('/api/*', sameOrigin(config.origin))
    .route('/api/auth', authRoutes(auth, mw, ip, (u) => void provisioning.ensure(u)))
    .route('/api/members', membersRoutes(auth, mw, ip, config.origin, (id) => {
      vault.memberRemoved(id)
      avatars.remove(id)
      void storage.memberRemoved(id).catch((err) => console.error('storage: forgetting a removed member:', err))
    }, avatars))
    .route('/api/terminals', terminalsRoutes(terms, auth, mw, provisioning, ip))
    .route('/api/claude', claudeRoutes(claude, mw))
    .route('/api/notifications', notificationsRoutes(notifications, apns, ntfy, mw))
    .route('/api/services', servicesRoutes(services, mw))
    .route('/api/projects', projectsRoutes(projects, activity, mw))
    .route('/api/tasks', tasksRoutes(tasks, giveToClaude, mw))
    .route('/api/notes', notesRoutes(notes, mw))
    .route('/api/files', filesRoutes(agents, shares, mw))
    .route('/api/builds', buildsRoutes(builds, mw))
    .route('/api/vault', vaultRoutes(vault, mw))
    .route('/api/tailnet', tailnetRoutes(tailnet, mw))
    .route('/api/storage', storageRoutes(storage, mw))
    .route('/api/pins', pinsRoutes(pins, mw))
    .route('/api/browser', browserRoutes(browser, mw))
    .route('/api/status', statusRoutes(status, deploys, mw))
    .route('/api/team', team.routes) // Team
    .route('/api', reviewsRoutes(reviews, mw)) // "Ready to review" deliveries
    .route('/api', searchRoutes({ db, search, notes, projects, claude, services, activity }, mw))

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500)
  })

  // Items a team role creates through its session are attributed to the role, not the account the team runs as.
  registerMcp({ db, agents, projects, tasks, notes, services, authorRole: (u, s) => team?.service?.roleOf(u, s)?.r.name ?? null })
  reviews.registerMcp()
  deploys.registerMcp()
  deploys.resume()
  projects.start()
  return { app, auth, provisioning, terms, agents, claude, services, projects, tasks, notes, hub, previews }
}

export type AppType = ReturnType<typeof createApp>['app']
