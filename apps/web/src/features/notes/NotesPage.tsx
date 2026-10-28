import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, Lock, Pin, Plus, Sparkles, StickyNote } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { notesQuery, projectsQuery, useLiveWork, type Note } from '../work/data'

/** First lines of the body without markdown symbols, for the list. */
const excerpt = (body: string) => body.replace(/[#>*_`~[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)

export function NoteList({ notes, empty }: { notes: Note[]; empty: string }) {
  if (!notes.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {notes.map((n) => (
        <li key={n.id}>
          <Link to="/notes/$id" params={{ id: String(n.id) }}
            className={cn('flex h-full flex-col gap-1.5 rounded-xl border bg-card p-4 text-sm transition-colors hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none', n.status === 'superseded' && 'opacity-60')}>
            <span className="flex items-center gap-1.5 font-medium">
              {n.pinned && <Pin className="size-3.5 shrink-0" aria-label="Pinned" />}
              {n.private && <Lock className="size-3.5 shrink-0" aria-label="Private" />}
              <span className="truncate">{n.title}</span>
              {n.status === 'superseded' ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">Superseded</span>
                : n.status === 'draft' ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">Draft</span> : null}
            </span>
            {n.body.trim() && <span className="line-clamp-3 text-muted-foreground">{excerpt(n.body)}</span>}
            <span className="mt-auto flex items-center gap-1 pt-1 text-xs text-muted-foreground">
              {n.authorRole ? <><Bot className="size-3" aria-label="AI team" />{n.authorRole} · AI team</>
                : <>{n.viaClaude && <Sparkles className="size-3" aria-label="Last edited by Claude" />}{n.editor}</>}, {relativeTime(n.updatedAt)}{n.project ? ` · ${n.project.name}` : ''}
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
  return (
    <>
      <PageHeader title="Notes" actions={<Button size="sm" asChild><Link to="/notes/$id" params={{ id: 'new' }} search={{ project: project || undefined }}><Plus />New</Link></Button>} />
      <PageBody>
        {projects.length > 0 && (
          <NativeSelect aria-label="Project" className="w-56 [&_select]:h-8" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All notes</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </NativeSelect>
        )}
        <ErrorAlert error={notes.error} />
        {notes.isPending && <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>}
        {notes.isSuccess && !list.length && !project ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><StickyNote /></EmptyMedia>
              <EmptyTitle>No notes yet</EmptyTitle>
              <EmptyDescription>Write down decisions, setup steps and links for the team. Claude reads and writes them too.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button asChild><Link to="/notes/$id" params={{ id: 'new' }}><Plus />New note</Link></Button></EmptyContent>
          </Empty>
        ) : notes.isSuccess && <NoteList notes={list} empty="No notes in this project yet." />}
      </PageBody>
    </>
  )
}
