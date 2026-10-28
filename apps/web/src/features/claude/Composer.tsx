import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, File, FileText, Folder, Paperclip, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { uploadId, uploadInPieces } from '@/lib/upload'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { bytes } from '../files/FilesPage'
import { commandsQuery } from './data'
import { loadDraft, saveDraft } from './draft'

export type Img = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
/** Any other file: PDFs and text go to Claude as documents, anything else is saved on the server for Claude to open. */
export type Doc = { name: string; mediaType: string; data: string; size: number }
/** A file too big to send with the message: uploaded in pieces as soon as it's attached, then named in the message. */
export type Upload = { upload: string; name: string; size: number }
type Big = Upload & { sent: number; state: 'uploading' | 'done' | 'error'; error?: string }
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// Small ones go to Claude with the message (it sees images, reads PDFs and text); bigger ones are saved for it to open.
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_FILE = 10 * 1024 * 1024
const MAX_TOTAL = 250 * 1024 * 1024
const MAX_COUNT = 6

// Commands Claude Code always has, shown before the session reports its own list.
const BUILTIN = [
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'context', description: 'Show how much context is used' },
  { name: 'cost', description: 'Tokens and cost of this session' },
  { name: 'clear', description: 'Start a fresh conversation' },
  { name: 'model', description: 'Change the model' },
  { name: 'init', description: 'Write a CLAUDE.md for this project' },
  { name: 'memory', description: 'Edit memory files' },
  { name: 'review', description: 'Review a pull request' },
]

const base64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(new Error(`Could not read ${file.name}.`))
  r.readAsDataURL(file)
})

/** The @mention being typed right before the caret: "@src/ma" → { start, query: "src/ma" }. */
function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret))
  return m ? { start: m.index + m[1]!.length, query: m[2]! } : null
}

type Item = { key: string; label: string; hint?: string; icon?: ReactNode; apply: () => void }

export function Composer({ sessionId, profile, working, disabledReason, footer, onSend, onStop }: {
  sessionId: string
  profile: string
  working: boolean
  disabledReason?: ReactNode
  /** Small status row under the message box (context used, fast mode, Remote Control). */
  footer?: ReactNode
  onSend: (text: string, images: Img[], files: Doc[], uploads: Upload[]) => Promise<unknown>
  onStop: () => void
}) {
  // The text draft is kept per session (see draft.ts): restore this session's on mount, and keep it written as it
  // changes so switching away and back doesn't lose it. Attachments stay in memory — they're blobs, not worth saving.
  const [text, setText] = useState(() => loadDraft(sessionId))
  const draftFor = useRef(sessionId)
  const write = (next: string) => { setText(next); saveDraft(sessionId, next) }
  // Swap in the right draft only when the session id actually changes, so we never clobber a newer one with a load.
  useEffect(() => {
    if (draftFor.current === sessionId) return
    draftFor.current = sessionId
    setText(loadDraft(sessionId))
  }, [sessionId])
  // A big file is uploaded into one session's folder: switching sessions or leaving the page cancels unfinished ones.
  useEffect(() => () => {
    for (const c of uploads.current.values()) c.abort()
    uploads.current.clear()
    setBigs([])
  }, [sessionId])
  const [caret, setCaret] = useState(0)
  const [images, setImages] = useState<Img[]>([])
  const [files, setFiles] = useState<Doc[]>([])
  const [bigs, setBigs] = useState<Big[]>([])
  const uploads = useRef(new Map<string, AbortController>())
  const [error, setError] = useState<unknown>(null)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const cmds = useQuery({ ...commandsQuery(profile), enabled: text.startsWith('/') })

  const mention = useMemo(() => mentionAt(text, caret), [text, caret])
  const mentionKey = mention ? `${mention.start}:${mention.query}` : null
  const [query, setQuery] = useState<string | null>(null)
  // A short pause after typing before asking the server, so each keystroke isn't a request.
  useEffect(() => {
    const t = setTimeout(() => setQuery(mention && mentionKey !== dismissed ? mention.query : null), 120)
    return () => clearTimeout(t)
  }, [mention, mentionKey, dismissed])
  const found = useQuery({
    queryKey: ['claude', 'files', sessionId, query],
    queryFn: () => unwrap(api.api.claude.sessions[':id'].files.$get({ param: { id: sessionId }, query: { q: query ?? '' } })),
    enabled: query !== null && !disabledReason,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })

  const insert = (value: string, start: number, end: number) => {
    const next = text.slice(0, start) + value + text.slice(end)
    write(next)
    const at = start + value.length
    setCaret(at)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(at, at)
    })
  }

  const items: Item[] = useMemo(() => {
    const slash = /^\/([\w:-]*)$/.exec(text)
    if (slash) {
      const reported = (cmds.data?.commands as { name: string; description: string }[] | undefined) ?? []
      const all = [...reported, ...BUILTIN.filter((b) => !reported.some((r) => r.name === b.name))]
      return all.filter((c) => c.name.toLowerCase().includes(slash[1]!.toLowerCase())).slice(0, 8).map((c) => ({
        key: c.name, label: `/${c.name}`, hint: c.description,
        apply: () => insert(`/${c.name} `, 0, text.length),
      }))
    }
    if (!mention || mentionKey === dismissed || query === null || !found.data) return []
    return found.data.paths.slice(0, 12).map((p) => {
      const dir = p.endsWith('/')
      const name = dir ? p.slice(0, -1).split('/').pop()! : p.split('/').pop()!
      const parent = p.slice(0, p.length - name.length - (dir ? 1 : 0))
      return {
        key: p, label: name + (dir ? '/' : ''), hint: parent || undefined,
        icon: dir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />,
        apply: () => insert(`@${/\s/.test(p) ? `"${p}"` : p}${dir ? '' : ' '}`, mention.start, caret),
      }
    })
  }, [text, caret, cmds.data, found.data, mention, mentionKey, dismissed, query])

  useEffect(() => setSel(0), [items.length, mentionKey])

  /** Uploads a big file in pieces right away (progress on its chip), into this session's folder. */
  const startBig = (f: File) => {
    const upload = uploadId()
    const controller = new AbortController()
    uploads.current.set(upload, controller)
    setBigs((x) => [...x, { upload, name: f.name, size: f.size, sent: 0, state: 'uploading' }])
    const set = (patch: Partial<Big>) => setBigs((x) => x.map((b) => (b.upload === upload ? { ...b, ...patch } : b)))
    let shown = 0
    const url = (offset: number) => `/api/claude/sessions/${sessionId}/uploads?${new URLSearchParams({ upload, name: f.name, offset: String(offset), total: String(f.size) })}`
    uploadInPieces(f, url, (sent) => { if (Date.now() - shown > 200 || sent === f.size) { shown = Date.now(); set({ sent }) } }, controller.signal).then(
      () => set({ state: 'done', sent: f.size }),
      (e: Error) => { if (e.name !== 'AbortError') set({ state: 'error', error: e.message }) },
    ).finally(() => uploads.current.delete(upload))
  }
  const dropBig = (upload: string) => {
    uploads.current.get(upload)?.abort()
    setBigs((x) => x.filter((b) => b.upload !== upload))
  }

  const add = async (list: FileList | File[]) => {
    setError(null)
    try {
      const incoming = [...list].slice(0, Math.max(0, MAX_COUNT - images.length - files.length - bigs.length))
      if (incoming.length < list.length) setError(new Error(`Up to ${MAX_COUNT} files per message.`))
      let total = files.reduce((n, f) => n + f.size, 0) + images.reduce((n, i) => n + (i.data.length * 3) / 4, 0) + bigs.reduce((n, b) => n + b.size, 0)
      for (const f of incoming) {
        total += f.size
        if (total > MAX_TOTAL) throw new Error('Attachments can add up to 250 MB per message.')
        const image = IMAGE_TYPES.includes(f.type)
        if (f.size > (image ? MAX_IMAGE : MAX_FILE)) {
          startBig(f) // too big to send with the message: saved on the server for Claude to open
        } else if (image) {
          const data = await base64(f)
          setImages((x) => [...x, { mediaType: f.type as Img['mediaType'], data }])
        } else {
          const data = await base64(f)
          setFiles((x) => [...x, { name: f.name, mediaType: f.type || 'application/octet-stream', data, size: f.size }])
        }
      }
    } catch (e) {
      setError(e)
    }
  }
  const uploading = bigs.some((b) => b.state !== 'done')
  const empty = !text.trim() && !images.length && !files.length && !bigs.length
  const submit = () => {
    if (sending || empty || uploading || disabledReason) return
    const sent = { text, images, files, bigs }
    setSending(true)
    setError(null)
    // Dispatch the POST first and synchronously (hono fires the fetch on the call, before it awaits), so an immediate
    // session switch that unmounts us can't pre-empt it. Clear the box right away so the text can't reappear, but keep
    // the stored draft until the server has it — if the send fails we put everything back and show why.
    const posting = onSend(sent.text, sent.images, sent.files, sent.bigs.map(({ upload, name, size }) => ({ upload, name, size })))
    setText('')
    setImages([])
    setFiles([])
    setBigs([])
    posting.then(
      () => { saveDraft(sessionId, ''); setSending(false); area.current?.focus() },
      (e: unknown) => {
        write(sent.text); setImages(sent.images); setFiles(sent.files); setBigs(sent.bigs)
        setError(e); setSending(false); area.current?.focus()
      },
    )
  }
  const onKey = (e: KeyboardEvent) => {
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % items.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + items.length) % items.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); items[Math.min(sel, items.length - 1)]!.apply(); return }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (text.startsWith('/')) write('')
        else setDismissed(mentionKey)
        return
      }
    }
    // Esc with nothing typed stops Claude, as in the CLI.
    if (e.key === 'Escape' && working && empty) {
      e.preventDefault()
      onStop()
      return
    }
    // Enter sends on a keyboard; on phones Enter adds a line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      void add(e.clipboardData.files)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) void add(e.dataTransfer.files)
  }

  if (disabledReason) return <div className="py-2">{disabledReason}</div>

  return (
    <div className="relative flex flex-col gap-2" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={onDrop}>
      {dragging && (
        <div className="pointer-events-none absolute -inset-1 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 text-sm font-medium">
          Drop files to attach
        </div>
      )}
      {items.length > 0 && (
        <div role="listbox" aria-label={text.startsWith('/') ? 'Commands' : 'Files'} className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {items.map((c, i) => (
            <button key={c.key} role="option" aria-selected={i === sel} onMouseDown={(e) => e.preventDefault()} onClick={c.apply}
              className={cn('flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm', i === sel && 'bg-accent text-accent-foreground')}>
              {c.icon}
              <span className="shrink-0 font-mono">{c.label}</span>
              {c.hint && <span className="min-w-0 truncate text-muted-foreground">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <ErrorAlert error={error} />
      {/* One card: what you attach, what you write, and a row inside it with attach, the session's status and Stop/Send. */}
      <div className="flex flex-col gap-1 rounded-[22px] border bg-background px-2.5 pt-2 pb-1.5 shadow-xs transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30 dark:bg-input/20">
      {(images.length > 0 || files.length > 0 || bigs.length > 0) && (
        <div className="flex flex-wrap gap-2 px-1 pt-1">
          {images.map((img, i) => (
            <div key={`i${i}`} className="relative">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="size-14 rounded-md border object-cover" />
              <Remove label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />
            </div>
          ))}
          {files.map((f, i) => (
            <div key={`f${i}`} className="relative flex h-14 max-w-56 items-center gap-2 rounded-md border bg-muted/40 py-2 pr-3 pl-2.5">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 text-xs">
                <div className="truncate font-medium" title={f.name}>{f.name}</div>
                <div className="text-muted-foreground">{bytes(f.size)}</div>
              </div>
              <Remove label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} />
            </div>
          ))}
          {bigs.map((b) => (
            <div key={b.upload} className="relative flex h-14 max-w-56 items-center gap-2 overflow-hidden rounded-md border bg-muted/40 py-2 pr-3 pl-2.5">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 text-xs">
                <div className="truncate font-medium" title={b.name}>{b.name}</div>
                <div className={cn('truncate', b.state === 'error' ? 'text-destructive' : 'text-muted-foreground')} title={b.error}>
                  {b.state === 'error' ? b.error : b.state === 'uploading' ? `Uploading ${Math.floor((b.sent / Math.max(1, b.size)) * 100)}% of ${bytes(b.size)}` : bytes(b.size)}
                </div>
              </div>
              {b.state === 'uploading' && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width]" style={{ width: `${(b.sent / Math.max(1, b.size)) * 100}%` }} />}
              <Remove label={b.state === 'uploading' ? `Cancel ${b.name}` : `Remove ${b.name}`} onClick={() => dropBig(b.upload)} />
            </div>
          ))}
        </div>
      )}
      <Textarea ref={area} value={text} rows={1} onKeyDown={onKey} onPaste={onPaste} aria-label="Message Claude"
        onChange={(e) => { write(e.target.value); setCaret(e.target.selectionStart) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        placeholder={working ? 'Add a message for Claude' : 'Message Claude, @ to mention a file'}
        className="max-h-[40vh] min-h-9 resize-none rounded-none border-0 bg-transparent px-1.5 py-1 text-base leading-6 shadow-none [field-sizing:content] placeholder:truncate focus-visible:ring-0 md:text-sm md:leading-6 dark:bg-transparent" />
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" className="size-9 shrink-0 rounded-full text-muted-foreground" aria-label="Attach files" title="Attach images, PDFs or any file" onClick={() => picker.current?.click()}><Paperclip /></Button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">{footer}</div>
        {/* Stop is always there while Claude works; Send joins it once something is typed (it waits for Claude). */}
        {working && (
          <Button size="icon" variant="secondary" className="size-9 shrink-0 rounded-full" aria-label="Stop Claude" title="Stop (Esc)" onClick={onStop}>
            <Square className="fill-current" />
          </Button>
        )}
        {(!working || !empty) && (
          <Button size="icon" className="size-9 shrink-0 rounded-full" aria-label={working ? 'Send after Claude finishes' : 'Send'} disabled={sending || empty || uploading} title={uploading ? 'Waiting for uploads to finish' : undefined} onClick={submit}><ArrowUp /></Button>
        )}
      </div>
      </div>
    </div>
  )
}

const Remove = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button aria-label={label} onClick={onClick}
    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><X className="size-3" /></button>
)
