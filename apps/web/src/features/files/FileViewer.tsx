import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Code, Copy, Download, ExternalLink, File, FolderOpen, WrapText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'
import { ApiError, api, meQuery, unwrap } from '@/lib/api'
import { inPhoneApp } from '@/lib/shell'
import { bytes, cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { fileKind, folderOf, knownFor, type FileRef, type Opening, type Where } from '../claude/file-links'
import { shortPath } from '../claude/places'
import { Prose } from '../claude/Prose'
import { FileLinksContext, useFileLinks } from './open-file'

/** Biggest image shown in place; past that it's a download. */
const IMAGE_MAX = 25 * 1024 * 1024
/** Lines shown before "Show all", so a huge log doesn't freeze the page. */
const LINES = 5000

const download = (path: string, view?: boolean) => `/api/files/download?${new URLSearchParams({ path, ...(view ? { view: '1' } : {}) })}`
const nameOf = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/**
 * Lets everything inside open files in the viewer: file paths in Claude's replies and its steps (see open-file.ts).
 * `cwd` and `username` say where relative and ~/ paths point (a session's folder and its owner).
 */
export function FileViewerProvider({ cwd, username, touched, children }: Where & { touched?: string[]; children: ReactNode }) {
  const [at, setAt] = useState<FileRef | null>(null)
  // What Claude worked on changes with every message; read when a file is opened, so the conversation doesn't re-render.
  const known = useRef(touched ?? [])
  known.current = touched ?? []
  const asked = useRef(0)
  const value = useMemo(() => ({
    cwd, username,
    open: ({ path, line, also, said, lookIn }: Opening) => {
      const n = ++asked.current
      const paths = [...new Set([...(said ? knownFor(said, known.current) : []), path, ...(also ?? [])])].slice(0, 8)
      if (paths.length === 1 && !lookIn?.length) return setAt({ path, line })
      setAt({ path, line, finding: true })
      const show = (f: FileRef) => { if (asked.current === n) setAt(f) }
      void (async () => {
        // A file Claude worked on with that name, else the first place its words point that exists, else the files with
        // that name under the session's and the project's folders (one opens; several are offered).
        const first = await unwrap(api.api.files.first.$post({ json: { paths } })).catch(() => ({ path: null }))
        if (first.path) return show({ path: first.path, line })
        const found = lookIn?.length
          ? await unwrap(api.api.files.find.$post({ json: { name: nameOf(path), dirs: lookIn } })).catch(() => ({ paths: [] as string[] }))
          : { paths: [] as string[] }
        show(found.paths.length === 1 ? { path: found.paths[0]!, line } : { path, line, matches: found.paths })
      })()
    },
  }), [cwd, username])
  return (
    <FileLinksContext.Provider value={value}>
      {children}
      <FileViewer file={at} username={username} onClose={() => setAt(null)} onOpen={setAt} />
    </FileLinksContext.Provider>
  )
}

/** A file, read as the person looking (their own Linux permissions): markdown, code and text, images, or a download. */
export function FileViewer({ file, username, onClose, onOpen }: { file: FileRef | null; username?: string; onClose: () => void; onOpen?: (f: FileRef) => void }) {
  const me = useQuery(meQuery).data
  // Keeps showing the file while the sheet slides away.
  const [shown, setShown] = useState(file)
  if (file && file !== shown) setShown(file)
  const [source, setSource] = useState(false)
  const [wrap, setWrap] = useState(true)
  const path = shown?.path ?? ''
  const kind = fileKind(path).kind
  useLayoutEffect(() => { setSource(!!shown?.line) }, [shown])

  return (
    <Sheet open={!!file} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl data-[side=right]:xl:max-w-3xl">
        <SheetHeader className="gap-2 border-b px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <div className="min-w-0 pr-9">
            <SheetTitle className="truncate">{nameOf(path)}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs" title={path}>{shortPath(path, username ?? me?.username ?? '')}</SheetDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {kind === 'markdown' && <Toggle size="sm" pressed={source} onPressedChange={setSource} aria-label="Show the source"><Code />Source</Toggle>}
            {(kind === 'text' || (kind === 'markdown' && source)) && <Toggle size="sm" pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines"><WrapText />Wrap</Toggle>}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(path).then(() => toast.success('Path copied'))}><Copy />Copy path</Button>
            <Button size="sm" variant="ghost" asChild><a href={download(path)} download={nameOf(path)}><Download />Download</a></Button>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/files" search={{ path: folderOf(path) }} onClick={onClose}><FolderOpen /><span className="hidden sm:inline">Open in Files</span><span className="sm:hidden">Files</span></Link>
            </Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
          {shown?.finding ? <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Spinner />Looking for it…</p>
            : shown?.matches?.length ? <Matches file={shown} username={username ?? me?.username ?? ''} onOpen={onOpen} />
            : shown && <FileBody key={`${shown.path}:${shown.line ?? ''}`} file={shown} source={source} wrap={wrap} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** The name turned up in more than one place: newest first, the person picks. */
function Matches({ file, username, onOpen }: { file: FileRef; username: string; onOpen?: (f: FileRef) => void }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-muted-foreground">It isn't at that path. Files called {nameOf(file.path)}, newest first:</p>
      <div className="flex flex-col gap-1.5">
        {file.matches!.map((m) => (
          <Button key={m} variant="outline" className="h-auto justify-start py-2 text-left font-mono text-xs break-all whitespace-normal" onClick={() => onOpen?.({ path: m, line: file.line })}>
            <File className="shrink-0" />{shortPath(m, username)}
          </Button>
        ))}
      </div>
    </div>
  )
}

function FileBody({ file, source, wrap }: { file: FileRef; source: boolean; wrap: boolean }) {
  const { kind, mime } = fileKind(file.path)
  if (kind === 'image') return <ImageView path={file.path} mime={mime!} />
  return <TextView file={file} markdown={kind === 'markdown' && !source} pdf={kind === 'pdf'} wrap={wrap} />
}

function TextView({ file, markdown, pdf, wrap }: { file: FileRef; markdown: boolean; pdf: boolean; wrap: boolean }) {
  const links = useFileLinks()
  // Always fresh: Claude may have just changed it.
  const q = useQuery({ queryKey: ['files', 'read', file.path], queryFn: () => unwrap(api.api.files.read.$get({ query: { path: file.path } })), staleTime: 0, refetchOnMount: 'always' })
  // Links inside a markdown file are relative to it, and open here too.
  const here = useMemo(() => links && { ...links, cwd: folderOf(file.path) }, [links, file.path])

  if (q.isPending) return <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-5" />)}</div>
  if (q.error) return <Failed error={q.error} path={file.path} />
  const f = q.data
  if (pdf) {
    // The phone apps can't show a page in a new tab: there, Download hands it to the phone, which opens it.
    if (inPhoneApp()) return <Unviewable path={file.path} size={f.size} why="Download it to open it on this phone." />
    return (
      <Unviewable path={file.path} size={f.size} why="PDFs open in your browser's own viewer.">
        <Button variant="outline" asChild><a href={download(file.path, true)} target="_blank" rel="noopener"><ExternalLink />Open</a></Button>
      </Unviewable>
    )
  }
  if (f.text === null) return <Unviewable path={file.path} size={f.size} why={f.tooBig ? 'Too big to show here.' : 'Not a text file, so it can\'t be shown here.'} />
  if (markdown) return <div className="px-5 py-4"><FileLinksContext.Provider value={here}><Prose text={f.text} /></FileLinksContext.Provider></div>
  return <Lines text={f.text} wrap={wrap} line={file.line} />
}

/** Code and text: monospace, numbered, the asked-for line in view and marked. */
function Lines({ text, wrap, line }: { text: string; wrap: boolean; line?: number }) {
  const all = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const [full, setFull] = useState(false)
  const hit = useRef<HTMLDivElement>(null)
  const shown = full || all.length <= LINES || (line ?? 0) > LINES ? all : all.slice(0, LINES)
  useEffect(() => { hit.current?.scrollIntoView({ block: 'center' }) }, [])
  if (!text) return <p className="p-4 text-sm text-muted-foreground">This file is empty.</p>
  return (
    <div className={cn('py-2 font-mono text-[12.5px] leading-5', !wrap && 'w-max min-w-full')}>
      {shown.map((l, i) => (
        <div key={i} ref={i + 1 === line ? hit : undefined} className={cn('flex', i + 1 === line && 'bg-attention/20')}>
          <span className="sticky left-0 shrink-0 bg-popover pr-3 pl-2 text-right text-muted-foreground/60 tabular-nums select-none" style={{ width: `${String(all.length).length + 3}ch` }}>{i + 1}</span>
          <span className={cn('min-w-0 flex-1 pr-4', wrap ? '[overflow-wrap:anywhere] whitespace-pre-wrap' : 'whitespace-pre')}>{l || ' '}</span>
        </div>
      ))}
      {shown.length < all.length && (
        <button className="px-4 py-2 text-left font-sans text-xs text-muted-foreground hover:text-foreground" onClick={() => setFull(true)}>Show all {all.length.toLocaleString()} lines</button>
      )}
    </div>
  )
}

/** Images come down as a blob (the download link always downloads), shown from memory. */
function ImageView({ path, mime }: { path: string; mime: string }) {
  const [state, setState] = useState<{ url?: string; size?: number; error?: Error }>({})
  useEffect(() => {
    const ctrl = new AbortController()
    let url: string | undefined
    void (async () => {
      const res = await fetch(download(path), { credentials: 'same-origin', signal: ctrl.signal })
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null
        throw new ApiError(e?.error?.message ?? `Could not open it (${res.status})`, res.status, e?.error?.code ?? 'http_error')
      }
      const size = Number(res.headers.get('content-length')) || 0
      if (size > IMAGE_MAX) { ctrl.abort(); return setState({ size }) }
      url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: mime }))
      setState({ url, size })
    })().catch((error: Error) => { if (!ctrl.signal.aborted) setState({ error }) })
    return () => { ctrl.abort(); if (url) URL.revokeObjectURL(url) }
  }, [path, mime])
  if (state.error) return <Failed error={state.error} path={path} />
  if (state.size !== undefined && !state.url) return <Unviewable path={path} size={state.size} why="Too big to show here." />
  if (!state.url) return <div className="p-4"><Skeleton className="h-64" /></div>
  return (
    <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
      <img src={state.url} alt={nameOf(path)} className="max-h-[80dvh] max-w-full object-contain" />
    </div>
  )
}

function Unviewable({ path, size, why, children }: { path: string; size: number; why: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <File className="size-10 text-muted-foreground" />
      <div>
        <p className="font-medium break-all">{nameOf(path)}</p>
        <p className="text-sm text-muted-foreground">{bytes(size)}. {why}</p>
      </div>
      <div className="flex gap-2">
        {children}
        <Button asChild><a href={download(path)} download={nameOf(path)}><Download />Download</a></Button>
      </div>
    </div>
  )
}

/** Not found, no permission, a folder: said plainly, and a folder opens in Files. */
function Failed({ error, path }: { error: Error; path: string }) {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <ErrorAlert error={error} />
      {/folder/i.test(error.message) && !/outside/i.test(error.message) && (
        <Button variant="outline" asChild><Link to="/files" search={{ path }}><FolderOpen />Open the folder in Files</Link></Button>
      )}
    </div>
  )
}
