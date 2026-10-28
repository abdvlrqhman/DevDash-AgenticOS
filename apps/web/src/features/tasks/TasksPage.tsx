import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Columns3, List, ListTodo, Plus } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorAlert } from '../auth/LoginPage'
import { Board, TaskList } from '../work/Board'
import { projectsQuery, tasksQuery, useLiveWork } from '../work/data'
import { NewTask } from '../work/TaskBits'

const stored = (k: string, d: string) => {
  try { return localStorage.getItem(`devdash.${k}`) ?? d } catch { return d }
}
const store = (k: string, v: string) => {
  try { localStorage.setItem(`devdash.${k}`, v) } catch { /* not remembered */ }
}

export function TasksPage() {
  useLiveWork()
  const [view, setView] = useState(() => stored('tasks-view', 'board'))
  const [whose, setWhose] = useState(() => stored('tasks-whose', 'all'))
  const [project, setProject] = useState(() => stored('tasks-project', ''))
  const [adding, setAdding] = useState(false)
  const projects = useQuery(projectsQuery).data?.projects ?? []
  const tasks = useQuery(tasksQuery({ project: project || undefined, assignee: whose === 'mine' ? 'me' : undefined }))
  const list = tasks.data?.tasks ?? []

  return (
    <>
      <PageHeader title="Tasks" actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />New</Button>} />
      <PageBody>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => { if (v) { setView(v); store('tasks-view', v) } }} aria-label="View">
            <ToggleGroupItem value="board" aria-label="Board"><Columns3 /><span className="hidden sm:inline">Board</span></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List"><List /><span className="hidden sm:inline">List</span></ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup type="single" variant="outline" size="sm" value={whose} onValueChange={(v) => { if (v) { setWhose(v); store('tasks-whose', v) } }} aria-label="Whose tasks">
            <ToggleGroupItem value="all">Everyone</ToggleGroupItem>
            <ToggleGroupItem value="mine">Mine</ToggleGroupItem>
          </ToggleGroup>
          {projects.length > 1 && (
            <NativeSelect aria-label="Project" className="min-w-40 flex-1 sm:w-48 sm:flex-none [&_select]:h-7 pointer-coarse:[&_select]:h-9" value={project} onChange={(e) => { setProject(e.target.value); store('tasks-project', e.target.value) }}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </NativeSelect>
          )}
        </div>
        <ErrorAlert error={tasks.error} />
        {tasks.isPending ? (
          <div className="flex gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-72" />)}</div>
        ) : !projects.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><ListTodo /></EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>Tasks belong to a project. Add one from Projects, then plan work here, or let Claude pick it up.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === 'board' ? (
          <Board tasks={list} project={project || undefined} showProject={!project && projects.length > 1} />
        ) : (
          <TaskList tasks={list} showProject={!project && projects.length > 1} />
        )}
      </PageBody>
      <NewTask open={adding} onClose={() => setAdding(false)} project={project || undefined} />
    </>
  )
}
