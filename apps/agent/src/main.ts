// DevDash agent: one per member, running as that member's Linux user (deploy/systemd/devdash-agent@.service).
// The server talks to it over a Unix socket that systemd creates (mode 0660, group devdash), so only the server and
// the member's own processes (e.g. the DevDash plugin's hooks) can connect.
// Protocol: the first line is a JSON request. Most ops answer with one JSON line; attach ops then stream JSON lines
// both ways ({d} data, {r} resize); `subscribe` keeps the connection open for events.
import { execFile } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import * as claude from './claude.ts'
import * as services from './services.ts'
import * as tailscale from './tailscale.ts'
import * as storage from './storage.ts'
import { ops as git } from './git.ts'
import { startJanitor } from './janitor.ts'
import * as files from './files.ts'
import * as memory from './memory.ts'
import * as mentions from './mentions.ts'
import { busy as projectBusy, ops as project } from './project.ts'
import * as sqlite from './sqlite.ts'
import * as gh from './gh.ts'
import { attachPty, hasSession, listSessions, send, tmux, TMUX_CONF } from './tmux.ts'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const ADMIN = 'admin'
const ADMIN_IDLE_MS = 15 * 60_000
const term = (name: string) => `t-${name}`
const GH_LOGIN = 'github-login'

// Every process the agent starts (terminals, Claude) can reach this agent, e.g. for plugin hooks.
process.env.DEVDASH_AGENT_SOCKET ??= `/run/devdash/agent-${process.env.USER}.sock`
process.env.DISABLE_AUTOUPDATER = '1'

async function ensureTerminal(name: string, cols: number, rows: number) {
  if (await hasSession(term(name))) return
  const base = ['new-session', '-d', '-s', term(name), '-x', String(cols), '-y', String(rows)]
  if (name === ADMIN) return void (await tmux(...base, 'sudo -i')) // asks for the admin's Linux password
  // Connect GitHub: gh signs in with a one-time code in the browser, then git uses it for https remotes.
  if (name === GH_LOGIN) {
    const script = 'echo "Connect GitHub: open the link below, type the code, and approve. This tab closes by itself." && echo'
      + ' && GH_PROMPT_DISABLED=1 gh auth login --hostname github.com --git-protocol https --web --insecure-storage && gh auth setup-git --hostname github.com'
      + ' && echo && echo "GitHub is connected. This tab closes in a few seconds." && sleep 4'
      + ' || { echo; echo "GitHub sign-in did not finish."; read -r -p "Press Enter to close this tab. " _; }'
    return void (await tmux(...base, '-e', 'BROWSER=echo', 'bash', '-lc', script))
  }
  if (name.startsWith('login-')) {
    const { env, args } = claude.loginCommand(name.slice(6))
    return void (await tmux(...base, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...args))
  }
  await tmux(...base)
}

type Req = Record<string, unknown> & { op?: string }
const run = promisify(execFile)
const str = (v: unknown, what: string) => {
  if (typeof v !== 'string') throw new Error(`missing ${what}`)
  return v
}

// One-line request/response ops.
const ops: Record<string, (r: Req) => Promise<unknown> | unknown> = {
  'terminals.list': async () => ({
    terminals: (await listSessions()).filter((s) => s.name.startsWith('t-')).map((s) => ({ ...s, name: s.name.slice(2) })),
  }),
  'terminals.kill': async (r) => {
    const name = str(r.name, 'name')
    if (!NAME_RE.test(name)) throw new Error('invalid terminal name')
    await tmux('kill-session', '-t', `=${term(name)}`).catch(() => {})
    return { ok: true }
  },
  hook: (r) => (claude.hook(r.payload as Parameters<typeof claude.hook>[0]), { ok: true }),
  upgrade: () => {
    upgrading = true
    return { ok: true }
  },
  // The member's cloud storage remote (apps/agent/src/storage.ts): set up when they connect, removed when they disconnect.
  'storage.configure': async (r) => ({ changed: await storage.configure(r.storage as storage.Storage) }),
  'storage.remove': async (r) => ({ changed: await storage.remove(str(r.remote, 'remote'), str(r.tokenUrl, 'tokenUrl')) }),
  'claude.send': async (r) => (await claude.send(r.launch as claude.Launch, r.content as unknown[], str(r.uuid, 'uuid')), { ok: true }),
  'claude.answer': (r) => (claude.answer(str(r.id, 'id'), str(r.requestId, 'requestId'), r.result as never), { ok: true }),
  'claude.interrupt': async (r) => (await claude.interrupt(str(r.id, 'id')), { ok: true }),
  'claude.set': async (r) => (await claude.setOption(str(r.id, 'id'), r.key as 'model', (r.value as string | boolean | null) ?? null), { ok: true }),
  'claude.remote': (r) => claude.remote(r.launch as claude.Launch, r.enabled === true),
  'claude.complete': async (r) => ({
    text: await claude.complete(str(r.profile, 'profile'), str(r.prompt, 'prompt'), {
      model: typeof r.model === 'string' ? r.model : undefined, system: typeof r.system === 'string' ? r.system : undefined,
    }),
  }),
  'claude.files': async (r) => ({ paths: await mentions.search(str(r.cwd, 'cwd'), typeof r.q === 'string' ? r.q : '') }),
  'sqlite.query': (r) => sqlite.query(r.path, r.sql),
  'claude.stop': async (r) => (await claude.stop(str(r.id, 'id')), { ok: true }),
  'claude.cli.open': async (r) => (await claude.openCli(r.launch as claude.Launch, Number(r.cols) || 100, Number(r.rows) || 30), { ok: true }),
  'claude.cli.close': async (r) => (await claude.closeCli(str(r.id, 'id')), { ok: true }),
  'claude.pending': (r) => ({ pending: claude.pendingFor(str(r.id, 'id')) }),
  'claude.history': (r) => claude.history(r.launch as claude.Launch, { before: typeof r.before === 'string' ? r.before : undefined, turns: Number(r.turns) || 0 }),
  'claude.subagent': (r) => claude.subagent(r.launch as claude.Launch, str(r.toolUseId, 'toolUseId')),
  'claude.task.stop': async (r) => (await claude.stopTask(str(r.id, 'id'), str(r.taskId, 'taskId')), { ok: true }),
  'claude.commands': (r) => claude.commandsAndModels(str(r.profile, 'profile')),
  'claude.title': (r) => claude.title(r.launch as claude.Launch),
  'claude.rename': async (r) => (await claude.rename(r.launch as claude.Launch, str(r.title, 'title')), { ok: true }),
  'claude.profiles': async () => ({ profiles: (await claude.profiles()).map((p) => ({ ...p, memory: memory.enabled(p.name) })) }),
  'claude.memory': async (r) => (await memory.set(str(r.profile, 'profile'), r.enabled === true), { ok: true }),
  'claude.memory.health': async () => ({ health: await memory.health(claude.profileNames()) }),
  'claude.memory.restart': async () => (await memory.restart(claude.profileNames()), { ok: true }),
  'claude.usage': async (r) => ({ usage: await claude.usage(str(r.profile, 'profile')) }),
  'claude.profile.create': (r) => (claude.createProfile(str(r.name, 'name')), { ok: true }),
  'fs.dir': async (r) => ({ path: await services.dir(r.path) }),
  'fs.roots': () => files.ops.roots(),
  'fs.first': (r) => files.ops.first(r),
  'fs.find': (r) => files.ops.find(r),
  'fs.list': (r) => files.ops.list(r),
  'fs.mkdir': (r) => files.ops.mkdir(r),
  'fs.rename': (r) => files.ops.rename(r),
  'fs.remove': (r) => files.ops.remove(r),
  'fs.exists': (r) => files.ops.exists(r),
  'fs.mkdirp': (r) => files.ops.mkdirp(r),
  'fs.write': (r) => files.ops.write(r),
  'gh.api': (r) => gh.ops.api(r),
  'gh.status': async () => {
    try {
      const { stdout, stderr } = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 15_000 })
      const out = stdout + stderr
      return { connected: true, login: out.match(/account (\S+)/)?.[1] ?? out.match(/ as (\S+)/)?.[1] ?? null }
    } catch (err) {
      return { connected: false, login: null, installed: (err as { code?: string }).code !== 'ENOENT' }
    }
  },
  'git.clone': (r) => git.clone(r),
  'git.init': (r) => git.init(r),
  'git.fetch': (r) => git.fetch(r),
  'git.remote.set': (r) => git.remoteSet(r),
  'git.isAncestor': (r) => git.isAncestor(r),
  'git.refs': (r) => git.refs(r),
  'git.log': (r) => git.log(r),
  'git.worktree.add': (r) => git.worktreeAdd(r),
  'git.worktree.remove': (r) => git.worktreeRemove(r),
  'git.branchStat': (r) => git.branchStat(r),
  'git.branchDiff': (r) => git.branchDiff(r),
  'git.mergeBranch': (r) => git.mergeBranch(r),
  'gh.pr': (r) => gh.ops.pr(r),
  'project.zipChunk': (r) => project.zipChunk(r),
  'project.zipAbort': (r) => project.zipAbort(r),
  'project.fromZip': (r) => project.fromZip(r),
  'service.start': async (r) => (await services.start(r), { ok: true }),
  'service.stop': async (r) => (await services.stop(r), { ok: true }),
  'service.status': async () => ({ services: await services.status() }),
  'service.logs': async (r) => ({ text: await services.logs(r) }),
  // Per-user tailnet: one userspace Tailscale node, isolated to this member. The auth key
  // arrives already decrypted from the server; tailscale.ts never logs it.
  'tailscale.up': (r) => tailscale.up(r),
  'tailscale.status': () => tailscale.status(),
  'tailscale.down': () => tailscale.down(),
  // From the member's own processes (the `devdash` command): relayed to the server, which knows who this agent is.
  rpc: async (r) => ({ result: await rpc(str(r.method, 'method'), r.params) }),
}

// Requests to the server over the event connection: {ev:'rpc', rpc, method, params} up, {rpc, result|error} back.
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextCall = 0
function rpc(method: string, params: unknown) {
  if (!events || events.destroyed) return Promise.reject(new Error('DevDash is not connected to your account right now. Try again in a minute.'))
  const id = ++nextCall
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject })
    send(events!, { ev: 'rpc', rpc: id, method, params })
    setTimeout(() => calls.delete(id) && reject(new Error('DevDash did not answer in time.')), 60_000).unref()
  })
}
async function readReplies(lines: AsyncIterator<string>) {
  for (let r = await lines.next(); !r.done; r = await lines.next()) {
    try {
      const m = JSON.parse(r.value) as { rpc?: number; result?: unknown; error?: string }
      const call = m.rpc !== undefined ? calls.get(m.rpc) : undefined
      if (!call) continue
      calls.delete(m.rpc!)
      if (m.error) call.reject(new Error(m.error))
      else call.resolve(m.result)
    } catch {
      // not a reply
    }
  }
}

let events: Socket | null = null
claude.setEmitter((ev) => {
  if (events && !events.destroyed) send(events, ev)
})

async function handle(conn: Socket) {
  conn.setEncoding('utf8')
  const lines = createInterface({ input: conn, crlfDelay: Infinity })[Symbol.asyncIterator]()
  try {
    const first = await lines.next()
    if (first.done) return
    const req = JSON.parse(first.value) as Req

    if (req.op === 'subscribe') {
      // The server's event connection. The newest one wins; it starts with a snapshot to reconcile statuses.
      events?.destroy()
      events = conn
      send(conn, { ev: 'snapshot', sessions: await claude.snapshot() })
      conn.on('close', () => { if (events === conn) events = null })
      return void (await readReplies(lines))
    }
    if (req.op === 'terminal.attach') {
      const name = str(req.name, 'name')
      if (!NAME_RE.test(name)) throw new Error('invalid terminal name')
      await ensureTerminal(name, Number(req.cols) || 80, Number(req.rows) || 24)
      let lastInput = Date.now()
      const idle = name === ADMIN
        ? setInterval(() => {
            if (Date.now() - lastInput > ADMIN_IDLE_MS) void tmux('kill-session', '-t', `=${term(ADMIN)}`).catch(() => {})
          }, 30_000)
        : undefined
      conn.on('close', () => clearInterval(idle))
      return await attachPty(conn, lines, term(name), { cols: Number(req.cols), rows: Number(req.rows), onInput: () => (lastInput = Date.now()) })
    }
    if (req.op === 'fs.read') return await files.read(conn, req.path)
    if (req.op === 'gh.download') return await gh.download(conn, req.path, req.name)
    if (req.op === 'service.attach') {
      const name = services.sessionName(req.name)
      if (!(await services.status())[str(req.name, 'name')]) throw new Error('This service is not running.')
      return await attachPty(conn, lines, name, { cols: Number(req.cols), rows: Number(req.rows), readonly: true, services: true })
    }
    if (req.op === 'claude.attach') {
      const id = str(req.id, 'id')
      if (!(await hasSession(claude.cliSession(id)))) throw new Error('This session is not open in the CLI.')
      return await attachPty(conn, lines, claude.cliSession(id), { cols: Number(req.cols), rows: Number(req.rows), readonly: req.readonly === true })
    }

    const fn = req.op && Object.hasOwn(ops, req.op) ? ops[req.op] : undefined
    if (!fn) throw new Error('unknown op')
    send(conn, { ok: true, ...((await fn(req)) as object) })
    conn.end()
  } catch (err) {
    send(conn, { error: (err as Error).message })
    conn.end()
  }
}

// Deploys ask agents to restart; wait until no Chat turn is running and no .zip is uploading or unpacking, so nobody's
// Claude is cut off mid-answer and nobody's 20 GB upload dies halfway.
let upgrading = false
setInterval(() => {
  if (upgrading && !claude.busy() && !projectBusy()) process.exit(0) // systemd starts the new code
}, 5_000).unref()

// Apply the current tmux.conf and environment to an already running tmux server (no-op when none is running).
void tmux('source-file', TMUX_CONF).catch(() => {})
for (const k of ['DEVDASH_AGENT_SOCKET', 'DISABLE_AUTOUPDATER']) void tmux('set-environment', '-g', k, process.env[k]!).catch(() => {})

const server = createServer((conn) => void handle(conn))
if (process.env.LISTEN_FDS === '1') server.listen({ fd: 3 }) // socket activation
else server.listen(process.env.DEVDASH_AGENT_SOCKET)
server.on('listening', () => console.log(`devdash agent for ${process.env.USER} ready`))

// Periodically prune stale, provably-safe Claude Code subagent worktrees so they stop filling the shared disk.
startJanitor()
