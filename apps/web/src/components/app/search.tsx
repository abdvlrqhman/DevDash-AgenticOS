import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FolderGit2, Server, Sparkles, StickyNote } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { api, unwrap } from '@/lib/api'
import { StatusIcon } from '@/features/work/TaskBits'

let openSearch: (() => void) | null = null
/** Opens ⌘K from anywhere (e.g. a search button). */
export const showSearch = () => openSearch?.()

/** ⌘K / Ctrl+K: projects, tasks (try "app#12"), notes, Claude sessions and services. */
export function SearchDialog() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const navigate = useNavigate()
  useEffect(() => {
    openSearch = () => setOpen(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); openSearch = null }
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 150)
    return () => clearTimeout(t)
  }, [text])
  const r = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => unwrap(api.api.search.$get({ query: { q: debounced } })),
    enabled: open && debounced.length > 0,
    placeholderData: keepPreviousData,
  }).data

  const go = (to: string) => {
    setOpen(false)
    setText('')
    void navigate({ to })
  }
  const empty = r && !r.projects.length && !r.tasks.length && !r.notes.length && !r.sessions.length && !r.services.length

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Search projects, tasks, notes, Claude sessions and services">
      <Command shouldFilter={false}>
      <CommandInput placeholder="Search, or jump to a task like app#12" value={text} onValueChange={setText} />
      <CommandList>
        {!debounced && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Type to search everything you can see.</p>}
        {debounced && empty && <CommandEmpty>Nothing matches “{debounced}”.</CommandEmpty>}
        {!!r?.tasks.length && (
          <CommandGroup heading="Tasks">
            {r.tasks.map((t) => (
              <CommandItem key={t.key} value={`task ${t.key}`} onSelect={() => go(`/tasks/${t.slug}/${t.number}`)}>
                <StatusIcon status={t.status} />
                <span className="font-mono text-xs text-muted-foreground">{t.key}</span>
                <span className="truncate">{t.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!r?.projects.length && (
          <CommandGroup heading="Projects">
            {r.projects.map((p) => <CommandItem key={p.slug} value={`project ${p.slug}`} onSelect={() => go(`/projects/${p.slug}`)}><FolderGit2 />{p.name}</CommandItem>)}
          </CommandGroup>
        )}
        {!!r?.notes.length && (
          <CommandGroup heading="Notes">
            {r.notes.map((n) => (
              <CommandItem key={n.id} value={`note ${n.id}`} onSelect={() => go(`/notes/${n.id}`)}>
                <StickyNote />
                <span className="flex min-w-0 flex-col"><span className="truncate">{n.title}</span>{n.snippet && <span className="truncate text-xs text-muted-foreground">{n.snippet}</span>}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!r?.sessions.length && (
          <CommandGroup heading="Claude sessions">
            {r.sessions.map((s) => <CommandItem key={s.id} value={`session ${s.id}`} onSelect={() => go(`/claude/${s.id}`)}><Sparkles /><span className="truncate">{s.title}</span></CommandItem>)}
          </CommandGroup>
        )}
        {!!r?.services.length && (
          <CommandGroup heading="Services">
            {r.services.map((s) => <CommandItem key={s.name} value={`service ${s.name}`} onSelect={() => go(`/services/${s.name}`)}><Server /><span className="font-mono">{s.name}</span><span className="ml-auto text-xs text-muted-foreground">:{s.port}</span></CommandItem>)}
          </CommandGroup>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  )
}
