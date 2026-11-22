// DevDash tools for Claude Code (MCP over stdio: newline-delimited JSON-RPC 2.0). No dependencies, no tokens:
// calls go to this member's own agent socket, which relays them to the DevDash server, so they act as this member
// ("via Claude"). The project comes from the Claude session (DEVDASH_SESSION_ID) or the working folder.
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { teamTools } from './team.mjs' // Team (optional)
import { assistantTools } from './assistant.mjs'
import { autopilotTools } from './autopilot.mjs'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET
const context = { sessionId: process.env.DEVDASH_SESSION_ID ?? null, cwd: process.cwd() }

const status = { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const project = { type: 'string', description: "Project short name (e.g. 'shop'). Omit to use this session's project." }
const number = { type: 'integer', description: 'Task number within the project (shop#12 → 12).' }
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  { name: 'project_info', description: "This session's DevDash project: name, repository, default branch, folder, open task count. Also lists every project.", inputSchema: obj({ project }) },
  { name: 'tasks_list', description: 'Tasks in a project (open ones, plus recently done). Filter by status or "mine" (assigned to the person you work for).', inputSchema: obj({ project, status, mine: { type: 'boolean' } }) },
  { name: 'task_get', description: 'One task with its details, comments and linked commits and sessions.', inputSchema: obj({ project, number }, ['number']) },
  { name: 'task_create', description: 'Create a task in the project.', inputSchema: obj({ project, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, status, priority, due: { type: 'string', description: 'YYYY-MM-DD' } }, ['title']) },
  { name: 'task_update', description: 'Change a task: status, priority, due date, title, body, or assign it to yourself (assign_to_me). Move it to in_progress when you start and review when your work is ready.', inputSchema: obj({ project, number, status, priority, due: { type: ['string', 'null'] }, title: { type: 'string' }, body: { type: 'string' }, assign_to_me: { type: 'boolean' } }, ['number']) },
  { name: 'task_comment', description: 'Comment on a task (markdown), e.g. a summary of what you did.', inputSchema: obj({ project, number, body: { type: 'string' } }, ['number', 'body']) },
  { name: 'notes_list', description: 'Team notes (decisions, setup steps, links), optionally only one project\'s.', inputSchema: obj({ project, all_projects: { type: 'boolean', description: 'Every note, not only this project\'s.' } }) },
  { name: 'note_get', description: 'Read one note.', inputSchema: obj({ id: { type: 'integer' } }, ['id']) },
  { name: 'note_upsert', description: 'Create a note (no id) or update one (with id). Notes are visible to the whole team.', inputSchema: obj({ id: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, project, pinned: { type: 'boolean' } }) },
  {
    name: 'notify',
    description: "Send a push notification (their phone and DevDash) about this session. DevDash doesn't ping anyone when you finish a reply: you decide. It pulls people away from whatever they're doing, so err toward not sending. Send one when there's a real chance they've stepped away and something is worth coming back for (a long task done, a build, deploy or PR ready or broken, a decision only they can make), or when someone asked to be told. Not for quick answers, routine progress, or a question you're asking in the chat right now (DevDash already tells them you're waiting). DevDash adds whose agent and which session it's from.",
    inputSchema: obj({
      message: { type: 'string', description: 'One line, under 200 characters, no markdown, leading with what they would act on: "Checkout PR ready: 2 tests still flaky", not "Task done".' },
      to: {
        description: 'Who gets it. Default: whoever sent the message you are answering (the owner, or the teammate who asked). Otherwise team members by username or name, e.g. ["omar"], or "everyone" for the whole team (rarely: news for all of them).',
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
      },
      link: { type: 'string', description: 'A DevDash page to open instead of this session, like /tasks/shop/12.' },
    }, ['message']),
  },
  { name: 'services_list', description: 'Every long-running service on this server (everyone\'s), with ports and state. Start new ones with `devdash service add` in Bash.', inputSchema: obj({}) },
  { name: 'review_card_update', description: 'After you merge a dd/* branch into the default branch (or abandon it), close its "Ready to review" card so the founder doesn\'t see a card for work that already landed: status "merged" (pass merged_commit when you have it) or "dismissed" (give a short reason). Call this in the same step you merge a dd/* branch.', inputSchema: obj({ branch: { type: 'string', description: 'The dd/* branch of the card.' }, status: { type: 'string', enum: ['merged', 'dismissed'] }, reason: { type: 'string', description: 'For "dismissed": why, in a few words.' }, merged_commit: { type: 'string', description: 'The merge commit sha, if you have it.' } }, ['branch', 'status']) },
]

function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('DevDash is not available in this session (no DEVDASH_AGENT_SOCKET).'))
    const sock = connect(SOCKET)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      sock.destroy()
      try {
        const m = JSON.parse(buf.slice(0, i))
        if (m.error) reject(new Error(m.error))
        else resolve(m.result)
      } catch {
        reject(new Error('DevDash returned an unreadable response.'))
      }
    })
    // The member agent gives the server 60 seconds. Also settle if the agent restarts mid-request.
    sock.setTimeout(65_000, () => {
      reject(new Error('DevDash did not answer in time.'))
      sock.destroy()
    })
    sock.on('close', () => reject(new Error('DevDash disconnected before answering.')))
    sock.on('error', () => reject(new Error('Could not reach DevDash on this server.')))
  })
}

// Updating DevDash itself: only in sessions of DevDash's own project (its GitHub repository), asked once at start.
const DEPLOY_TOOLS = [
  { name: 'devdash_deploy_status', description: "This DevDash server's own version: the live commit, commits on GitHub main not deployed yet, a deploy running or how the last one went (with its output if it failed), and requests waiting for an admin.", inputSchema: obj({}) },
  { name: 'devdash_deploy_request', description: "Ask the admins to deploy DevDash on this server: the newest commit on GitHub main, or `commit`. Push to main first; only commits on main can be deployed. An admin approves with one tap on the Server page, then the server builds, restarts and health-checks itself (rolling back if unhealthy). Ask only when the person wants it live. You can't deploy any other way: there is no sudo or root SSH.", inputSchema: obj({ commit: { type: 'string', description: 'A commit id on main. Omit for the newest.' }, note: { type: 'string', description: 'What it brings, in a line or two, for the admin who approves.' } }) },
]
const deployTools = () => call('mcp.devdash_here', { ...context, args: {} }).then((r) => (r?.here ? DEPLOY_TOOLS : []), () => [])

// Your own tailnet: devices on the Tailscale account you connected on the Network page, and
// their live online status. Scoped to you; listed in your own sessions, not team roles'.
const NET_TOOLS = [
  { name: 'net_devices', description: 'Devices on your own tailnet (the Tailscale account you connected on the Network page) with live online status, OS and tailnet IP. Check this before you try to reach one.', inputSchema: obj({}) },
  { name: 'net_check', description: 'Status of one device on your tailnet by name, host or tailnet IP: online or offline, its IP, and when it was last seen.', inputSchema: obj({ device: { type: 'string', description: 'Device name, hostname or tailnet IP.' } }, ['device']) },
]
const netTools = () => call('mcp.net_here', { ...context, args: {} }).then((r) => (r?.available ? NET_TOOLS : []), () => [])

// Custom subagents created by the member on the Subagents page: usable from both Hamasa and normal sessions
// (never inside a subagent session itself to avoid recursive delegation).
const SUBAGENT_TOOLS = [
  { name: 'subagents_list', description: 'List your enabled custom subagents (name, slug, description, instructions preview) and any currently running subagent tasks.', inputSchema: obj({}) },
  {
    name: 'subagent_run',
    description: 'Run one of your custom subagents on a focused task (e.g. web search, codebase search, deep research, code review). Returns the run result (or runId if wait=false or if it continues running in the background).',
    inputSchema: obj({
      subagent: { type: 'string', description: 'The subagent slug or name from subagents_list.' },
      task: { type: 'string', description: 'Clear, self-contained task prompt for the subagent.' },
      project,
      cwd: { type: 'string', description: 'Optional working folder override.' },
      wait: { type: 'boolean', description: 'Default true (waits up to timeout_sec for the answer). Set false to launch in background and check later with subagent_status.' },
      timeout_sec: { type: 'integer', description: 'Seconds to wait when wait=true (default 45, max 50).' },
    }, ['subagent', 'task']),
  },
  {
    name: 'subagent_status',
    description: 'Check live status, current activity, recent steps, and result of a subagent run (or list recent runs when run_id is omitted).',
    inputSchema: obj({
      run_id: { type: 'integer', description: 'Run id returned by subagent_run. Omit to list recent runs.' },
      wait_sec: { type: 'integer', description: 'Optional seconds (1-50) to wait for a running subagent before returning its status.' },
    }),
  },
  { name: 'subagent_stop', description: 'Stop a currently running custom subagent run.', inputSchema: obj({ run_id: { type: 'integer', description: 'Run id to stop.' } }, ['run_id']) },
]
const subagentTools = () => call('mcp.subagents_here', { ...context, args: {} }).then((r) => (r?.available ? SUBAGENT_TOOLS : []), () => [])

const workflow = process.argv[2] === '--workflow' ? process.argv[3] : undefined
async function listTools() {
  if (workflow === undefined) {
    const [team, deploy, net, assistant, autopilot, subagents] = await Promise.all([teamTools(call, context), deployTools(), netTools(), assistantTools(call, context), autopilotTools(call, context), subagentTools()])
    return [...TOOLS, ...deploy, ...net, ...team, ...assistant, ...autopilot, ...subagents]
  }
  if (workflow === 'autopilot') return autopilotTools(call, context)
  if (workflow !== 'hamasa') throw new Error('Unknown DevDash workflow.')
  const assistant = await assistantTools(call, context)
  if (!assistant.length) throw new Error('Hamasa tools require an active personal agent session.')
  const [team, subagents] = await Promise.all([teamTools(call, context), subagentTools()])
  return [...TOOLS, ...assistant, ...team, ...subagents]
}
let listed
const tools = () => (listed ??= listTools())

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(m) {
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devdash', version: '0.2.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: await tools() }
    case 'tools/call': {
      const name = m.params?.name
      if (!(await tools()).some((t) => t.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 })
      try {
        const result = await call(`mcp.${name}`, { ...context, args: m.params?.arguments ?? {} })
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
  }
}

// A member-owned T3 thread calls the same tool catalog using its shell, with a turn-specific wrapper.
async function workflowCommand(action, name) {
  const available = await tools()
  if (action === 'list') return available.map((t) => t.name).join('\n')
  const tool = available.find((t) => t.name === name)
  if (!tool) throw new Error(`Unknown workflow tool: ${name}`)
  if (action === 'describe') return JSON.stringify(tool, null, 2)
  if (action !== 'call') throw new Error('Use list, describe NAME, or call NAME with JSON arguments on stdin.')
  let raw = ''
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      raw += chunk
      if (raw.length > 1024 * 1024) throw new Error('DevDash tool arguments are too large.')
    }
  }
  const args = JSON.parse(raw.trim() || '{}')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected a JSON object.')
  const result = await handle({ method: 'tools/call', params: { name, arguments: args } })
  const text = result.content.map((item) => item.text).join('\n')
  if (result.isError) throw new Error(text)
  return text
}

if (process.argv[2] === '--workflow') {
  try {
    if (!workflow) throw new Error('Missing DevDash workflow.')
    console.log(await workflowCommand(process.argv[4], process.argv[5]))
  } catch (err) { console.error(err.message); process.exitCode = 1 }
} else {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let pending = 0
  let closed = false
  const maybeExit = () => { if (closed && !pending) process.exit(0) }
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (m.id === undefined || m.id === null) return // a notification (e.g. notifications/initialized): no reply
    pending++
    try {
      send({ jsonrpc: '2.0', id: m.id, result: await handle(m) })
    } catch (err) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: err.message } })
    } finally {
      pending--
      maybeExit()
    }
  })
  // Claude closes stdin to stop the server: answer what's in flight first.
  rl.on('close', () => { closed = true; maybeExit() })
}
