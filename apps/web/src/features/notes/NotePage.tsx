import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Ellipsis, Eye, Lock, Pencil, Pin, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { NativeSelect } from '@/components/app/native-select'
import { PageHeader, pageCol } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import { api, meQuery, unwrap } from '@/lib/api'
import { PinButton } from '../pins/pins'
import { ErrorAlert } from '../auth/LoginPage'
import { Prose } from '../claude/Blocks'
import { relativeTime } from '../claude/data'
import { noteQuery, projectsQuery, type Note } from '../work/data'

type Draft = { title: string; body: string; project: string | null; pinned: boolean; private: boolean; status: Note['status'] }

/** One note. Saves by itself a moment after you stop typing; "new" becomes a real note on the first save. */
export function NotePage() {
  const { id } = useParams({ from: '/app/notes/$id' })
  const { project } = useSearch({ from: '/app/notes/$id' })
  const isNew = id === 'new'
  const q = useQuery({ ...noteQuery(Number(id)), enabled: !isNew })
  if (!isNew && q.error) return <><PageHeader title="Note" back="/notes" /><div className="p-4"><ErrorAlert error={q.error} /></div></>
  if (!isNew && !q.data) return <><PageHeader title="Note" back="/notes" /><div className="flex flex-col gap-3 p-4"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-64" /></div></>
  return <Editor key={id} note={isNew ? null : q.data!.note} initialProject={project ?? null} />
}

function Editor({ note, initialProject }: { note: Note | null; initialProject: string | null }) {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useQuery(projectsQuery).data?.projects ?? []
  const [d, setD] = useState<Draft>(() => note
    ? { title: note.title, body: note.body, project: note.project?.slug ?? null, pinned: note.pinned, private: note.private, status: note.status }
    : { title: '', body: '', project: initialProject, pinned: false, private: false, status: 'confirmed' })
  const [preview, setPreview] = useState(!!note?.body)
  const [dirty, setDirty] = useState(false)
  const idRef = useRef(note?.id ?? null)
  const isAuthor = !note || note.author.id === me.id

  const save = useMutation({
    mutationFn: async (v: Draft) => {
      const json = { ...v, title: v.title.trim() || 'Untitled' }
      if (idRef.current) return unwrap(api.api.notes[':id'].$patch({ param: { id: String(idRef.current) }, json: isAuthor ? json : { ...json, private: undefined } }))
      return unwrap(api.api.notes.$post({ json }))
    },
    onSuccess: ({ note: saved }) => {
      setDirty(false)
      void qc.invalidateQueries({ queryKey: ['notes'] })
      if (!idRef.current) {
        idRef.current = saved.id
        void navigate({ to: '/notes/$id', params: { id: String(saved.id) }, replace: true })
      }
    },
    onError: (e) => toast.error(e.message),
  })
  const change = (v: Partial<Draft>) => {
    setD((o) => ({ ...o, ...v }))
    setDirty(true)
  }
  // Autosave once typing pauses; nothing is saved for a new note until it has a title or text.
  useEffect(() => {
    if (!dirty || (!idRef.current && !d.title.trim() && !d.body.trim())) return
    const t = setTimeout(() => save.mutate(d), 800)
    return () => clearTimeout(t)
  }, [d, dirty]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useMutation({
    mutationFn: () => unwrap(api.api.notes[':id'].$delete({ param: { id: String(idRef.current) } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notes'] }); void navigate({ to: '/notes' }) },
    onError: (e) => toast.error(e.message),
  })

  const by = note ? (note.authorRole ? `${note.authorRole} · AI team` : note.editor) : ''
  const status = save.isPending ? 'Saving…' : dirty ? 'Unsaved' : note || idRef.current ? `Saved${note ? `, ${by} ${relativeTime(note.updatedAt)}` : ''}` : 'New note'
  return (
    <div className="flex h-full flex-col">
      <PageHeader back="/notes" title={d.title || 'Untitled'} description={status}
        actions={<>
          <Toggle size="sm" pressed={d.pinned} onPressedChange={(v) => change({ pinned: v })} aria-label="Pin to the top of Notes, for everyone" title="Pin to the top of Notes, for everyone"><Pin /></Toggle>
          {note && <PinButton kind="note" id={String(note.id)} labelled />}
          {isAuthor && <Toggle size="sm" pressed={d.private} onPressedChange={(v) => change({ private: v })} aria-label="Only me"><Lock /></Toggle>}
          <Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)}>{preview ? <><Pencil />Edit</> : <><Eye />Preview</>}</Button>
          {idRef.current && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Note options"><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate()}><Trash2 />Delete note</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>} />
      <div style={pageCol()} className="page-col flex w-full min-h-0 flex-1 flex-col gap-3 py-6 *:max-w-3xl">
        <input aria-label="Title" placeholder="Title" value={d.title} onChange={(e) => change({ title: e.target.value })}
          className="bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60" autoFocus={!note} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <NativeSelect aria-label="Project" className="w-48 [&_select]:h-8 [&_select]:text-xs" value={d.project ?? ''} onChange={(e) => change({ project: e.target.value || null })}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Status" className="w-32 [&_select]:h-8 [&_select]:text-xs" value={d.status === 'superseded' ? 'superseded' : d.status} onChange={(e) => change({ status: e.target.value as Note['status'] })}>
            <option value="confirmed">Confirmed</option>
            <option value="draft">Draft</option>
            {d.status === 'superseded' && <option value="superseded">Superseded</option>}
          </NativeSelect>
          {d.private ? <span className="flex items-center gap-1"><Lock className="size-3.5" />Only you can see it</span> : <span>The whole team can see it</span>}
        </div>
        {note?.status === 'superseded' && note.supersededBy && (
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Superseded by <Link to="/notes/$id" params={{ id: String(note.supersededBy) }} className="font-medium text-foreground hover:underline">note #{note.supersededBy}</Link>. Set it back to Confirmed to make it current again.
          </p>
        )}
        {preview ? (
          d.body.trim() ? <div className="pb-10"><Prose text={d.body} /></div> : <button className="text-left text-sm text-muted-foreground" onClick={() => setPreview(false)}>Empty. Tap to write.</button>
        ) : (
          <Textarea aria-label="Note" placeholder="Write in markdown: # headings, - lists, `code`, [links](https://…)" value={d.body} onChange={(e) => change({ body: e.target.value })}
            className="min-h-[50vh] flex-1 resize-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent" />
        )}
        <ErrorAlert error={save.error} />
      </div>
    </div>
  )
}
