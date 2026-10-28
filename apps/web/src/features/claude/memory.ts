import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'
import { relativeTime } from './data'

export type MemoryHealth = Awaited<ReturnType<typeof fetchMemory>>['health']
const fetchMemory = () => unwrap(api.api.claude.memory.$get())
export const memoryQuery = queryOptions({ queryKey: ['claude', 'memory'], queryFn: fetchMemory, refetchInterval: 30_000 })

/** claude-mem for one member in a light and a sentence, for Claude setup and the Server page. */
export function describeMemory(h: MemoryHealth): { light: 'live' | 'idle' | 'error'; text: string; hint?: string } {
  switch (h.state) {
    case 'off': return { light: 'idle', text: 'Off' }
    case 'stopped': return { light: 'idle', text: 'On, starts with the next Claude session' }
    case 'error': return {
      light: 'error',
      text: `Can't save memories: ${h.error}`,
      hint: /auth/i.test(h.error ?? '') ? 'Sign the profile in again above, then restart claude-mem.' : 'Restart claude-mem. If it keeps failing, check the worker log in ~/.claude-mem/logs.',
    }
    case 'ok': {
      const n = h.memories ?? 0
      return { light: 'live', text: `Running, ${n} ${n === 1 ? 'memory' : 'memories'}${h.lastSaved ? `, last saved ${relativeTime(h.lastSaved)}` : ''}` }
    }
  }
}
