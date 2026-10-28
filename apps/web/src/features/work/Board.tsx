import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useIsMobile } from '@/hooks/use-mobile'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { STATUSES, type Status, type Task } from './data'
import { NewTask, StatusIcon, TaskCard, TaskRow } from './TaskBits'

type Move = { slug: string; number: number; status: Status; sort: number }

/** Moves a task (optimistically, so dragging feels instant) and saves it. */
function useMoveTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (m: Move) => unwrap(api.api.tasks[':slug'][':number'].$patch({ param: { slug: m.slug, number: String(m.number) }, json: { status: m.status, sort: m.sort } })),
    onMutate: (m) => {
      qc.setQueriesData<{ tasks: Task[] }>({ queryKey: ['tasks', 'list'] }, (old) => old && {
        tasks: old.tasks.map((t) => (t.project.slug === m.slug && t.number === m.number ? { ...t, status: m.status, sort: m.sort } : t)),
      })
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  })
}

const byColumn = (tasks: Task[]) => Object.fromEntries(STATUSES.map((s) => [s.value, tasks.filter((t) => t.status === s.value).sort((a, b) => a.sort - b.sort)])) as Record<Status, Task[]>

/**
 * Kanban. Desktop: every column side by side, drag cards between and within them. Phones: one column at a time,
 * picked with tabs; the status is changed on the task itself.
 */
export function Board({ tasks, project, showProject }: { tasks: Task[]; project?: string; showProject: boolean }) {
  const mobile = useIsMobile()
  const cols = byColumn(tasks)
  const [column, setColumn] = useState<Status>('in_progress')
  const [adding, setAdding] = useState<Status | null>(null)
  const move = useMoveTask()
  const [over, setOver] = useState<Status | null>(null)

  const drop = (status: Status, e: React.DragEvent<HTMLElement>) => {
    e.preventDefault()
    setOver(null)
    const [slug, n] = e.dataTransfer.getData('text/x-devdash-task').split('#')
    if (!slug || !n) return
    // Place it before the first card whose middle is below the pointer.
    const list = cols[status].filter((t) => !(t.project.slug === slug && t.number === Number(n)))
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-task]')].filter((el) => el.dataset.task !== `${slug}#${n}`)
    const i = cards.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
    const before = i < 0 ? undefined : list[i]
    const after = i < 0 ? list[list.length - 1] : list[i - 1]
    const sort = before && after ? (before.sort + after.sort) / 2 : before ? before.sort - 1 : after ? after.sort + 1 : 1
    move.mutate({ slug, number: Number(n), status, sort })
  }

  if (mobile) {
    return (
      <div className="flex flex-col gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={column} onValueChange={(v) => v && setColumn(v as Status)} className="-mx-4 w-auto self-stretch overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]" aria-label="Column">
          {STATUSES.map((s) => (
            <ToggleGroupItem key={s.value} value={s.value} className="shrink-0 gap-1.5 px-2.5">
              {s.label}<span className="tabular-nums text-muted-foreground">{cols[s.value].length}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex flex-col gap-2">
          {cols[column].map((t) => <TaskCard key={`${t.project.slug}#${t.number}`} t={t} showProject={showProject} />)}
          {!cols[column].length && <p className="py-6 text-center text-sm text-muted-foreground">Nothing here.</p>}
          <Button variant="ghost" className={cn('text-muted-foreground', cols[column].length ? 'justify-start' : 'self-center')} onClick={() => setAdding(column)}><Plus />Add a task</Button>
        </div>
        <NewTask open={adding !== null} onClose={() => setAdding(null)} project={project} status={adding ?? undefined} />
      </div>
    )
  }

  return (
    <>
      <div className="-mx-4 flex min-h-0 gap-3 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6">
        {STATUSES.map((s) => (
          <section key={s.value} aria-label={s.label}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(s.value) }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
            onDrop={(e) => drop(s.value, e)}
            className={cn('flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/70 p-2 transition-colors dark:bg-muted/40 xl:w-auto xl:min-w-52 xl:flex-1 xl:basis-0', over === s.value && 'bg-muted ring-2 ring-ring/40')}>
            <h3 className="flex items-center gap-2 px-1.5 pt-1 text-sm font-medium">
              <StatusIcon status={s.value} />{s.label}<span className="tabular-nums text-muted-foreground">{cols[s.value].length}</span>
              <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={`Add a task to ${s.label}`} onClick={() => setAdding(s.value)}><Plus /></Button>
            </h3>
            {cols[s.value].map((t) => (
              <div key={`${t.project.slug}#${t.number}`} data-task={`${t.project.slug}#${t.number}`}>
                <TaskCard t={t} showProject={showProject} onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-devdash-task', `${t.project.slug}#${t.number}`)
                  e.dataTransfer.effectAllowed = 'move'
                }} />
              </div>
            ))}
            {!cols[s.value].length && <p className="px-1.5 py-4 text-center text-xs text-muted-foreground">Drop tasks here</p>}
          </section>
        ))}
      </div>
      <NewTask open={adding !== null} onClose={() => setAdding(null)} project={project} status={adding ?? undefined} />
    </>
  )
}

/** The same tasks as a list, grouped by status (Done last). */
export function TaskList({ tasks, showProject }: { tasks: Task[]; showProject: boolean }) {
  const cols = byColumn(tasks)
  const order: Status[] = ['in_progress', 'review', 'todo', 'backlog', 'done']
  return (
    <div className="flex flex-col gap-4">
      {order.filter((s) => cols[s].length).map((s) => (
        <section key={s} className="overflow-hidden rounded-xl border">
          <h3 className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
            <StatusIcon status={s} />{STATUSES.find((x) => x.value === s)!.label}<span className="tabular-nums text-muted-foreground">{cols[s].length}</span>
          </h3>
          {cols[s].map((t) => <TaskRow key={`${t.project.slug}#${t.number}`} t={t} showProject={showProject} />)}
        </section>
      ))}
      {!tasks.length && <p className="py-8 text-center text-sm text-muted-foreground">No tasks.</p>}
    </div>
  )
}
