// Forwards a Claude Code hook event to this member's DevDash agent, which turns it into session status.
// Never blocks or fails Claude: no agent, no problem; always exits 0 with no output.
import { connect } from 'node:net'

const path = process.env.DEVDASH_AGENT_SOCKET
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (!path) return
  let p
  try {
    const all = JSON.parse(input)
    p = { session_id: all.session_id, hook_event_name: all.hook_event_name }
  } catch {
    return
  }
  const sock = connect(path)
  sock.on('connect', () => sock.end(JSON.stringify({ op: 'hook', payload: p }) + '\n'))
  sock.on('error', () => {})
  setTimeout(() => process.exit(0), 1500).unref()
})
