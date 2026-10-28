import { useMemo, useState } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { Archive, ChevronRight, Folder, Plus, Search, Settings2, Sparkles, FolderGit2 } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { ResizeHandle, useStoredWidth } from '@/components/app/resize-handle'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { meQuery } from '@/lib/api'
import { cn } from '@/lib/utils'
import { byFolder, relativeTime, sessionsQuery, type Session } from './data'
import { useArchiveSession } from './ArchiveSession'
import { NewSession, SessionsPage } from './SessionsPage'

/**
 * Claude on wide screens: the session list stays on the left while a session is open on the right
 * (master-detail). On phones each is its own screen.
 */
export function ClaudeLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const withList = path !== '/claude/setup'
  const pane = useStoredWidth('claude-sessions', 320, 240, 560)
  return (
    <div className="flex h-full min-h-0">
      {withList && (
        <aside aria-label="Sessions" style={{ width: pane.width }} className="relative hidden h-full shrink-0 flex-col border-r lg:flex">
          <SessionsPane active={path.split('/')[2]} />
          <ResizeHandle label="Resize the session list" width={pane.width} min={240} max={560} onWidth={pane.setWidth} onReset={pane.reset} />
        </aside>
      )}
      <div className="h-full min-w-0 flex-1 overflow-y-auto"><Outlet /></div>
    </div>
  )
}

/** /claude: the list on phones; on wide screens the list is already on the left, so invite a choice. */
export function ClaudeIndex() {
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="lg:hidden"><SessionsPage /></div>
      <div className="hidden h-full items-center justify-center p-8 lg:flex">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
            <EmptyTitle>Pick a session</EmptyTitle>
            <EmptyDescription>Open one from the list, or start a new one. Sessions keep running on the server when you close this.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>
        </Empty>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')

function SessionsPane({ active }: { active?: string }) {
  const me = useQuery(meQuery).data!
  const list = useQuery(sessionsQuery(false))
  const navigate = useNavigate()
  const archive = useArchiveSession((s) => { if (s.id === active) void navigate({ to: '/claude' }) })
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return byFolder((list.data?.sessions ?? []).filter((s) => !needle || s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)))
  }, [list.data, q])

  return (
    <>
      <div className="flex min-h-14 items-center gap-2 border-b px-3">
        <h2 className="flex-1 text-[15px] font-semibold">Claude</h2>
        <Button variant="ghost" size="icon-sm" asChild aria-label="Claude setup"><Link to="/claude/setup"><Settings2 /></Link></Button>
        <Button size="sm" onClick={() => setCreating(true)}><Plus />New</Button>
      </div>
      <div className="p-3 pb-2">
        <InputGroup className="h-8">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput placeholder="Filter sessions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter sessions" />
        </InputGroup>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.isPending && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-1 mb-2 h-12" />)}
        {list.isSuccess && !groups.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{q ? 'No session matches.' : 'No sessions yet.'}</p>}
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <Collapsible key={g.key} defaultOpen>
              <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground" title={g.path}>
                <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                {g.project ? <FolderGit2 className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                <span className="min-w-0 truncate font-medium">{g.label}</span>
                <span className="ml-auto shrink-0 tabular-nums">{g.sessions.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {g.sessions.map((s) => (
                    <li key={s.id} className="group/row relative">
                      {s.owner.id === me.id && (
                        <Button size="icon-xs" variant="ghost" aria-label={`Archive ${s.title}`} onClick={() => archive.ask(s)}
                          className="absolute top-2 right-1.5 z-10 bg-background/80 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden"><Archive /></Button>
                      )}
                      <Link to="/claude/$id" params={{ id: s.id }}
                        className={cn('flex items-start gap-2.5 rounded-md py-2 pr-2 pl-6 text-sm hover:bg-accent', s.id === active && 'bg-accent', s.status === 'waiting' && s.id !== active && 'bg-attention-soft')}>
                        <StatusLight state={light(s)} className="mt-1.5" />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-1 font-medium">{s.title}</span>
                          <span className="line-clamp-1 text-xs text-muted-foreground">
                            {s.status === 'waiting' ? 'Needs you' : s.status === 'working' ? 'Working' : relativeTime(s.lastActivityAt)}{s.mode === 'cli' ? ', in CLI' : ''}
                          </span>
                        </span>
                        {s.owner.id !== me.id && <UserAvatar user={s.owner} className="size-6" textClassName="text-[10px]" />}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </nav>
      {archive.dialog}
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
