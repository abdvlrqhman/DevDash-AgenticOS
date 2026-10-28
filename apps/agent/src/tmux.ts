import { execFile } from 'node:child_process'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pty from 'node-pty'

export const TMUX_CONF = fileURLToPath(new URL('../../../deploy/tmux.conf', import.meta.url))
// A dedicated tmux server, so SSH users can join the same terminals: tmux -L devdash attach -t t-main
const TMUX = ['-L', 'devdash', '-f', TMUX_CONF]
const run = promisify(execFile)
export const tmux = (...args: string[]) => run('tmux', [...TMUX, ...args])
// Services get their own tmux server (apps/agent/src/services.ts), apart from terminals.
const SVC = ['-L', 'devdash-svc', '-f', TMUX_CONF]
export const svcTmux = (...args: string[]) => run('tmux', [...SVC, ...args])
// The member's userspace tailscaled runs in its own tmux server too (apps/agent/src/tailscale.ts), so it outlives agent restarts.
const TS = ['-L', 'devdash-ts', '-f', TMUX_CONF]
export const tsTmux = (...args: string[]) => run('tmux', [...TS, ...args])
export const clamp = (n: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(n)) || min))

export async function hasSession(name: string) {
  try {
    await tmux('has-session', '-t', `=${name}`)
    return true
  } catch {
    return false
  }
}

export async function listSessions() {
  try {
    const { stdout } = await tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}')
    return stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [name, created, attached, activity] = l.split('\t')
      return { name: name!, created: Number(created), attached: Number(attached), activity: Number(activity) }
    })
  } catch {
    return [] // no tmux server yet
  }
}

export function send(conn: Socket, msg: object) {
  return conn.write(JSON.stringify(msg) + '\n')
}

// As much as the browser terminal keeps (TerminalView scrollback), so a session scrolls back to its start.
const HISTORY_LINES = 10_000

/**
 * Streams one tmux session to one connection as JSON lines: {d} data both ways, {r:[cols,rows]} resize from the client.
 * Read-only attaches (shared views) ignore input. Closing the connection only detaches; the session keeps running.
 */
export async function attachPty(conn: Socket, lines: AsyncIterator<string>, name: string, o: { cols: number; rows: number; readonly?: boolean; onInput?: () => void; services?: boolean }) {
  const base = o.services ? SVC : TMUX
  const cols = clamp(o.cols, 10, 500)
  const rows = clamp(o.rows, 4, 200)
  // Older output first, so the browser's own scrollback has it; attaching then draws the visible screen below.
  try {
    const { stdout } = await run('tmux', [...base, 'capture-pane', '-p', '-e', '-J', '-S', `-${HISTORY_LINES}`, '-E', '-1', '-t', `=${name}`])
    if (stdout.trim()) send(conn, { d: stdout.replace(/\n/g, '\r\n') })
  } catch {
    // no history yet
  }
  const term = pty.spawn('tmux', [...base, 'attach-session', ...(o.readonly ? ['-r'] : []), '-t', `=${name}`], {
    name: 'xterm-256color', cols, rows, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  term.onData((d) => {
    if (!send(conn, { d })) {
      term.pause()
      conn.once('drain', () => term.resume())
    }
  })
  term.onExit(() => conn.end())
  conn.on('close', () => term.kill())

  for (let r = await lines.next(); !r.done; r = await lines.next()) {
    let m: { d?: unknown; r?: unknown }
    try {
      m = JSON.parse(r.value)
    } catch {
      continue
    }
    if (typeof m.d === 'string' && !o.readonly) {
      o.onInput?.()
      term.write(m.d)
    } else if (Array.isArray(m.r)) {
      term.resize(clamp(m.r[0], 10, 500), clamp(m.r[1], 4, 200))
    }
  }
}
