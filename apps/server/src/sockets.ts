import type { WebSocket } from 'ws'
import type { Hub } from './core/hub.ts'
import { AppError } from './core/http.ts'
import { bridgeToAgent, type WsContext, type WsRouter } from './core/ws.ts'
import type { AgentsService } from './modules/agents/service.ts'
import type { ClaudeService } from './modules/claude/service.ts'
import type { ServicesService } from './modules/services/service.ts'
import { ADMIN_TERMINAL, type TerminalsService } from './modules/terminals/service.ts'

const size = (ctx: WsContext) => {
  const n = (k: string, min: number, max: number, d: number) => {
    const v = Number(ctx.url.searchParams.get(k))
    return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : d
  }
  return { cols: n('cols', 10, 500, 80), rows: n('rows', 4, 200, 24) }
}

function open(sock: WebSocket, agents: AgentsService, username: string, msg: object) {
  try {
    bridgeToAgent(sock, agents.open(username, msg))
  } catch {
    sock.close(1011, 'agent unavailable')
  }
}

export function registerSockets(ws: WsRouter, d: { hub: Hub; agents: AgentsService; terms: TerminalsService; claude: ClaudeService; services: ServicesService }) {
  // Live updates for one browser tab.
  ws.route(/^\/api\/live$/, (sock, ctx) => d.hub.attach(sock, ctx.user))

  // A member's own terminal tabs (tmux under their agent). "admin" needs a fresh 2FA code first.
  ws.route(
    /^\/api\/terminals\/([a-z0-9][a-z0-9-]{0,30})\/ws$/,
    (sock, ctx) => open(sock, d.agents, ctx.user.username, { op: 'terminal.attach', name: ctx.match[1], ...size(ctx) }),
    (ctx) => {
      if (ctx.match[1] === ADMIN_TERMINAL && (ctx.user.role !== 'admin' || !d.terms.isAdminUnlocked(ctx.sessionToken))) {
        throw new AppError(403, 'locked', 'Unlock the admin shell first.')
      }
    },
  )

  // A service's output, read-only, for every member.
  ws.route(
    /^\/api\/services\/([a-z][a-z0-9-]{0,30})\/logs$/,
    (sock, ctx) => open(sock, d.agents, d.services.logsAccess(ctx.user, ctx.match[1]!), { op: 'service.attach', name: ctx.match[1], ...size(ctx) }),
    (ctx) => void d.services.logsAccess(ctx.user, ctx.match[1]!),
  )

  // CLI mode of a Claude session. Shared viewers who may not send get a read-only view.
  ws.route(
    /^\/api\/claude\/sessions\/([0-9a-f-]{36})\/cli$/,
    (sock, ctx) => {
      const a = d.claude.cliAccess(ctx.user, ctx.match[1]!)
      open(sock, d.agents, a.owner, { op: 'claude.attach', id: ctx.match[1], readonly: a.readonly, ...size(ctx) })
    },
    (ctx) => void d.claude.cliAccess(ctx.user, ctx.match[1]!),
  )
}
