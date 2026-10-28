import { useState, type DragEvent } from 'react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import type { InferResponseType } from 'hono/client'
import { FolderGit2, ListTodo, Pin, PinOff, Server, Sparkles, StickyNote, X } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { cn } from '@/lib/utils'
import { sessionsQuery } from '../claude/data'

// Each member's own shortcuts: projects, Claude sessions, tasks, notes and services they pinned to the sidebar
// (server: apps/server/src/modules/pins). Pinned on any device, they show on all of them.

export type PinKind = 'project' | 'session' | 'task' | 'note' | 'service'
export type PinItem = InferResponseType<typeof api.api.pins.$get>['pins'][number]

const ICON: Record<PinKind, typeof Pin> = { project: FolderGit2, session: Sparkles, task: ListTodo, note: StickyNote, service: Server }
const LIGHT: Record<string, 'live' | 'waiting' | 'error' | 'idle'> = {
  working: 'live', running: 'live', waiting: 'waiting', error: 'error', crashed: 'error',
}

export const pinsQuery = queryOptions({ queryKey: ['pins'], queryFn: () => unwrap(api.api.pins.$get()), staleTime: 30_000 })

/** The member's pins, kept fresh: changes from their other devices, and renamed projects. */
export function usePins() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['pins'] })
  useTopic('pins', refresh, refresh)
  useTopic('projects', refresh)
  return useQuery(pinsQuery).data?.pins ?? []
}

/** Whether this item is pinned, and a toggle. `id` is the item's handle: a slug, a session id, "slug/number"… */
export function usePinToggle(kind: PinKind, id: string) {
  const qc = useQueryClient()
  const pinned = !!useQuery(pinsQuery).data?.pins.some((p) => p.kind === kind && p.ref === id)
  const m = useMutation({
    mutationFn: () => unwrap(pinned ? api.api.pins.remove.$post({ json: { kind, ref: id } }) : api.api.pins.$post({ json: { kind, ref: id } })),
    onSuccess: (r) => qc.setQueryData(pinsQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  return { pinned, toggle: () => m.mutate(), pending: m.isPending }
}

/** A header button: pin this page's item to the sidebar, or unpin it. */
export function PinButton({ kind, id, labelled = false }: { kind: PinKind; id: string; labelled?: boolean }) {
  const { pinned, toggle, pending } = usePinToggle(kind, id)
  const label = pinned ? 'Unpin from your sidebar' : 'Pin to your sidebar'
  return (
    <Button variant="ghost" size={labelled ? 'sm' : 'icon-sm'} aria-label={label} title={label} aria-pressed={pinned} disabled={pending} onClick={toggle}>
      <Pin className={cn(pinned && 'fill-current')} />{labelled && 'Sidebar'}
    </Button>
  )
}

/** The same, as an item in a page's options menu. */
export function PinMenuItem({ kind, id }: { kind: PinKind; id: string }) {
  const { pinned, toggle } = usePinToggle(kind, id)
  return <DropdownMenuItem onSelect={toggle}>{pinned ? <PinOff /> : <Pin />}{pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}</DropdownMenuItem>
}

/** A pinned session's live status and title come from the session list the app already keeps current. */
function useLive(pins: PinItem[]) {
  const sessions = useQuery({ ...sessionsQuery(false), enabled: pins.some((p) => p.kind === 'session') }).data?.sessions
  return (p: PinItem) => {
    const s = p.kind === 'session' ? sessions?.find((x) => x.id === p.ref) : undefined
    return { title: s && !p.title.endsWith('· AI team') ? s.title : p.title, state: s?.status ?? p.state ?? null }
  }
}

/** The sidebar's "Pinned" group: drag to reorder, × to unpin. Nothing shows until something is pinned. */
export function SidebarPins() {
  const qc = useQueryClient()
  const pins = usePins()
  const live = useLive(pins)
  const path = useRouterState({ select: (s) => s.location.pathname })
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const save = useMutation({
    mutationFn: (order: PinItem[]) => unwrap(api.api.pins.order.$put({ json: { order: order.map(({ kind, ref }) => ({ kind, ref })) } })),
    onMutate: (order) => {
      const before = qc.getQueryData(pinsQuery.queryKey)
      qc.setQueryData(pinsQuery.queryKey, { pins: order }) // moves at once; the server's answer confirms it
      return { before }
    },
    onSuccess: (r) => qc.setQueryData(pinsQuery.queryKey, r),
    onError: (e, _o, ctx) => { if (ctx?.before) qc.setQueryData(pinsQuery.queryKey, ctx.before); toast.error(e.message) },
  })
  const unpin = useMutation({
    mutationFn: (p: PinItem) => unwrap(api.api.pins.remove.$post({ json: { kind: p.kind, ref: p.ref } })),
    onSuccess: (r) => qc.setQueryData(pinsQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  if (!pins.length) return null
  const drop = (to: number) => (e: DragEvent) => {
    e.preventDefault()
    if (dragging === null || dragging === to) return
    const next = [...pins]
    const [moved] = next.splice(dragging, 1)
    next.splice(to, 0, moved!)
    save.mutate(next)
  }
  return (
    <SidebarGroup className="px-2 py-1.5 pt-0">
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <SidebarMenu>
        {pins.map((p, i) => {
          const Icon = ICON[p.kind]
          const { title, state } = live(p)
          const light = state ? LIGHT[state] : undefined
          return (
            <SidebarMenuItem
              key={`${p.kind}:${p.ref}`}
              draggable
              onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => { e.preventDefault(); setOver(i) }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={drop(i)}
              onDragEnd={() => { setDragging(null); setOver(null) }}
              className={cn(dragging === i && 'opacity-50', over === i && dragging !== null && dragging !== i && 'rounded-md ring-1 ring-ring')}
            >
              <SidebarMenuButton asChild isActive={path === p.url || path.startsWith(`${p.url}/`)} tooltip={p.detail ? `${title} · ${p.detail}` : title} className="h-7">
                <Link to={p.url} draggable={false}>
                  <Icon />
                  <span className={cn(p.detail === 'archived' && 'text-muted-foreground')}>{title}</span>
                </Link>
              </SidebarMenuButton>
              {light && light !== 'idle' && <SidebarMenuBadge><StatusLight state={light} className="size-2" /></SidebarMenuBadge>}
              <SidebarMenuAction showOnHover aria-label={`Unpin ${title}`} title="Unpin" onClick={() => unpin.mutate(p)}><X /></SidebarMenuAction>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

/** On phones (no sidebar): the same pins at the top of the More page. */
export function PinnedList() {
  const pins = usePins()
  const live = useLive(pins)
  if (!pins.length) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-medium text-muted-foreground">Pinned</h2>
      <div className="flex flex-col divide-y rounded-lg border">
        {pins.map((p) => {
          const Icon = ICON[p.kind]
          const { title, state } = live(p)
          const light = state ? LIGHT[state] : undefined
          return (
            <Link key={`${p.kind}:${p.ref}`} to={p.url} className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {p.detail && <span className="shrink-0 truncate text-xs text-muted-foreground">{p.detail}</span>}
              {light && light !== 'idle' && <StatusLight state={light} />}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
