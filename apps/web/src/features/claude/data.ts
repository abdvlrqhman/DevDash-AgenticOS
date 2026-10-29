import { queryOptions, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { api, unwrap } from '../../lib/api'
import { useTopic } from '../../lib/live'
import { URGENCY } from './places'

export { byFolder, folderName, sessionPlace, shortPath } from './places'

export type Session = InferResponseType<typeof api.api.claude.sessions.$get>['sessions'][number]
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** `ownerOnly`: a teammate (`askedBy`) asked for something that would use the owner's access: only the owner can answer. */
export type PendingRequest = {
  requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[]
  ownerOnly?: boolean; askedBy?: { id: number; name: string } | null
}

export const sessionsQuery = (archived = false) => queryOptions({
  queryKey: ['claude', 'sessions', archived],
  queryFn: () => unwrap(api.api.claude.sessions.$get({ query: { archived: archived ? '1' : '0' } })),
})
export const sessionQuery = (id: string) => queryOptions({
  queryKey: ['claude', 'session', id],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].$get({ param: { id } })),
})
/**
 * One subagent's activity for a Task step, read by the parent Task's `tool_use` id. Fetched only when the step is
 * expanded (the caller sets `enabled`); while the subagent is still running the caller polls by setting `running`.
 */
export const subagentQuery = (id: string, toolUseId: string, running: boolean) => queryOptions({
  queryKey: ['claude', 'subagent', id, toolUseId],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].subagent.$get({ param: { id }, query: { toolUseId } })),
  refetchInterval: running ? 2500 : false,
  staleTime: running ? 0 : 60_000,
})
export type SubagentActivity = InferResponseType<(typeof api.api.claude.sessions)[':id']['subagent']['$get']>

export const profilesQuery = queryOptions({
  queryKey: ['claude', 'profiles'],
  queryFn: () => unwrap(api.api.claude.profiles.$get()),
  staleTime: 30_000,
})
export const commandsQuery = (profile: string) => queryOptions({
  queryKey: ['claude', 'commands', profile],
  queryFn: () => unwrap(api.api.claude.commands.$get({ query: { profile } })),
  staleTime: 60_000,
})

/** Keeps the cached session list in step with live status changes. */
export function useLiveSessions() {
  const qc = useQueryClient()
  useTopic('sessions', (e) => {
    // The owner stopped sharing it with this member: it leaves their list.
    if (e.type === 'gone') {
      qc.setQueryData(sessionsQuery(false).queryKey, (old) => old && { sessions: old.sessions.filter((x) => x.id !== e.id) })
      return
    }
    if (e.type !== 'session') return
    const s = e.session as Session
    qc.setQueryData(sessionsQuery(false).queryKey, (old) => {
      if (!old) return old
      const rest = old.sessions.filter((x) => x.id !== s.id)
      return { sessions: s.archived ? rest : [s, ...rest].sort((a, b) => b.lastActivityAt - a.lastActivityAt) }
    })
  }, () => void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] }))
}

export type ProjectSession = InferResponseType<(typeof api.api.claude.projects)[':slug']['sessions']['$get']>['sessions'][number]
/** Every session in a project you may open (the roles' too), and how many private ones of others there are. */
export const projectSessionsQuery = (slug: string, archived = false) => queryOptions({
  queryKey: ['claude', 'sessions', 'project', slug, archived],
  queryFn: () => unwrap(api.api.claude.projects[':slug'].sessions.$get({ param: { slug }, query: { archived: archived ? '1' : '0' } })),
})

/** Keeps a project's session lists in step: status changes in place; new, archived and others' private sessions refetch. */
export function useLiveProjectSessions(slug: string) {
  const qc = useQueryClient()
  useTopic('sessions', (e) => {
    if (e.type === 'gone') return void qc.invalidateQueries({ queryKey: ['claude', 'sessions', 'project', slug] })
    if (e.type !== 'session') return
    const s = e.session as Session
    if (s.project?.slug !== slug) return
    for (const archived of [false, true]) {
      const key = projectSessionsQuery(slug, archived).queryKey
      const old = qc.getQueryData(key)
      const had = old?.sessions.some((x) => x.id === s.id)
      if (old && had && s.archived === archived) qc.setQueryData(key, { ...old, sessions: old.sessions.map((x) => (x.id === s.id ? { ...x, ...s } : x)) })
      else if (had || s.archived === archived) void qc.invalidateQueries({ queryKey: key })
    }
  })
  // The project's live counters moved: someone's private session may have started or ended.
  useTopic('projects', () => void qc.invalidateQueries({ queryKey: ['claude', 'sessions', 'project', slug] }))
}

export const STATUS_LABEL: Record<Session['status'], string> = {
  working: 'Working', waiting: 'Needs you', idle: 'Idle', stopped: 'Stopped', error: 'Error',
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Runs everything without asking' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits files freely, asks before commands' },
  { value: 'plan', label: 'Plan', hint: 'Reads and plans, changes nothing until you approve' },
  { value: 'default', label: 'Ask', hint: 'Asks before each change' },
  { value: 'auto', label: 'Auto', hint: 'A classifier decides, asks when unsure' },
]
export const modeLabel = (m: string) => PERMISSION_MODES.find((p) => p.value === m)?.label ?? m

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const FALLBACK_MODELS: { value: string; displayName: string; description?: string }[] = [
  { value: '', displayName: 'Default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
]

export const relativeTime = (unix: number) => {
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}



