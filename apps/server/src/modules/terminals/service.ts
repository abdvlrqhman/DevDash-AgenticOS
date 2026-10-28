import { sha256 } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'

export const TERMINAL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
export const ADMIN_TERMINAL = 'admin'
const UNLOCK_MS = 5 * 60_000

export type TerminalInfo = { name: string; created: number; attached: number; activity: number }

/** Member terminals live in tmux under the member's own agent. */
export function terminalsService({ agents }: { agents: AgentsService }) {
  // ponytail: in-memory unlock window; a server restart just asks for the code again.
  const unlocked = new Map<string, number>()
  return {
    async list(username: string) {
      return (await agents.request<{ terminals: TerminalInfo[] }>(username, { op: 'terminals.list' })).terminals
    },
    github: (username: string) => agents.request<{ connected: boolean; login: string | null; installed?: boolean }>(username, { op: 'gh.status' }, 20_000),
    async kill(username: string, name: string) {
      if (!TERMINAL_NAME_RE.test(name)) throw new AppError(400, 'bad_name', 'Invalid terminal name.')
      await agents.request(username, { op: 'terminals.kill', name })
    },
    unlockAdmin: (sessionToken: string) => unlocked.set(sha256(sessionToken), Date.now() + UNLOCK_MS),
    isAdminUnlocked: (sessionToken: string) => (unlocked.get(sha256(sessionToken)) ?? 0) > Date.now(),
  }
}

export type TerminalsService = ReturnType<typeof terminalsService>
