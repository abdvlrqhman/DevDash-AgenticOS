import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Copy, Download, Ellipsis, File, Folder, FolderPlus, Link2, Lock, Pencil, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { FileViewer } from './FileViewer'
import { Progress } from './Progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, api, unwrap } from '@/lib/api'
import { bytes, cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import type { FileRef } from '../claude/file-links'

export { bytes }
const join = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`
const CHUNK = 8 * 1024 * 1024

type Entry = { name: string; dir: boolean; link: boolean; size: number | null; mtime: number }

export function FilesPage() {
  const { path, tab } = useSearch({ from: '/app/files' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['files', path ?? null], queryFn: () => unwrap(api.api.files.$get({ query: { path } })) })
  const [sharing, setSharing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<FileRef | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const [mkdir, setMkdir] = useState(false)
  const [uploads, setUploads] = useState<{ name: string; done: number; total: number }[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const go = (p: string) => void navigate({ to: '/files', search: { path: p } })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['files'] })
  const dir = q.data?.path ?? ''
  const root = q.data?.roots.filter((r) => dir === r.path || dir.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]

  // Uploads go in 8 MB pieces, one file after another, with progress.
  async function upload(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setUploads((u) => [...u, { name: f.name, done: 0, total: f.size }])
      try {
        for (let offset = 0; offset === 0 || offset < f.size; offset += CHUNK) {
          const res = await fetch(`/api/files/upload?${new URLSearchParams({ path: join(dir, f.name), offset: String(offset) })}`, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: f.slice(offset, offset + CHUNK),
          })
          if (!res.ok) {
            const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
            throw new ApiError(e?.error?.message ?? `Upload failed (${res.status})`, res.status, 'upload')
          }
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, done: Math.min(f.size, offset + CHUNK) } : x)))
          if (f.size === 0) break
        }
        toast.success(`Uploaded ${f.name}`)
      } catch (err) {
        toast.error(`${f.name}: ${(err as Error).message}`)
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name))
        refresh()
      }
    }
  }

  // A folder outside the places (/tmp, where Claude often saves things) gets its whole path as crumbs.
  const crumbs = root ? [{ label: root.label, path: root.path }, ...dir.slice(root.path.length).split('/').filter(Boolean).map((part, i, all) => ({
    label: part, path: join(root.path, all.slice(0, i + 1).join('/')),
  }))] : dir.split('/').filter(Boolean).map((part, i, all) => ({ label: part, path: `/${all.slice(0, i + 1).join('/')}` }))

  return (
    <>
      <PageHeader title="Files" actions={tab !== 'links' && <>
        <Button size="sm" variant="outline" onClick={() => setMkdir(true)} disabled={!dir}><FolderPlus /><span className="hidden sm:inline">New folder</span></Button>
        <Button size="sm" onClick={() => picker.current?.click()} disabled={!dir}><Upload />Upload</Button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = '' }} />
      </>} />
      <PageBody>
        <Tabs value={tab ?? 'files'} onValueChange={(v) => void navigate({ to: '/files', search: { path, tab: v === 'links' ? 'links' : undefined } })} className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="links">Share links</TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {q.data && (
                <NativeSelect aria-label="Place" className="w-40 [&_select]:h-8" value={root?.id ?? ''} onChange={(e) => go(q.data.roots.find((r) => r.id === e.target.value)!.path)}>
                  {!root && <option value="" disabled>Elsewhere</option>}
                  {q.data.roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </NativeSelect>
              )}
              <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
                    <button onClick={() => go(c.path)} className={cn('rounded px-1.5 py-0.5 hover:bg-accent', i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground')}>{c.label}</button>
                  </span>
                ))}
              </nav>
            </div>
            {uploads.map((u) => (
              <div key={u.name} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                <Upload className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <Progress value={u.total ? (u.done / u.total) * 100 : 100} className="w-32" />
              </div>
            ))}
            <ErrorAlert error={q.error} />
            {q.isPending ? <Skeleton className="h-64" /> : q.data && (
              <div
                onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files) }}
                className={cn('overflow-hidden rounded-xl border transition-colors', dragging && 'border-ring bg-accent/40 ring-2 ring-ring/40')}>
                {!q.data.entries.length && <p className="px-4 py-10 text-center text-sm text-muted-foreground">Empty folder. Drop files here or use Upload.</p>}
                <ul>
                  {q.data.entries.map((e) => {
                    const p = join(dir, e.name)
                    return (
                      <li key={e.name} className="group flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-accent/40">
                        {e.dir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
                        <div className="flex min-w-0 flex-1 flex-col">
                          {e.dir
                            ? <button className="truncate text-left" onClick={() => go(p)}>{e.name}</button>
                            : <a className="truncate" href={`/api/files/download?${new URLSearchParams({ path: p })}`} download={e.name}
                                onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); setViewing({ path: p }) }}>{e.name}</a>}
                          <span className="text-xs text-muted-foreground md:hidden">{e.dir ? '' : `${bytes(e.size)}, `}{relativeTime(e.mtime)}</span>
                        </div>
                        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">{e.dir ? '' : bytes(e.size)}</span>
                        <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">{relativeTime(e.mtime)}</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Actions for ${e.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!e.dir && <DropdownMenuItem asChild><a href={`/api/files/download?${new URLSearchParams({ path: p })}`} download={e.name}><Download />Download</a></DropdownMenuItem>}
                            {!e.dir && <DropdownMenuItem onSelect={() => setSharing(p)}><Link2 />Share link</DropdownMenuItem>}
                            <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(p).then(() => toast.success('Path copied'))}><Copy />Copy path</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setRenaming(e)}><Pencil />Rename</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(e)}><Trash2 />Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </TabsContent>
          <TabsContent value="links"><ShareLinks /></TabsContent>
        </Tabs>
      </PageBody>
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
      {sharing && <ShareDialog path={sharing} onClose={() => setSharing(null)} />}
      <NameDialog open={mkdir} title="New folder" action="Create folder" initial="" onClose={() => setMkdir(false)}
        onSave={(name) => unwrap(api.api.files.mkdir.$post({ json: { path: join(dir, name) } })).then(refresh)} />
      <NameDialog open={!!renaming} title={`Rename ${renaming?.name ?? ''}`} action="Rename" initial={renaming?.name ?? ''} onClose={() => setRenaming(null)}
        onSave={(name) => unwrap(api.api.files.rename.$post({ json: { from: join(dir, renaming!.name), to: join(dir, name) } })).then(refresh)} />
      <ResponsiveDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} title={`Delete ${deleting?.name ?? ''}?`}
        description={deleting?.dir ? 'The folder and everything in it are deleted from the server, and their share links stop working. This cannot be undone.' : 'It is deleted from the server, and its share links stop working. This cannot be undone.'}>
        <DeleteActions onCancel={() => setDeleting(null)} onDelete={() => unwrap(api.api.files.delete.$post({ json: { path: join(dir, deleting!.name) } })).then((r) => {
          setDeleting(null); refresh()
          if (r.links) { void qc.invalidateQueries({ queryKey: ['shares'] }); toast(`${r.links === 1 ? 'Its share link was' : `${r.links} share links were`} turned off`) }
        })} />
      </ResponsiveDialog>
    </>
  )
}

function DeleteActions({ onCancel, onDelete }: { onCancel: () => void; onDelete: () => Promise<unknown> }) {
  const del = useMutation({ mutationFn: onDelete })
  return (
    <div className="flex flex-col gap-3">
      <ErrorAlert error={del.error} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>Keep it</Button>
        <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate()}>Delete</Button>
      </div>
    </div>
  )
}

function NameDialog({ open, title, action, initial, onClose, onSave }: { open: boolean; title: string; action: string; initial: string; onClose: () => void; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(initial)
  const save = useMutation({ mutationFn: () => onSave(name.trim()), onSuccess: onClose })
  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { if (!v) { onClose(); save.reset() } else setName(initial) }} title={title}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="nd-name">Name</FieldLabel>
            <Input id="nd-name" autoFocus className="h-10" value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <ErrorAlert error={save.error} />
          <Button type="submit" className="h-10" disabled={!name.trim() || save.isPending}>{action}</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

const EXPIRIES = [['1h', '1 hour'], ['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days'], ['never', 'Never']] as const

export function ShareDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [expires, setExpires] = useState<(typeof EXPIRIES)[number][0]>('7d')
  const [password, setPassword] = useState('')
  const [max, setMax] = useState('')
  const create = useMutation({
    mutationFn: () => unwrap(api.api.files.shares.$post({ json: { path, expires, password: password || undefined, maxDownloads: max ? Number(max) : null } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shares'] }),
  })
  const share = create.data?.share
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title={share ? 'Link ready' : `Share ${path.split('/').pop()}`}
      description={share ? 'Anyone with the link can download it, no account needed.' : 'People download a copy taken now; later changes to the file are not included.'}>
      {share ? (
        <div className="flex flex-col gap-3 pb-2">
          <div className="flex gap-2">
            <Input readOnly value={share.url} className="h-10 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button className="h-10" onClick={() => void navigator.clipboard.writeText(share.url).then(() => toast.success('Link copied'))}><Copy />Copy</Button>
          </div>
          <p className="text-xs text-muted-foreground">{bytes(share.size)}{share.hasPassword ? ', password protected' : ''}{share.expiresAt ? `, works until ${new Date(share.expiresAt * 1000).toLocaleString()}` : ''}.</p>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sh-exp">Link works for</FieldLabel>
              <NativeSelect id="sh-exp" value={expires} onChange={(e) => setExpires(e.target.value as typeof expires)}>
                {EXPIRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="sh-pw">Password</FieldLabel>
              <Input id="sh-pw" type="text" autoComplete="off" className="h-10" placeholder="None" value={password} onChange={(e) => setPassword(e.target.value)} />
              <FieldDescription>Optional. Send it separately from the link.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="sh-max">Download limit</FieldLabel>
              <Input id="sh-max" type="number" min={1} inputMode="numeric" className="h-10" placeholder="No limit" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
            <ErrorAlert error={create.error} />
            <Button type="submit" className="h-10" disabled={create.isPending}><Link2 />{create.isPending ? 'Copying the file…' : 'Create link'}</Button>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialog>
  )
}

function ShareLinks() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['shares'], queryFn: () => unwrap(api.api.files.shares.$get()) })
  const revoke = useMutation({
    mutationFn: (id: number) => unwrap(api.api.files.shares[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shares'] }); toast.success('Link turned off') },
    onError: (e) => toast.error(e.message),
  })
  if (q.isPending) return <Skeleton className="h-40" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.shares.length) return <p className="text-sm text-muted-foreground">No share links yet. Open a file's menu and choose Share link; build artifacts can be shared from a project's Builds tab.</p>
  return (
    <ul className="overflow-hidden rounded-xl border">
      {q.data.shares.map((s) => (
        <li key={s.id} className={cn('flex items-center gap-3 border-b px-3 py-2.5 text-sm last:border-b-0', !s.active && 'opacity-60')}>
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 truncate font-medium">{s.hasPassword && <Lock className="size-3.5 shrink-0" />}{s.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {bytes(s.size)}, {s.downloads}{s.maxDownloads ? ` of ${s.maxDownloads}` : ''} {s.downloads === 1 ? 'download' : 'downloads'}, {s.active ? (s.expiresAt ? `until ${new Date(s.expiresAt * 1000).toLocaleDateString()}` : 'no expiry') : 'no longer works'}, by {s.creator} {relativeTime(s.createdAt)}
            </span>
          </span>
          {s.active && <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(s.url).then(() => toast.success('Link copied'))}><Copy /></Button>}
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>Turn off</Button>
        </li>
      ))}
    </ul>
  )
}
