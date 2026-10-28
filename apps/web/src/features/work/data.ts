import { queryOptions, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'

const fetchProjects = (archived = false) => unwrap(api.api.projects.$get({ query: { archived: archived ? '1' : '0' } }))
const fetchProject = (slug: string) => unwrap(api.api.projects[':slug'].$get({ param: { slug } }))
const fetchTasks = (f: TaskFilter) => unwrap(api.api.tasks.$get({ query: { project: f.project, assignee: f.assignee, done: f.done } }))
const fetchTask = (slug: string, number: number) => unwrap(api.api.tasks[':slug'][':number'].$get({ param: { slug, number: String(number) } }))
const fetchNotes = (project?: string) => unwrap(api.api.notes.$get({ query: { project } }))
const fetchNote = (id: number) => unwrap(api.api.notes[':id'].$get({ param: { id: String(id) } }))
const fetchActivity = () => unwrap(api.api.activity.$get())

export type TaskFilter = { project?: string; assignee?: string; done?: 'recent' | 'all' }
export type Project = Awaited<ReturnType<typeof fetchProjects>>['projects'][number]
export type SessionSharing = Project['sessionSharing']
export type Task = Awaited<ReturnType<typeof fetchTasks>>['tasks'][number]
export type TaskDetail = Awaited<ReturnType<typeof fetchTask>>['task']
export type Note = Awaited<ReturnType<typeof fetchNotes>>['notes'][number]
export type Activity = Awaited<ReturnType<typeof fetchActivity>>['activity'][number]

export const projectsQuery = queryOptions({ queryKey: ['projects', 'list'], queryFn: () => fetchProjects() })
export const projectQuery = (slug: string) => queryOptions({ queryKey: ['projects', 'one', slug], queryFn: () => fetchProject(slug) })
export const commitsQuery = (slug: string) => queryOptions({
  queryKey: ['projects', 'commits', slug], queryFn: () => unwrap(api.api.projects[':slug'].commits.$get({ param: { slug } })), staleTime: 60_000,
})
export const tasksQuery = (f: TaskFilter = {}) => queryOptions({ queryKey: ['tasks', 'list', f], queryFn: () => fetchTasks(f) })
export const taskQuery = (slug: string, number: number) => queryOptions({ queryKey: ['tasks', 'one', slug, number], queryFn: () => fetchTask(slug, number) })
export const notesQuery = (project?: string) => queryOptions({ queryKey: ['notes', 'list', project ?? null], queryFn: () => fetchNotes(project) })
export const noteQuery = (id: number) => queryOptions({ queryKey: ['notes', 'one', id], queryFn: () => fetchNote(id) })
export const activityQuery = (project?: string) => queryOptions({
  queryKey: ['activity', project ?? null],
  queryFn: () => (project ? unwrap(api.api.projects[':slug'].activity.$get({ param: { slug: project } })) : fetchActivity()),
})

/** Keeps projects, tasks, notes and activity fresh while any page that shows them is open. */
export function useLiveWork() {
  const qc = useQueryClient()
  const refresh = (key: string) => () => void qc.invalidateQueries({ queryKey: [key] })
  useTopic('projects', refresh('projects'), refresh('projects'))
  useTopic('tasks', refresh('tasks'), refresh('tasks'))
  useTopic('notes', refresh('notes'), refresh('notes'))
  useTopic('activity', refresh('activity'), refresh('activity'))
}

export const STATUSES = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
] as const
export type Status = (typeof STATUSES)[number]['value']
export const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'No priority' },
] as const
export type Priority = (typeof PRIORITIES)[number]['value']

/** "Today", "Tomorrow", "3 days late", "Mon 14 Oct". */
export function dueLabel(due: string | null) {
  if (!due) return null
  const d = new Date(`${due}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (days === 0) return { text: 'Today', late: false, soon: true, today: true }
  if (days === 1) return { text: 'Tomorrow', late: false, soon: true }
  if (days < 0) return { text: days === -1 ? 'Yesterday' : `${-days} days late`, late: true, soon: false }
  return { text: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), late: false, soon: days < 4 }
}
