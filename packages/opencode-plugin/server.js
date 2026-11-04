// DevDash's OpenCode plugin, loaded only in CLI mode (apps/agent/src/opencode.ts): OpenCode's terminal app tells this
// member's DevDash agent what its session is doing (working, waiting for an answer, done) and what it's called, the
// way Claude Code's hooks do (packages/claude-plugin/hooks/report.mjs). Never blocks or fails OpenCode: no agent, no
// problem. In Chat mode DevDash drives OpenCode itself and needs none of this.
import { connect } from 'node:net'

const socket = process.env.DEVDASH_AGENT_SOCKET
const session = process.env.DEVDASH_SESSION_ID
/** OpenCode's own id for the session; its subagents' sessions (other ids) don't count. */
const native = process.env.DEVDASH_OPENCODE_SESSION

// OpenCode's events, as the Claude Code hook names the agent turns into a status.
const STATUS = {
  'session.execution.started': 'UserPromptSubmit',
  'permission.replied': 'PreToolUse',
  'form.replied': 'PreToolUse',
  'form.cancelled': 'PreToolUse',
  'permission.asked': 'Notification',
  'form.created': 'Notification',
  'session.execution.succeeded': 'Stop',
  'session.execution.failed': 'Stop',
  'session.execution.interrupted': 'Stop',
}

function report(payload) {
  const s = connect(socket)
  s.on('connect', () => s.end(`${JSON.stringify({ op: 'hook', payload: { session_id: session, agent: 'opencode', ...payload } })}\n`))
  s.on('error', () => {})
}

export default {
  id: 'devdash',
  setup(ctx) {
    if (!socket || !session || !native) return
    const controller = new AbortController()
    void (async () => {
      for await (const e of ctx.event.subscribe({ types: [...Object.keys(STATUS), 'session.renamed'], signal: controller.signal })) {
        if (e.data?.sessionID !== native) continue
        if (e.type === 'session.renamed' && typeof e.data.title === 'string') report({ title: e.data.title })
        else if (STATUS[e.type]) report({ hook_event_name: STATUS[e.type] })
      }
    })().catch(() => {})
    return () => controller.abort()
  },
}
