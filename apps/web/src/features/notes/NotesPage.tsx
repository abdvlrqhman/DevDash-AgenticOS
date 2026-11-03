import { useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, Lock, Pin, Plus, Sparkles, StickyNote } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useArrivals } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { notesQuery, projectsQuery, useLiveWork, type Note } from '../work/data'

/** First lines of the body without markdown symbols, for the list. */
const excerpt = (body: string) => body.replace(/[#>*_`~[\]()!|-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)

/** Who touched it last, when, and where, as one line: "Reviewer (AI team), 2 hours ago, in Billing API". */
const byline = (n: Note) => `${n.authorRole ? `${n.authorRole} (AI team)` : n.editor}, ${relativeTime(n.updatedAt)}${n.project ? `, in ${n.project.name}` : ''}`

/**
 * Notes as cards on the surface tone: a title, the first lines, who and when. A note Claude or a teammate saves while
 * you're looking lands in place (useArrivals).
 */
export function NoteList({ notes, empty, showPin = true }: { notes: Note[]; empty: string; showPin?: boolean }) {
  const list = useRef<HTMLUListElement>(null)
  useArrivals(list, notes.map((n) => String(n.id)))
  if (!notes.length) return <p className="text-sm text-pretty text-muted-foreground">{empty}</p>
  return (
    <ul ref={list} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {notes.map((n) => (
        <li key={n.id} data-key={n.id}>
          <Link to="/notes/$id" params={{ id: String(n.id) }}
            className={cn('flex h-full flex-col gap-2 rounded-2xl bg-surface p-4 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              n.status === 'superseded' && 'opacity-60')}>
            <span className="flex items-start gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug font-medium tracking-[-0.01em]">{n.title}</span>
              {n.private && <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Only you can see it" />}
              {showPin && n.pinned && <Pin className="mt-0.5 size-3.5 shrink-0 fill-current text-muted-foreground" aria-label="Pinned" />}
            </span>
            {n.body.trim() && <span className="line-clamp-3 text-pretty text-muted-foreground">{excerpt(n.body)}</span>}
            <span className="mt-auto flex min-w-0 items-center gap-1.5 pt-2 text-xs text-muted-foreground">
              {n.status !== 'confirmed' && <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-foreground">{n.status === 'draft' ? 'Draft' : 'Superseded'}</span>}
              {n.authorRole ? <Bot className="size-3.5 shrink-0" aria-label="AI team" /> : n.viaClaude && <Sparkles className="size-3.5 shrink-0" aria-label="Last edited by Claude" />}
              <span className="truncate">{byline(n)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function NotesPage() {
  useLiveWork()
  const [project, setProject] = useState('')
  const notes = useQuery(notesQuery(project || undefined))
  const projects = useQuery(projectsQuery).data?.projects ?? []
  const list = notes.data?.notes ?? []
  const pinned = list.filter((n) => n.pinned)
  const rest = list.filter((n) => !n.pinned)
  const here = projects.find((p) => p.slug === project)
  const newNote = (label: ReactNode) => <Link to="/notes/$id" params={{ id: 'new' }} search={{ project: project || undefined }}>{label}</Link>
  return (
    <>
      <PageHeader title="Notes" actions={<Button size="sm" asChild>{newNote(<><Plus />New note</>)}</Button>} />
      <PageBody className="gap-8 md:py-8">
        {projects.length > 0 && (
          <div role="group" aria-label="Project" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
            {[{ slug: '', name: 'All notes' }, ...projects].map((p) => (
              <Button key={p.slug} size="sm" variant={project === p.slug ? 'default' : 'outline'} aria-pressed={project === p.slug} onClick={() => setProject(p.slug)}>{p.name}</Button>
            ))}
          </div>
        )}
        <ErrorAlert error={notes.error} />
        {notes.isPending && <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}</div>}
        {notes.isSuccess && !list.length ? (
          project ? (
            <p className="text-sm text-pretty text-muted-foreground">
              No notes in {here?.name ?? 'this project'} yet. {newNote(<span className="text-foreground underline underline-offset-4">Write the first one</span>)}
            </p>
          ) : (
            <Empty className="rounded-2xl bg-surface">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="size-10 rounded-full bg-background"><StickyNote /></EmptyMedia>
                <EmptyTitle className="text-base">Write the team's first note</EmptyTitle>
                <EmptyDescription>Decisions, setup steps and links people keep asking for. Claude reads and writes them too.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button asChild>{newNote(<><Plus />New note</>)}</Button></EmptyContent>
            </Empty>
          )
        ) : notes.isSuccess && (pinned.length ? (
          <>
            <Group title="Pinned" count={pinned.length}><NoteList key={`p:${project}`} notes={pinned} empty="" showPin={false} /></Group>
            {rest.length > 0 && <Group title="Recent" count={rest.length}><NoteList key={`r:${project}`} notes={rest} empty="" /></Group>}
          </>
        ) : <NoteList key={project} notes={list} empty="" />)}
      </PageBody>
    </>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-[-0.01em]">{title}<span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span></h2>
      {children}
    </section>
  )
}
