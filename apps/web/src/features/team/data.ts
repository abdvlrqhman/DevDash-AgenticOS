import { infiniteQueryOptions, queryOptions, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'

export const teamQuery = (slug: string) => queryOptions({
  queryKey: ['team', 'project', slug],
  queryFn: () => unwrap(api.api.team.projects[':slug'].$get({ param: { slug } })),
})
export const roleQuery = (id: number) => queryOptions({
  queryKey: ['team', 'role', id],
  queryFn: () => unwrap(api.api.team.roles[':id'].$get({ param: { id: String(id) } })),
})

export const approvalsQuery = (status: 'pending' | 'decided', project?: string) => queryOptions({
  queryKey: ['team', 'approvals', status, project ?? null],
  queryFn: () => unwrap(api.api.team.approvals.$get({ query: { status, project } })),
})
export const approvalsCountQuery = queryOptions({
  queryKey: ['team', 'approvals', 'count'],
  queryFn: () => unwrap(api.api.team.approvals.count.$get()),
  staleTime: 30_000,
})
/** The projects that have approvals, each with its pending/decided counts and the roles waiting. */
export const approvalProjectsQuery = queryOptions({
  queryKey: ['team', 'approvals', 'projects'],
  queryFn: () => unwrap(api.api.team.approvals.projects.$get()),
})
export type ApprovalProject = InferResponseType<typeof api.api.team.approvals.projects['$get']>['projects'][number]
export type Proposal = InferResponseType<typeof api.api.team.approvals['$get']>['proposals'][number]
export const threadQuery = (id: number) => queryOptions({
  queryKey: ['team', 'thread', id],
  queryFn: () => unwrap(api.api.team.threads[':id'].$get({ param: { id: String(id) } })),
})
export type ThreadDetail = InferResponseType<typeof api.api.team.threads[':id']['$get']>
export type ThreadStatus = 'open' | 'waiting' | 'closed' | 'all'
export type ThreadFilter = { status: ThreadStatus; outcome?: CloseAs; role?: number; q?: string }
/** All of a project's threads, open and closed, a page at a time. */
export const threadsQuery = (slug: string, f: ThreadFilter) => infiniteQueryOptions({
  queryKey: ['team', 'threads', slug, f],
  queryFn: ({ pageParam }) => unwrap(api.api.team.projects[':slug'].threads.$get({
    param: { slug },
    query: { status: f.status, outcome: f.outcome, role: f.role, q: f.q || undefined, offset: String(pageParam) },
  })),
  initialPageParam: 0,
  getNextPageParam: (last) => last.next ?? undefined,
})
export type ThreadItem = InferResponseType<typeof api.api.team.projects[':slug']['threads']['$get']>['threads'][number]
export type CloseAs = 'done' | 'declined' | 'duplicate' | 'not_needed' | 'elsewhere'
/** How a thread ended, in words, with a calm color each. */
export const CLOSED_AS: Record<CloseAs, { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  declined: { label: 'Declined', tone: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  duplicate: { label: 'Duplicate', tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  not_needed: { label: 'Not needed', tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300' },
  elsewhere: { label: 'Handled elsewhere', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
}
export const MESSAGE_KINDS: Record<string, { label: string; tone: string }> = {
  alert: { label: 'Alert', tone: 'bg-destructive/15 text-destructive' },
  request: { label: 'Request', tone: 'bg-attention-soft text-attention-foreground dark:bg-attention/15 dark:text-attention' },
  question: { label: 'Question', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  fyi: { label: 'FYI', tone: 'bg-muted text-muted-foreground' },
  reply: { label: '', tone: '' },
}

export type Team = InferResponseType<typeof api.api.team.projects[':slug']['$get']>
export type Role = Team['roles'][number]
export type RoleDetail = InferResponseType<typeof api.api.team.roles[':id']['$get']>
export type Model = 'opus' | 'sonnet' | 'haiku'

/** Team pages stay current: anything a role or a person changes refreshes them. */
export function useLiveTeam() {
  const qc = useQueryClient()
  useTopic('team', () => void qc.invalidateQueries({ queryKey: ['team'] }), () => void qc.invalidateQueries({ queryKey: ['team'] }))
}

export type Slot = { days: number[]; at: string }
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** Starting points for a new role: a name, a line and a sensible schedule; Generate writes the instructions. */
export const TEMPLATES: { name: string; summary: string; schedule: Slot[] }[] = [
  { name: 'CEO', summary: 'Leads the team: decides what matters most, whether to ship, and sends the weekly summary.', schedule: [{ days: [1], at: '08:00' }] },
  { name: 'CTO', summary: 'Code health, risks and releases: how close we are to shipping and what could break.', schedule: [{ days: WEEKDAYS, at: '09:00' }] },
  { name: 'Product', summary: 'What users need next: turns feedback and data into a short, ordered list of work.', schedule: [{ days: [1, 4], at: '10:00' }] },
  { name: 'Marketing – Social', summary: 'Watches our socials and competitors, and says what to post and when.', schedule: [{ days: EVERY_DAY, at: '10:00' }] },
  { name: 'Growth – Store listing', summary: 'App store page, screenshots, reviews and ratings, and what brings people in.', schedule: [{ days: [2, 5], at: '11:00' }] },
  { name: 'Support', summary: 'Reads what users report, finds the patterns, and turns them into tasks.', schedule: [{ days: WEEKDAYS, at: '12:00' }] },
  { name: 'QA', summary: 'Checks what changed for bugs and gaps before each release.', schedule: [{ days: WEEKDAYS, at: '16:00' }] },
  { name: 'Finance', summary: 'Spending, revenue and costs: where money goes and what to cut or invest in.', schedule: [{ days: [5], at: '17:00' }] },
]
export const DEFAULT_SCHEDULE: Slot[] = [{ days: WEEKDAYS, at: '09:00' }]

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Weekdays 09:00", "Mon and Thu 10:00", "Every day 10:00". */
export function slotLabel(s: Slot) {
  const d = [...s.days].sort()
  const days = d.length === 7 ? 'Every day' : d.join() === WEEKDAYS.join() ? 'Weekdays' : d.join() === '0,6' ? 'Weekends'
    : d.map((x) => DAY_NAMES[x]).join(d.length === 2 ? ' and ' : ', ')
  return `${days} ${s.at}`
}
export const TRIGGER_LABELS: Record<string, { label: string; hint: string }> = {
  work: { label: 'After work in the project', hint: 'A Claude session in the project finished something (from the journal).' },
  task_done: { label: 'When a task is done', hint: 'Someone moved a task to Done, or a commit closed one.' },
  task_created: { label: 'When someone adds a task', hint: 'A person added a task (not a role or Claude).' },
}
export const KIND_LABELS: Record<string, string> = { code: 'Coding job', goal: 'New goal', task: 'Tasks', other: 'For people to do', close: 'Close?' }

/** "Mon 08:00" or "Tomorrow 09:00" for the next scheduled shift. */
export function nextLabel(at: number) {
  const d = new Date(at * 1000)
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return days === 0 ? `today ${time}` : days === 1 ? `tomorrow ${time}` : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

const TONES = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
]
/** Each role keeps its own color. */
export const roleTone = (id: number) => TONES[id % TONES.length]!
/** "Marketing – Social" → "MS", "CTO" → "CTO". */
export const roleMark = (name: string) => {
  const words = name.split(/[\s–-]+/).filter((w) => /\w/.test(w))
  if (words.length === 1 && words[0]!.length <= 4) return words[0]!.toUpperCase()
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
}
export const firstLine = (s: string | null | undefined) => (s ?? '').replace(/[#*_`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
