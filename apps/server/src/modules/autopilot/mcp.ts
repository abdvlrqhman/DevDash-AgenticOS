import type { AgentsService } from '../agents/service.ts'
import type { AutopilotService } from './service.ts'

type Ctx = { sessionId?: string | null; args?: Record<string, unknown> }

/** The autopilot tools every member's own session has (packages/claude-plugin/mcp/autopilot.mjs). */
export function registerAutopilotMcp({ agents, autopilot }: { agents: AgentsService; autopilot: AutopilotService }) {
  const ctx = (params: unknown) => (params ?? {}) as Ctx
  agents.onRpc('mcp.autopilot_here', (username, params) => autopilot.toolsHere(username, ctx(params).sessionId ?? null))
  agents.onRpc('mcp.autopilot_log', (username, params) => autopilot.toolLog(username, ctx(params).sessionId ?? null, ctx(params).args ?? {}))
  // Not a tool: scripts/autopilot-import.mjs, run once by the member, sends their prototype's files.
  agents.onRpc('autopilot.import', (username, params) => autopilot.importPrototype(username, (params ?? {}) as Record<string, unknown>))
  agents.onRpc('mcp.autopilot_rules', (username, params) => autopilot.toolRules(username, ctx(params).sessionId ?? null))
}
