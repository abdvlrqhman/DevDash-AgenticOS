import { useEffect, useRef, useState, type ReactNode } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, ListTodo, Plus, Search, StickyNote } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageHeader, pageCol } from '@/components/app/page'
import { showSearch } from '@/components/app/search'
import { Button } from '@/components/ui/button'
import { api, meQuery, spaceQuery, unwrap } from '@/lib/api'
import { landFrom, landTo, useArrivals, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { relativeTime, sessionPlace, sessionsQuery, type Session } from '@/features/claude/data'
import { NewSession } from '@/features/claude/SessionsPage'
import { servicesQuery, useLiveServices } from '@/features/services/data'
import { activityQuery, tasksQuery, useLiveWork, type Activity, type Task } from '@/features/work/data'
import { Due, NewTask, PriorityIcon, StatusIcon } from '@/features/work/TaskBits'

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const today = () => new Date().toISOString().slice(0, 10)
const now = () => Math.floor(Date.now() / 1000)
/** When a line happened: the time today, the date before that. */
const clock = (at: number) => {
  const d = new Date(at * 1000)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)
  return days === 0 ? time : days === 1 ? `Yesterday ${time}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const where = sessionPlace

/**
 * When this member last left Home (or put the app away while on it). Saved on this device only, it marks the
 * handover line: everything after it happened while they were away. Coming back to the app reads it again.
 */
const SEEN_KEY = 'devdash.home-seen'
const readSeen = () => {
  try { return Number(localStorage.getItem(SEEN_KEY)) || null } catch { return null }
}
function useLastHere() {
  const [last, setLast] = useState(readSeen)
  useEffect(() => {
    const save = () => { try { localStorage.setItem(SEEN_KEY, String(now())) } catch { /* not remembered */ } }
    const onVisibility = () => (document.visibilityState === 'hidden' ? save() : setLast(readSeen()))
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); save() }
  }, [])
  return last
}

/** The handover's status light flicks on once per app load, like a rack coming up; after that it just changes. */
let lit = false

type Line = { key: string; at: number; text: ReactNode; to?: string; tone?: 'live' | 'error' }

/**
 * Home is the server's handover note, in the order a returning teammate asks: does anything need me, what is still
 * running, what happened while I was away, what's on my plate. Sections with nothing to say stay out of the way.
 */
export function HomePage() {
  useLiveWork()
  useLiveServices()
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const sessionsQ = useQuery(sessionsQuery(false))
  const tasksQ = useQuery(tasksQuery({ assignee: 'me' }))
  const servicesQ = useQuery(servicesQuery)
  const activityQ = useQuery(activityQuery())
  const members = useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) }).data?.users ?? []
  const status = useQuery({ queryKey: ['status'], queryFn: () => unwrap(api.api.status.$get()), refetchInterval: 60_000 }).data
  const lastHere = useLastHere()
  const [creating, setCreating] = useState(false)
  const [newTask, setNewTask] = useState(false)

  const sessions = sessionsQ.data?.sessions ?? []
  const myTasks = (tasksQ.data?.tasks ?? []).filter((t) => t.status !== 'done')
  const services = servicesQ.data?.services ?? []
  const waiting = sessions.filter((s) => s.status === 'waiting' && s.owner.id === me.id)
  const working = sessions.filter((s) => s.status === 'working')
  const recent = sessions.filter((s) => s.status !== 'waiting' && s.status !== 'working' && s.owner.id === me.id).slice(0, 4)
  const urgent = myTasks.filter((t) => t.due && t.due <= today()).sort((a, b) => a.due!.localeCompare(b.due!))
  const upcoming = myTasks.filter((t) => !urgent.includes(t))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || rank(a) - rank(b))
  const crashed = services.filter((s) => s.state === 'crashed' && s.owner.id === me.id)
  const up = services.filter((s) => s.state === 'running')
  // Trouble on the server itself: everyone hears about their own account; admins hear about the rest.
  const trouble: { key: string; title: string; detail: string }[] = []
  if (status) {
    const disk = status.host.disk
    const used = disk ? (disk.total - disk.free) / disk.total : 0
    if (used >= 0.9) trouble.push({ key: 'disk', title: `The server's disk is ${Math.round(used * 100)}% full`, detail: 'Sessions, builds and backups fail when it fills up. Free some space.' })
    if (me.role === 'admin' && status.backup && !status.backup.ok) trouble.push({ key: 'backup', title: 'The last backup failed', detail: 'The Server page says why, and can run one now.' })
    for (const a of status.agents.filter((a) => !a.ok && (a.username === me.username || me.role === 'admin'))) {
      trouble.push({
        key: `agent:${a.username}`, detail: 'Claude sessions, terminals and files need it.',
        title: a.username === me.username ? 'Your server account is not responding' : `${a.name}'s server account is not responding`,
      })
    }
  }
  const needsYou = trouble.length + waiting.length + urgent.length + crashed.length
  const loaded = sessionsQ.isSuccess && tasksQ.isSuccess && servicesQ.isSuccess

  // The log: what the team (and Claude) did, plus my sessions that finished. My own clicks aren't news.
  const lines: Line[] = [
    ...(activityQ.data?.activity ?? []).filter((a) => a.viaClaude || a.user !== me.name).map(activityLine),
    ...sessions.filter((s) => s.owner.id === me.id && (s.status === 'idle' || s.status === 'error') && lastHere && s.lastActivityAt > lastHere)
      .map((s): Line => ({
        key: `s:${s.id}:${s.lastActivityAt}`, at: s.lastActivityAt, to: `/claude/${s.id}`, tone: s.status === 'error' ? 'error' : 'live',
        text: <>Claude {s.status === 'error' ? 'stopped with an error in' : 'finished'} <span className="text-foreground">{s.title}</span></>,
      })),
  ].sort((a, b) => b.at - a.at).slice(0, 12)
  const fresh = lastHere ? lines.filter((l) => l.at > lastHere).length : 0
  const away = lastHere ? now() - lastHere : 0

  // Signature: coming back after time away, the lines that happened meanwhile land one after another, oldest last.
  const log = useRef<HTMLOListElement>(null)
  useMotion((gsap) => {
    if (!fresh) return
    gsap.timeline()
      .fromTo('[data-fresh] [data-line]', landFrom, { ...landTo, stagger: 0.06 })
      .fromTo('[data-fresh] [data-tick]', { opacity: 0 }, { opacity: 1, duration: 0.24, ease: 'steps(3)', stagger: 0.06, clearProps: 'opacity' }, '<0.1')
  }, [activityQ.isSuccess && lastHere], log)

  const needsList = useRef<HTMLUListElement>(null)
  const runningList = useRef<HTMLUListElement>(null)
  useArrivals(needsList, loaded ? [...trouble.map((t) => t.key), ...waiting.map((s) => s.id), ...crashed.map((s) => s.name), ...urgent.map((t) => t.key)] : undefined)
  useArrivals(runningList, loaded ? [...working.map((s) => s.id), ...up.map((s) => s.name)] : undefined)
  useArrivals(log, activityQ.isSuccess ? lines.map((l) => l.key) : undefined)

  const light = needsYou ? 'waiting' : working.length || up.length ? 'live' : 'idle'
  const flick = !lit && loaded
  useEffect(() => { if (loaded) lit = true }, [loaded])

  return (
    <>
      <PageHeader title={space?.name ?? 'Home'} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New session</Button>} />
      <div style={pageCol()} className="page-col flex flex-col gap-10 py-6 md:py-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-x-12">
        {/* On phones both columns melt into one list (display: contents) and `order` sets the reading order. */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-10">
          <header className="order-1 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-muted-foreground">
                {greeting()}, {me.name.split(' ')[0]}.{lastHere && away > 300 && <> Last here {relativeTime(lastHere)}.</>}
              </p>
              <h2 className="flex items-baseline gap-3 text-2xl leading-tight font-semibold tracking-tight text-balance md:text-[1.75rem]">
                {loaded && <StatusLight state={light} className={cn('relative -top-0.5 size-3', flick && 'led-on')} />}
                {!loaded ? <span className="text-muted-foreground">Checking the server…</span>
                  : needsYou ? `${plural(needsYou, 'thing')} ${needsYou === 1 ? 'needs' : 'need'} you.`
                  : working.length ? `Nothing needs you. Claude is working on ${plural(working.length, 'session')}.`
                  : 'All quiet. Nothing needs you.'}
              </h2>
              {loaded && <Facts working={needsYou ? working.length : 0} up={up.length} total={services.length} />}
            </div>
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
              <Button variant="outline" size="sm" onClick={() => setNewTask(true)}><ListTodo />New task</Button>
              <Button variant="outline" size="sm" asChild><Link to="/notes/$id" params={{ id: 'new' }}><StickyNote />New note</Link></Button>
              <Button variant="outline" size="sm" onClick={showSearch}><Search />Search<kbd className="ml-1 hidden font-mono text-[10px] text-muted-foreground md:inline">⌘K</kbd></Button>
            </div>
          </header>

          {needsYou > 0 && (
            <Block title="Needs you" count={needsYou} className="order-2">
              <ul ref={needsList} className="divide-y overflow-hidden rounded-xl border">
                {trouble.map((t) => (
                  <Row key={t.key} k={t.key} to="/server" lead={<StatusLight state="error" />} title={t.title} detail={t.detail} />
                ))}
                {waiting.map((s) => (
                  <Row key={s.id} k={s.id} to={`/claude/${s.id}`} attention lead={<StatusLight state="waiting" />}
                    title={s.title} detail={`Claude is waiting for your answer, in ${where(s)}`} />
                ))}
                {crashed.map((s) => (
                  <Row key={s.name} k={s.name} to={`/services/${s.name}`} lead={<StatusLight state="error" />}
                    title={<span className="font-mono">{s.name}</span>} detail="Crashed and stopped restarting. Its logs say why." />
                ))}
                {urgent.map((t) => (
                  <Row key={t.key} k={t.key} to={`/tasks/${t.project.slug}/${t.number}`} lead={<StatusIcon status={t.status} />}
                    title={t.title} detail={<span className="flex items-center gap-2"><span className="font-mono">{t.key}</span><Due due={t.due} /></span>} />
                ))}
              </ul>
            </Block>
          )}

          <Block title={fresh ? 'While you were away' : 'Activity'} count={fresh || undefined} className="order-4">
            {!activityQ.isSuccess ? null : lines.length === 0 ? <Calm>Nothing has happened yet. Work done here, by the team or by Claude, shows up as it happens.</Calm> : (
              <ol ref={log} className="flex flex-col">
                {lines.map((l, i) => (
                  <li key={l.key} data-key={l.key} {...(i < fresh ? { 'data-fresh': '' } : {})}>
                    {i === fresh && fresh > 0 && (
                      <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />Last here {clock(lastHere!)}<span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <LogLine line={l} />
                  </li>
                ))}
              </ol>
            )}
          </Block>

          <Block title="Your tasks" count={upcoming.length} link={{ to: '/tasks', label: 'Board' }} className="order-5">
            {!tasksQ.isSuccess ? null : upcoming.length === 0 ? (
              <Calm>{urgent.length ? 'Nothing else on your plate.' : 'No tasks assigned to you.'} <button className="text-foreground underline underline-offset-4" onClick={() => setNewTask(true)}>Add one</button></Calm>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {upcoming.slice(0, 7).map((t) => <TaskLine key={t.key} t={t} />)}
              </ul>
            )}
          </Block>

          {recent.length > 0 && (
            <Block title="Pick up where you left off" link={{ to: '/claude', label: 'All sessions' }} className="order-6">
              <ul className="grid gap-2 sm:grid-cols-2">
                {recent.map((s) => (
                  <li key={s.id}>
                    <Link to="/claude/$id" params={{ id: s.id }}
                      className="flex h-full flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm transition-colors duration-150 hover:bg-accent/50 active:bg-accent">
                      <span className="line-clamp-1 font-medium">{s.title}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">{relativeTime(s.lastActivityAt)}, {where(s)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </div>

        <aside className="contents lg:sticky lg:top-20 lg:flex lg:flex-col lg:gap-10">
          <Block title="Running now" count={working.length + up.length || undefined} link={{ to: '/services', label: 'Services' }} className="order-3">
            {!loaded ? null : working.length + up.length === 0 ? <Calm>Nothing is running. Claude sessions and services show here while they work.</Calm> : (
              <ul ref={runningList} className="divide-y overflow-hidden rounded-xl border">
                {working.map((s) => (
                  <li key={s.id} data-key={s.id}>
                    <Link to="/claude/$id" params={{ id: s.id }} className="flex items-center gap-3 px-3.5 py-3 text-sm transition-colors duration-150 hover:bg-accent/50 active:bg-accent">
                      <StatusLight state="live" />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1 font-medium">{s.title}</span>
                        <span className="line-clamp-1 text-xs text-muted-foreground">{s.statusDetail || 'Working'}, in {where(s)}</span>
                      </span>
                      {s.owner.id !== me.id && <UserAvatar user={s.owner} className="size-6" textClassName="text-[10px]" title={s.owner.name} />}
                    </Link>
                  </li>
                ))}
                {up.map((s) => (
                  <li key={s.name} data-key={s.name}>
                    <Link to="/services/$name" params={{ name: s.name }} className="flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors duration-150 hover:bg-accent/50 active:bg-accent">
                      <StatusLight state={s.listening ? 'live' : 'idle'} />
                      <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">:{s.port}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          {members.length > 1 && (
            <Block title="Team" className="order-7">
              <ul className="flex flex-col gap-3">
                {members.map((u) => {
                  const busy = working.filter((s) => s.owner.id === u.id).length
                  return (
                    <li key={u.id} className="flex items-center gap-3 text-sm">
                      <UserAvatar user={u} className="size-7" textClassName="text-xs" />
                      <span className="min-w-0 flex-1 truncate">{u.name}{u.id === me.id && <span className="text-muted-foreground"> (you)</span>}</span>
                      {busy > 0 && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><StatusLight state="live" />{plural(busy, 'session')}</span>}
                    </li>
                  )
                })}
              </ul>
            </Block>
          )}
        </aside>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
      <NewTask open={newTask} onClose={() => setNewTask(false)} />
    </>
  )
}

const rank = (t: Task) => ['urgent', 'high', 'medium', 'low', 'none'].indexOf(t.priority)

const activityLine = (a: Activity): Line => ({
  key: `a:${a.id}`, at: a.at, to: a.url ?? undefined,
  text: <>
    <span className="font-medium text-foreground">{a.user ?? 'Someone'}</span>
    {a.viaClaude && ' (via Claude)'} {a.summary}
    {a.project && <> in {a.project.name}</>}
  </>,
})

/** One line of the log: the time it happened, a tick, what happened. */
function LogLine({ line }: { line: Line }) {
  const body = (
    <span data-line className="flex items-start gap-3 py-1.5 text-sm">
      <span className="w-16 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{clock(line.at)}</span>
      <span data-tick className={cn('mt-[7px] size-1.5 shrink-0 self-start rounded-[2px]',
        line.tone === 'error' ? 'bg-destructive' : line.tone === 'live' ? 'bg-live' : 'bg-muted-foreground/40')} />
      <span className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">{line.text}</span>
    </span>
  )
  return line.to ? <Link to={line.to} className="-mx-2 block rounded-md px-2 transition-colors duration-150 hover:bg-accent/50">{body}</Link> : body
}

/** What the headline leaves out (Needs you lists the rest right below), each a link to where it lives. */
function Facts({ working, up, total }: { working: number; up: number; total: number }) {
  const parts: ReactNode[] = []
  if (working) parts.push(<Fact key="r" to="/claude">Claude is working on {plural(working, 'session')}</Fact>)
  if (total) parts.push(<Fact key="s" to="/services">{up} of {plural(total, 'service')} up</Fact>)
  if (!parts.length) return null
  return (
    <p className="text-sm text-muted-foreground">
      {parts.map((p, i) => <span key={i}>{p}{i < parts.length - 2 ? ', ' : i === parts.length - 2 ? ' and ' : '.'}</span>)}
    </p>
  )
}

const Fact = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="underline decoration-muted-foreground/40 underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground">{children}</Link>
)

function Block({ title, count, link, className, children }: { title: string; count?: number; link?: { to: string; label: string }; className?: string; children: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{title}{count ? <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{count}</span> : null}</h3>
        {link && <Link to={link.to} className="-my-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground">{link.label}</Link>}
      </div>
      {children}
    </section>
  )
}

const Calm = ({ children }: { children: ReactNode }) => <p className="text-sm text-pretty text-muted-foreground">{children}</p>

function Row({ k, to, lead, title, detail, attention }: { k: string; to: string; lead: ReactNode; title: ReactNode; detail: ReactNode; attention?: boolean }) {
  return (
    <li data-key={k}>
      <Link to={to} className={cn('flex items-center gap-3 px-3.5 py-3 text-sm transition-colors duration-150 hover:bg-accent/50 active:bg-accent',
        attention && 'bg-attention-soft hover:bg-attention-soft/70')}>
        <span className="flex size-4 shrink-0 items-center justify-center">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">{title}</span>
          <span className={cn('line-clamp-1 text-xs', attention ? 'text-attention-foreground' : 'text-muted-foreground')}>{detail}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  )
}

function TaskLine({ t }: { t: Task }) {
  return (
    <li>
      <Link to="/tasks/$slug/$number" params={{ slug: t.project.slug, number: String(t.number) }}
        className="flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors duration-150 hover:bg-accent/50 active:bg-accent">
        <StatusIcon status={t.status} />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        <PriorityIcon priority={t.priority} />
        <Due due={t.due} />
        <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{t.key}</span>
      </Link>
    </li>
  )
}
