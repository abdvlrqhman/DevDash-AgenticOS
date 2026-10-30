import { useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
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
const idOf = (t: Task) => `${t.project.slug}#${t.number}`
/** Drop targets that are whole columns, or on phones their tabs, as opposed to cards. */
const COLUMN = 'column:'
const TAB = 'tab:'
const statusOf = (id: string) => (id.startsWith(COLUMN) ? id.slice(COLUMN.length) : id.startsWith(TAB) ? id.slice(TAB.length) : null) as Status | null

/**
 * The shared spring as an easing the Web Animations API takes (the drop animation): it wants the curve itself, not
 * var(--spring); older web views without linear() get a plain ease-out.
 */
const springEasing = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--spring').trim()
  return v && window.CSS.supports('animation-timing-function', v) ? v : 'cubic-bezier(0.23, 1, 0.32, 1)'
}

/** A sort value that puts a card at `index` among `list` (the column without the card itself). */
function sortAt(list: Task[], index: number) {
  const before = list[index]
  const after = list[index - 1]
  return before && after ? (before.sort + after.sort) / 2 : before ? before.sort - 1 : after ? after.sort + 1 : 1
}

/**
 * Kanban. Desktop: every column side by side; drag cards between and within them. Phones: one column at a time, picked
 * with tabs; press and hold a card to pick it up, then drop it in the list or on another column's tab. Drag runs on
 * pointer events (dnd-kit), not the browser's HTML drag and drop, which touch screens and the desktop app's web view
 * don't give pages. A keyboard can move cards too: focus one, space, arrows, space.
 */
export function Board({ tasks, project, showProject }: { tasks: Task[]; project?: string; showProject: boolean }) {
  const mobile = useIsMobile()
  const cols = byColumn(tasks)
  const [column, setColumn] = useState<Status>('in_progress')
  const [adding, setAdding] = useState<Status | null>(null)
  const move = useMoveTask()
  const [dragging, setDragging] = useState<Task | null>(null)
  // The click that ends a drag must not also open the task.
  const justDragged = useRef(false)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Press and hold, so a swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const find = (id: string) => tasks.find((t) => idOf(t) === id)

  const onDragStart = (e: DragStartEvent) => {
    setDragging(find(String(e.active.id)) ?? null)
    navigator.vibrate?.(10)
  }
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    justDragged.current = true
    setTimeout(() => { justDragged.current = false }, 0)
    const t = find(String(e.active.id))
    const overId = e.over ? String(e.over.id) : null
    if (!t || !overId) return
    const onCard = statusOf(overId) ? undefined : find(overId)
    if (onCard && idOf(onCard) === idOf(t)) return // put back where it was
    const status = onCard ? onCard.status : statusOf(overId)
    if (!status) return
    const list = cols[status].filter((x) => idOf(x) !== idOf(t))
    // On a card: take its place (below it when moving down within a column); on a column: the end of it.
    let index = list.length
    if (onCard) {
      index = list.findIndex((x) => idOf(x) === idOf(onCard))
      const from = cols[status].findIndex((x) => idOf(x) === idOf(t))
      if (from >= 0 && from <= index) index += 1
    }
    if (status === t.status && cols[status].findIndex((x) => idOf(x) === idOf(t)) === index) return
    move.mutate({ slug: t.project.slug, number: t.number, status, sort: sortAt(list, index) })
  }

  const board = mobile ? (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Column" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]">
        {STATUSES.map((s) => (
          <ColumnTab key={s.value} status={s.value} label={s.label} count={cols[s.value].length} current={column === s.value}
            dragging={!!dragging} onPick={() => setColumn(s.value)} />
        ))}
      </div>
      <Column status={column} tasks={cols[column]} showProject={showProject} className="flex flex-col gap-2">
        {!cols[column].length && <p className="py-6 text-center text-sm text-muted-foreground">Nothing here.</p>}
      </Column>
      <Button variant="ghost" className={cn('text-muted-foreground', cols[column].length ? 'justify-start' : 'self-center')} onClick={() => setAdding(column)}><Plus />Add a task</Button>
    </div>
  ) : (
    <div className="-mx-4 flex min-h-0 gap-3 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6">
      {STATUSES.map((s) => (
        <Column key={s.value} status={s.value} tasks={cols[s.value]} showProject={showProject} label={s.label}
          className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl p-1.5 transition-colors xl:w-auto xl:min-w-52 xl:flex-1 xl:basis-0"
          header={
            <h3 className="flex items-center gap-2 px-1.5 pt-1 text-sm font-medium">
              <StatusIcon status={s.value} />{s.label}<span className="tabular-nums text-muted-foreground">{cols[s.value].length}</span>
              <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={`Add a task to ${s.label}`} onClick={() => setAdding(s.value)}><Plus /></Button>
            </h3>
          }>
          {!cols[s.value].length && <p className="px-1.5 py-4 text-center text-xs text-muted-foreground">Drop tasks here</p>}
        </Column>
      ))}
    </div>
  )

  return (
    <div onClickCapture={(e) => { if (justDragged.current) { e.preventDefault(); e.stopPropagation() } }}>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}
        accessibility={{ screenReaderInstructions: { draggable: 'To move a task, press space, use the arrow keys, then press space again to drop it, or escape to cancel.' } }}>
        {board}
        {/* The card in hand: lifted, tilted a touch, and it lands on the shared spring. */}
        <DragOverlay dropAnimation={{ duration: 320, easing: springEasing() }}>
          {dragging && <div className="rotate-[1.5deg] scale-[1.03] rounded-2xl shadow-[0_18px_40px_-12px_color-mix(in_oklch,var(--foreground)_35%,transparent)]"><TaskCard t={dragging} showProject={showProject} /></div>}
        </DragOverlay>
      </DndContext>
      <NewTask open={adding !== null} onClose={() => setAdding(null)} project={project} status={adding ?? undefined} />
    </div>
  )
}

/** A column's cards, sortable, and the column itself a drop target (an empty one, or below its last card). */
function Column({ status, tasks, showProject, label, className, header, children }: {
  status: Status; tasks: Task[]; showProject: boolean; label?: string; className?: string; header?: ReactNode; children?: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: COLUMN + status })
  return (
    <section ref={setNodeRef} aria-label={label} className={cn(className, isOver && 'bg-surface ring-2 ring-ring/40')}>
      {header}
      <SortableContext items={tasks.map(idOf)} strategy={verticalListSortingStrategy}>
        {tasks.map((t) => <SortableCard key={idOf(t)} t={t} showProject={showProject} />)}
      </SortableContext>
      {children}
    </section>
  )
}

function SortableCard({ t, showProject }: { t: Task; showProject: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: idOf(t) })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} aria-roledescription="Task card"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // No text selection or iPhone link preview while holding a card to pick it up.
      className={cn('rounded-2xl outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-[3px] focus-visible:ring-ring/50', isDragging && 'opacity-40')}>
      <TaskCard t={t} showProject={showProject} />
    </div>
  )
}

/** A phone's column tab, which is also where a held card goes to move to that column. */
function ColumnTab({ status, label, count, current, dragging, onPick }: {
  status: Status; label: string; count: number; current: boolean; dragging: boolean; onPick: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TAB + status, disabled: current })
  return (
    <button ref={setNodeRef} role="tab" aria-selected={current} onClick={onPick}
      className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm transition-[background-color,scale] duration-300 ease-spring',
        current ? 'bg-foreground text-background' : 'bg-surface text-muted-foreground hover:text-foreground',
        dragging && !current && 'ring-1 ring-ring/40', isOver && 'scale-105 bg-surface-2 text-foreground ring-2 ring-ring/60')}>
      {label}<span className={cn('tabular-nums', current ? 'opacity-70' : 'opacity-80')}>{count}</span>
    </button>
  )
}

/** The same tasks as a list, grouped by status (Done last). */
export function TaskList({ tasks, showProject }: { tasks: Task[]; showProject: boolean }) {
  const cols = byColumn(tasks)
  const order: Status[] = ['in_progress', 'review', 'todo', 'backlog', 'done']
  return (
    <div className="flex flex-col gap-4">
      {order.filter((s) => cols[s].length).map((s) => (
        <section key={s} className="overflow-hidden rounded-2xl bg-surface">
          <h3 className="flex items-center gap-2 px-3.5 pt-3 pb-1.5 text-sm font-medium">
            <StatusIcon status={s} />{STATUSES.find((x) => x.value === s)!.label}<span className="tabular-nums text-muted-foreground">{cols[s].length}</span>
          </h3>
          {cols[s].map((t) => <TaskRow key={`${t.project.slug}#${t.number}`} t={t} showProject={showProject} />)}
        </section>
      ))}
      {!tasks.length && <p className="py-8 text-center text-sm text-muted-foreground">No tasks.</p>}
    </div>
  )
}
