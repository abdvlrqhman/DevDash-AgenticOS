import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import {
  ArrowDown, ArrowUp, Download, FileText, GripVertical, Image as ImageIcon, RotateCw, Trash2, Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/app/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Spinner } from '@/components/ui/spinner'
import { bytes, cn } from '@/lib/utils'
import {
  chunkEveryN, normalizeRotation, parsePageRanges, reorder, splitByRanges, stampAnchor, withSuffix,
  type PageNumberPosition,
} from './pdf-util'
import { loadPdf, PdfPasswordError, renderPageToImage, renderThumbnail } from './pdf-render'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { processImage } from './image-canvas'
import { downloadAll, downloadBlob } from '@/lib/download'
import { Dropzone, PrivacyNote, ProgressBar } from './files'
import { ToolError, ToolField, useToolState } from './ui'

const MAX_BYTES = 200 * 1024 ** 2 // 200 MB — a friendly ceiling before the tab risks running out of memory.
const THUMB_LIMIT = 150 // Above this page count, skip the thumbnail grid and work by page number instead.

const asBlobPart = (b: Uint8Array) => new Blob([b.slice().buffer], { type: 'application/pdf' })

/* ------------------------------------------------------------ single-PDF shell */

type PdfReady = { kind: 'ready'; file: File; bytes: Uint8Array; pageCount: number }
type PdfState = { kind: 'empty' } | { kind: 'loading' } | { kind: 'error'; message: string } | PdfReady

/** Load one PDF: validate it with pdf-lib, count pages, and (optionally) spin up pdf.js for thumbnails. */
function useSinglePdf(opts?: { thumbnails?: boolean }) {
  const [state, setState] = useState<PdfState>({ kind: 'empty' })
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const thumbs = useRef<Map<number, string>>(new Map())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const load = useCallback(async (file: File) => {
    setState({ kind: 'loading' })
    try {
      if (file.size > MAX_BYTES) throw new Error(`This PDF is ${bytes(file.size)} — larger than the 200 MB limit.`)
      const bytes_ = new Uint8Array(await file.arrayBuffer())
      let pageCount = 0
      try {
        const lib = await PDFDocument.load(bytes_, { updateMetadata: false })
        pageCount = lib.getPageCount()
      } catch (e) {
        if (/encrypt/i.test(String((e as Error).message))) throw new Error('This PDF is password-protected. Remove the password with the Unlock tool first, then try this again.')
        throw new Error("Couldn't open this PDF. It may be corrupt or not a PDF at all.")
      }
      if (opts?.thumbnails && pageCount <= THUMB_LIMIT) {
        docRef.current = await loadPdf(bytes_)
      }
      setState({ kind: 'ready', file, bytes: bytes_, pageCount })
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message })
    }
  }, [opts?.thumbnails])

  const getThumb = useCallback((page: number): Promise<string> => {
    const hit = thumbs.current.get(page)
    if (hit) return Promise.resolve(hit)
    const next = queue.current.then(async () => {
      const again = thumbs.current.get(page)
      if (again) return again
      if (!docRef.current) return ''
      const url = await renderThumbnail(docRef.current, page, 200)
      thumbs.current.set(page, url)
      return url
    })
    queue.current = next.catch(() => {})
    return next
  }, [])

  const reset = useCallback(() => {
    void docRef.current?.cleanup()
    docRef.current = null
    thumbs.current.clear()
    queue.current = Promise.resolve()
    setState({ kind: 'empty' })
  }, [])

  return { state, load, reset, getThumb, hasThumbs: () => !!docRef.current }
}

function PdfEmpty({ onFiles, hint }: { onFiles: (f: File[]) => void; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Dropzone accept="application/pdf,.pdf" onFiles={onFiles} title="Drop a PDF here" hint={hint ?? 'One PDF, up to 200 MB.'} icon={<FileText className="size-6" />} />
      <PrivacyNote />
    </div>
  )
}

function Loading({ label = 'Opening PDF…' }: { label?: string }) {
  return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Spinner className="size-4" />{label}</div>
}

function PdfBar({ file, pageCount, onChange, extra }: { file: File; pageCount: number; onChange: () => void; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-2.5">
      <FileText className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{file.name}</div>
        <div className="font-mono text-xs text-muted-foreground tabular-nums">{pageCount} page{pageCount === 1 ? '' : 's'} · {bytes(file.size)}</div>
      </div>
      {extra}
      <Button type="button" size="sm" variant="ghost" onClick={onChange}><Undo2 />Change</Button>
    </div>
  )
}

/** A lazily-rendered page thumbnail. CSS rotation lets rotate/organize previews update instantly. */
function PageThumb({ getThumb, page, rotation = 0, className }: { getThumb: (p: number) => Promise<string>; page: number; rotation?: number; className?: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let alive = true
    void getThumb(page).then((u) => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [getThumb, page])
  return (
    <div className={cn('flex items-center justify-center overflow-hidden rounded-md border bg-muted/40', className)}>
      {url
        ? <img src={url} alt={`Page ${page}`} loading="lazy" className="max-h-full max-w-full object-contain transition-transform" style={{ transform: `rotate(${rotation}deg)` }} />
        : <Spinner className="size-4 text-muted-foreground" />}
    </div>
  )
}

/** Download a finished PDF result (or several) with a clear summary. */
function PdfResult({ files, onReset }: { files: { blob: Blob; name: string }[]; onReset: () => void }) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{files.length === 1 ? 'Ready to download' : `${files.length} files ready`}</span>
        {files.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => void downloadAll(files)}><Download />Download all</Button>}
      </div>
      <ul className="flex flex-col gap-1.5">
        {files.map((f, i) => (
          <li key={i} className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{bytes(f.blob.size)}</span>
            <Button type="button" size="icon-sm" variant="outline" aria-label={`Download ${f.name}`} onClick={() => downloadBlob(f.blob, f.name)}><Download /></Button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onReset} className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">Start over</button>
    </div>
  )
}

/** Shared drag-to-reorder handlers for a list of items, with keyboard-friendly up/down as the accessible fallback. */
function useReorder<T>(list: T[], setList: (next: T[]) => void) {
  const from = useRef<number | null>(null)
  const onDragStart = (i: number) => (e: DragEvent) => { from.current = i; e.dataTransfer.effectAllowed = 'move' }
  const onDragOver = (i: number) => (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const onDrop = (i: number) => (e: DragEvent) => { e.preventDefault(); if (from.current !== null && from.current !== i) setList(reorder(list, from.current, i)); from.current = null }
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j >= 0 && j < list.length) setList(reorder(list, i, j)) }
  return { onDragStart, onDragOver, onDrop, move }
}

/* ------------------------------------------------------------------- merge --- */

type NamedPdf = { id: string; file: File; bytes: Uint8Array; pageCount: number }
let pdfSeq = 0

export function MergePdf() {
  const [items, setItems] = useState<NamedPdf[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])
  const dnd = useReorder(items, setItems)

  const add = useCallback(async (files: File[]) => {
    setError(null)
    const next: NamedPdf[] = []
    for (const file of files) {
      try {
        const b = new Uint8Array(await file.arrayBuffer())
        const doc = await PDFDocument.load(b, { updateMetadata: false })
        next.push({ id: `pdf-${++pdfSeq}`, file, bytes: b, pageCount: doc.getPageCount() })
      } catch {
        setError(`Skipped "${file.name}" — it's protected or not a readable PDF.`)
      }
    }
    if (next.length) setItems((prev) => [...prev, ...next])
  }, [])

  const merge = useCallback(async () => {
    if (items.length < 2) return
    setBusy(true); setError(null)
    try {
      const out = await PDFDocument.create()
      for (const it of items) {
        const src = await PDFDocument.load(it.bytes)
        const pages = await out.copyPages(src, src.getPageIndices())
        for (const p of pages) out.addPage(p)
      }
      const data = await out.save()
      setResult([{ blob: asBlobPart(data), name: 'merged.pdf' }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [items])

  if (items.length === 0) return <PdfEmpty onFiles={add} hint="Add two or more PDFs to combine them." />

  return (
    <div className="flex flex-col gap-4">
      <ToolError message={error} />
      <ul className="flex flex-col gap-2">
        {items.map((it, i) => (
          <li key={it.id} draggable onDragStart={dnd.onDragStart(i)} onDragOver={dnd.onDragOver(i)} onDrop={dnd.onDrop(i)}
            className="flex items-center gap-2 rounded-xl border bg-card p-2.5">
            <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
            <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{it.file.name}</div>
              <div className="font-mono text-xs text-muted-foreground tabular-nums">{it.pageCount} page{it.pageCount === 1 ? '' : 's'} · {bytes(it.file.size)}</div>
            </div>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => dnd.move(i, -1)}><ArrowUp /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === items.length - 1} onClick={() => dnd.move(i, 1)}><ArrowDown /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))}><Trash2 /></Button>
          </li>
        ))}
      </ul>
      <Dropzone compact accept="application/pdf,.pdf" multiple onFiles={add} title="Add more PDFs" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={merge} disabled={busy || items.length < 2}>{busy ? 'Merging…' : `Merge ${items.length} PDFs`}</Button>
        <Button type="button" variant="ghost" className="ml-auto" onClick={() => { setItems([]); setResult([]) }}><Trash2 />Clear</Button>
      </div>
      <PdfResult files={result} onReset={() => setResult([])} />
      <PrivacyNote />
    </div>
  )
}

/* ------------------------------------------------------------------- split --- */

export function SplitPdf() {
  const pdf = useSinglePdf()
  const [mode, setMode] = useToolState<'ranges' | 'everyN'>('pdf.split.mode', 'ranges')
  const [ranges, setRanges] = useToolState('pdf.split.ranges', '1-3, 4-6')
  const [n, setN] = useToolState('pdf.split.n', 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])

  const run = useCallback(async () => {
    if (pdf.state.kind !== 'ready') return
    setBusy(true); setError(null); setResult([])
    try {
      const { bytes: src, pageCount, file } = pdf.state
      const groups = mode === 'everyN' ? chunkEveryN(pageCount, n) : splitByRanges(ranges, pageCount)
      const srcDoc = await PDFDocument.load(src)
      const files: { blob: Blob; name: string }[] = []
      for (let g = 0; g < groups.length; g++) {
        const out = await PDFDocument.create()
        const pages = await out.copyPages(srcDoc, groups[g]!)
        for (const p of pages) out.addPage(p)
        files.push({ blob: asBlobPart(await out.save()), name: withSuffix(file.name, `-part-${g + 1}`) })
      }
      setResult(files)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [pdf.state, mode, ranges, n])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={pdf.state.file} pageCount={pdf.state.pageCount} onChange={pdf.reset} />
      <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as 'ranges' | 'everyN')} className="w-fit">
        <ToggleGroupItem value="ranges">By ranges</ToggleGroupItem>
        <ToggleGroupItem value="everyN">Every N pages</ToggleGroupItem>
      </ToggleGroup>
      {mode === 'ranges' ? (
        <ToolField label="Ranges" hint={<span className="ml-auto">one file per range</span>}>
          <Input value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4-6, 7" className="h-9 font-mono" />
        </ToolField>
      ) : (
        <ToolField label="Pages per file" className="w-40">
          <Input type="number" min={1} max={pdf.state.pageCount} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value)))} className="h-9" />
        </ToolField>
      )}
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Splitting…' : 'Split PDF'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* ------------------------------------------------------------------ extract -- */

export function ExtractPages() {
  const pdf = useSinglePdf({ thumbnails: true })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [ranges, setRanges] = useToolState('pdf.extract.ranges', '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])
  const ready = pdf.state.kind === 'ready' ? pdf.state : null
  const showThumbs = !!ready && ready.pageCount <= THUMB_LIMIT

  const toggle = (page: number) => setSelected((prev) => { const next = new Set(prev); next.has(page) ? next.delete(page) : next.add(page); return next })

  const run = useCallback(async () => {
    if (!ready) return
    setBusy(true); setError(null); setResult([])
    try {
      const indices = showThumbs
        ? [...selected].sort((a, b) => a - b)
        : parsePageRanges(ranges, ready.pageCount)
      if (indices.length === 0) throw new Error('Pick at least one page to extract.')
      const srcDoc = await PDFDocument.load(ready.bytes)
      const out = await PDFDocument.create()
      const pages = await out.copyPages(srcDoc, indices)
      for (const p of pages) out.addPage(p)
      setResult([{ blob: asBlobPart(await out.save()), name: withSuffix(ready.file.name, '-extract') }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [ready, showThumbs, selected, ranges])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} hint="Pick pages to pull into a new PDF." />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={ready!.file} pageCount={ready!.pageCount} onChange={pdf.reset}
        extra={showThumbs ? <Badge variant="outline">{selected.size} selected</Badge> : undefined} />
      {showThumbs ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="xs" variant="outline" onClick={() => setSelected(new Set(Array.from({ length: ready!.pageCount }, (_, i) => i)))}>Select all</Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {Array.from({ length: ready!.pageCount }, (_, i) => {
              const on = selected.has(i)
              return (
                <li key={i}>
                  <button type="button" onClick={() => toggle(i)} aria-pressed={on}
                    className={cn('group relative w-full rounded-lg border p-1 transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none', on ? 'border-primary bg-primary/5' : 'hover:bg-muted')}>
                    <PageThumb getThumb={pdf.getThumb} page={i + 1} className="aspect-[3/4] w-full" />
                    <span className={cn('mt-1 block text-center font-mono text-xs tabular-nums', on ? 'text-foreground' : 'text-muted-foreground')}>{i + 1}</span>
                    {on && <span className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">✓</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <ToolField label="Pages" hint={<span className="ml-auto">this PDF is large, so pick by number</span>}>
          <Input value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 5, 8" className="h-9 font-mono" />
        </ToolField>
      )}
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Extracting…' : 'Extract pages'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* ------------------------------------------------------------------- rotate -- */

export function RotatePdf() {
  const pdf = useSinglePdf({ thumbnails: true })
  const [rot, setRot] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])
  const ready = pdf.state.kind === 'ready' ? pdf.state : null
  const showThumbs = !!ready && ready.pageCount <= THUMB_LIMIT

  const bumpAll = (delta: number) => { if (!ready) return; setRot((prev) => { const next = { ...prev }; for (let i = 0; i < ready.pageCount; i++) next[i] = normalizeRotation((next[i] ?? 0) + delta); return next }) }
  const bumpOne = (i: number, delta: number) => setRot((prev) => ({ ...prev, [i]: normalizeRotation((prev[i] ?? 0) + delta) }))

  const run = useCallback(async () => {
    if (!ready) return
    setBusy(true); setError(null); setResult([])
    try {
      const doc = await PDFDocument.load(ready.bytes)
      doc.getPages().forEach((page, i) => {
        const delta = rot[i] ?? 0
        if (delta) page.setRotation(degrees(normalizeRotation(page.getRotation().angle + delta)))
      })
      setResult([{ blob: asBlobPart(await doc.save()), name: withSuffix(ready.file.name, '-rotated') }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [ready, rot])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} hint="Turn pages 90° at a time." />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={ready!.file} pageCount={ready!.pageCount} onChange={pdf.reset} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => bumpAll(-90)}><RotateCw className="-scale-x-100" />All left</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => bumpAll(90)}><RotateCw />All right</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setRot({})}>Reset</Button>
      </div>
      {showThumbs ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {Array.from({ length: ready!.pageCount }, (_, i) => (
            <li key={i} className="flex flex-col items-center gap-1 rounded-lg border p-1.5">
              <PageThumb getThumb={pdf.getThumb} page={i + 1} rotation={rot[i] ?? 0} className="aspect-[3/4] w-full" />
              <div className="flex w-full items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Rotate page ${i + 1}`} onClick={() => bumpOne(i, 90)}><RotateCw /></Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">This PDF has {ready!.pageCount} pages, so per-page previews are hidden. Use the buttons above to rotate every page.</p>
      )}
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Rotating…' : 'Apply rotation'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* ----------------------------------------------------------------- organize -- */

export function OrganizePdf() {
  const pdf = useSinglePdf({ thumbnails: true })
  const [order, setOrder] = useState<number[]>([])
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])
  const ready = pdf.state.kind === 'ready' ? pdf.state : null
  const dnd = useReorder(order, setOrder)

  useEffect(() => {
    if (ready) { setOrder(Array.from({ length: ready.pageCount }, (_, i) => i)); setDeleted(new Set()); setResult([]) }
  }, [ready?.file])

  const kept = order.filter((p) => !deleted.has(p))

  const run = useCallback(async () => {
    if (!ready) return
    setBusy(true); setError(null); setResult([])
    try {
      if (kept.length === 0) throw new Error('Keep at least one page.')
      const srcDoc = await PDFDocument.load(ready.bytes)
      const out = await PDFDocument.create()
      const pages = await out.copyPages(srcDoc, kept)
      for (const p of pages) out.addPage(p)
      setResult([{ blob: asBlobPart(await out.save()), name: withSuffix(ready.file.name, '-organized') }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [ready, kept])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} hint="Reorder or delete pages, then save." />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>
  if (ready!.pageCount > THUMB_LIMIT) {
    return (
      <div className="flex flex-col gap-4">
        <PdfBar file={ready!.file} pageCount={ready!.pageCount} onChange={pdf.reset} />
        <ToolError message={`This PDF has ${ready!.pageCount} pages — too many for drag-to-reorder. Use Split or Extract to work with it by page number.`} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={ready!.file} pageCount={ready!.pageCount} onChange={pdf.reset} extra={<Badge variant="outline">{kept.length} kept</Badge>} />
      <p className="text-xs text-muted-foreground">Drag to reorder (or use the arrows). The bin removes a page; tap again to restore it.</p>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {order.map((page, i) => {
          const gone = deleted.has(page)
          return (
            <li key={page} draggable={!gone} onDragStart={dnd.onDragStart(i)} onDragOver={dnd.onDragOver(i)} onDrop={dnd.onDrop(i)}
              className={cn('flex flex-col items-center gap-1 rounded-lg border p-1.5 transition-opacity', gone ? 'opacity-40' : 'cursor-grab')}>
              <PageThumb getThumb={pdf.getThumb} page={page + 1} className={cn('aspect-[3/4] w-full', gone && 'grayscale')} />
              <div className="flex w-full items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{page + 1}</span>
                <div className="flex items-center">
                  <Button type="button" size="icon-xs" variant="ghost" aria-label="Move left" disabled={i === 0} onClick={() => dnd.move(i, -1)}><ArrowUp className="-rotate-90" /></Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label="Move right" disabled={i === order.length - 1} onClick={() => dnd.move(i, 1)}><ArrowDown className="-rotate-90" /></Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={gone ? 'Restore page' : 'Delete page'} onClick={() => setDeleted((prev) => { const next = new Set(prev); next.has(page) ? next.delete(page) : next.add(page); return next })}>
                    {gone ? <Undo2 /> : <Trash2 />}
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Saving…' : 'Save organized PDF'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* --------------------------------------------------------------- jpg -> pdf -- */

type ImgItem = { id: string; file: File; url: string }

export function JpgToPdf() {
  const [items, setItems] = useState<ImgItem[]>([])
  const [size, setSize] = useToolState<'auto' | 'a4' | 'letter'>('pdf.jpg2pdf.size', 'auto')
  const [orient, setOrient] = useToolState<'portrait' | 'landscape'>('pdf.jpg2pdf.orient', 'portrait')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])
  const dnd = useReorder(items, setItems)

  const add = useCallback((files: File[]) => {
    const next = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name))
      .map((file) => ({ id: `jpg-${++pdfSeq}`, file, url: URL.createObjectURL(file) }))
    if (next.length) setItems((prev) => [...prev, ...next])
  }, [])
  const remove = (id: string) => setItems((prev) => { const it = prev.find((x) => x.id === id); if (it) URL.revokeObjectURL(it.url); return prev.filter((x) => x.id !== id) })

  const run = useCallback(async () => {
    if (items.length === 0) return
    setBusy(true); setError(null); setResult([])
    try {
      const doc = await PDFDocument.create()
      const PAGE: [number, number] | null = size === 'a4' ? [595.28, 841.89] : size === 'letter' ? [612, 792] : null
      for (const it of items) {
        const raw = new Uint8Array(await it.file.arrayBuffer())
        const isJpg = it.file.type === 'image/jpeg' || /\.jpe?g$/i.test(it.file.name)
        const isPng = it.file.type === 'image/png' || /\.png$/i.test(it.file.name)
        // pdf-lib embeds only JPEG and PNG, so convert anything else (webp, gif…) to PNG on a canvas first.
        const embedded = isJpg ? await doc.embedJpg(raw)
          : isPng ? await doc.embedPng(raw)
          : await doc.embedPng(new Uint8Array(await (await processImage(it.file, { format: 'png', quality: 1 })).blob.arrayBuffer()))
        let pw: number, ph: number
        if (PAGE) { const [a, b] = PAGE; [pw, ph] = orient === 'landscape' ? [b, a] : [a, b] }
        else { pw = embedded.width; ph = embedded.height }
        const page = doc.addPage([pw, ph])
        if (PAGE) {
          const m = 24
          const scale = Math.min((pw - m * 2) / embedded.width, (ph - m * 2) / embedded.height, 1)
          const w = embedded.width * scale, h = embedded.height * scale
          page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
        } else {
          page.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph })
        }
      }
      setResult([{ blob: asBlobPart(await doc.save()), name: 'images.pdf' }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [items, size, orient])

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Dropzone accept="image/*" multiple onFiles={add} title="Drop images here" hint="JPG, PNG, WebP and more — each becomes a page." icon={<ImageIcon className="size-6" />} />
        <PrivacyNote />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3.5">
        <ToolField label="Page size" className="w-36"><NativeSelect value={size} onChange={(e) => setSize(e.target.value as typeof size)}><option value="auto">Fit image</option><option value="a4">A4</option><option value="letter">Letter</option></NativeSelect></ToolField>
        {size !== 'auto' && <ToolField label="Orientation" className="w-36"><NativeSelect value={orient} onChange={(e) => setOrient(e.target.value as typeof orient)}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></NativeSelect></ToolField>}
      </div>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {items.map((it, i) => (
          <li key={it.id} draggable onDragStart={dnd.onDragStart(i)} onDragOver={dnd.onDragOver(i)} onDrop={dnd.onDrop(i)}
            className="group relative flex cursor-grab flex-col items-center gap-1 rounded-lg border p-1.5">
            <div className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40"><img src={it.url} alt="" className="max-h-full max-w-full object-contain" /></div>
            <div className="flex w-full items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove" onClick={() => remove(it.id)}><Trash2 /></Button>
            </div>
          </li>
        ))}
      </ul>
      <Dropzone compact accept="image/*" multiple onFiles={add} title="Add more images" />
      <ToolError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={run} disabled={busy}>{busy ? 'Building…' : `Make PDF from ${items.length} image${items.length === 1 ? '' : 's'}`}</Button>
        <Button type="button" variant="ghost" className="ml-auto" onClick={() => { for (const it of items) URL.revokeObjectURL(it.url); setItems([]); setResult([]) }}><Trash2 />Clear</Button>
      </div>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* --------------------------------------------------------------- pdf -> jpg -- */

export function PdfToJpg() {
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useToolState<'image/jpeg' | 'image/png'>('pdf.pdf2jpg.format', 'image/jpeg')
  const [dpi, setDpi] = useToolState('pdf.pdf2jpg.dpi', 150)
  const [quality, setQuality] = useToolState('pdf.pdf2jpg.quality', 85)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string; url: string }[]>([])
  const [password, setPassword] = useState('')
  const [needPw, setNeedPw] = useState(false)

  const run = useCallback(async (pw?: string) => {
    if (!file) return
    setBusy(true); setError(null); setNeedPw(false)
    for (const r of result) URL.revokeObjectURL(r.url)
    setResult([]); setDone(0)
    try {
      const bytes_ = new Uint8Array(await file.arrayBuffer())
      const doc = await loadPdf(bytes_, pw)
      setTotal(doc.numPages)
      const ext = format === 'image/png' ? 'png' : 'jpg'
      const base = file.name.replace(/\.pdf$/i, '')
      const out: { blob: Blob; name: string; url: string }[] = []
      for (let p = 1; p <= doc.numPages; p++) {
        const { blob } = await renderPageToImage(doc, p, dpi, format, quality / 100)
        out.push({ blob, name: `${base}-${String(p).padStart(3, '0')}.${ext}`, url: URL.createObjectURL(blob) })
        setDone(p)
      }
      void doc.cleanup()
      setResult(out)
    } catch (e) {
      if (e instanceof PdfPasswordError) { setNeedPw(true); setError(e.wrong ? e.message : null) }
      else setError((e as Error).message)
    }
    setBusy(false)
  }, [file, format, dpi, quality, result])

  if (!file) return <PdfEmpty onFiles={(f) => f[0] && setFile(f[0])} hint="Render each page to a JPG or PNG." />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</div>
        <Button type="button" size="sm" variant="ghost" onClick={() => { for (const r of result) URL.revokeObjectURL(r.url); setFile(null); setResult([]); setNeedPw(false) }}><Undo2 />Change</Button>
      </div>
      {needPw && (
        <ToolField label="Password" hint={<span className="ml-auto">this PDF is protected</span>}>
          <div className="flex gap-2">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" placeholder="Enter password" />
            <Button type="button" onClick={() => run(password)} disabled={!password}>Unlock & render</Button>
          </div>
        </ToolField>
      )}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3.5">
        <ToolField label="Format" className="w-32"><NativeSelect value={format} onChange={(e) => setFormat(e.target.value as typeof format)}><option value="image/jpeg">JPG</option><option value="image/png">PNG</option></NativeSelect></ToolField>
        <ToolField label="Resolution" className="w-36"><NativeSelect value={String(dpi)} onChange={(e) => setDpi(Number(e.target.value))}><option value="96">96 DPI (screen)</option><option value="150">150 DPI</option><option value="300">300 DPI (print)</option></NativeSelect></ToolField>
        {format === 'image/jpeg' && (
          <ToolField label={<span className="flex items-center gap-2">Quality <span className="font-mono text-foreground">{quality}%</span></span>} className="min-w-48 flex-1">
            <input type="range" min={40} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full accent-primary" />
          </ToolField>
        )}
      </div>
      {!needPw && <Button type="button" className="w-fit" onClick={() => run()} disabled={busy}>{busy ? 'Rendering…' : 'Convert to images'}</Button>}
      {busy && <ProgressBar value={done} total={total} label="Rendering pages…" />}
      <ToolError message={error} />
      {result.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{result.length} image{result.length === 1 ? '' : 's'}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void downloadAll(result)}><Download />Download all</Button>
          </div>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {result.map((r, i) => (
              <li key={i} className="flex flex-col items-center gap-1 rounded-lg border p-1.5">
                <div className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40"><img src={r.url} alt={r.name} loading="lazy" className="max-h-full max-w-full object-contain" /></div>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1} · {bytes(r.blob.size)}</span>
                <Button type="button" size="xs" variant="outline" className="w-full" onClick={() => downloadBlob(r.blob, r.name)}><Download /></Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PrivacyNote />
    </div>
  )
}

/* -------------------------------------------------------------- page numbers - */

const POSITIONS: { value: PageNumberPosition; label: string }[] = [
  { value: 'bottom-center', label: 'Bottom centre' }, { value: 'bottom-right', label: 'Bottom right' }, { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-center', label: 'Top centre' }, { value: 'top-right', label: 'Top right' }, { value: 'top-left', label: 'Top left' },
]

export function PageNumbers() {
  const pdf = useSinglePdf()
  const [position, setPosition] = useToolState<PageNumberPosition>('pdf.pagenum.pos', 'bottom-center')
  const [fmt, setFmt] = useToolState<'n' | 'n-of-total' | 'page-n'>('pdf.pagenum.fmt', 'n')
  const [start, setStart] = useToolState('pdf.pagenum.start', 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])

  const run = useCallback(async () => {
    if (pdf.state.kind !== 'ready') return
    setBusy(true); setError(null); setResult([])
    try {
      const { bytes: src, file } = pdf.state
      const doc = await PDFDocument.load(src)
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const pages = doc.getPages()
      const size = 11
      pages.forEach((page, i) => {
        const num = start + i
        const label = fmt === 'n-of-total' ? `${num} / ${start + pages.length - 1}` : fmt === 'page-n' ? `Page ${num}` : String(num)
        const { width, height } = page.getSize()
        const a = stampAnchor(position, width, height, 28)
        const textWidth = font.widthOfTextAtSize(label, size)
        const x = a.align === 'center' ? a.x - textWidth / 2 : a.align === 'right' ? a.x - textWidth : a.x
        page.drawText(label, { x, y: a.top ? a.y - size : a.y, size, font, color: rgb(0.3, 0.3, 0.3) })
      })
      setResult([{ blob: asBlobPart(await doc.save()), name: withSuffix(file.name, '-numbered') }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [pdf.state, position, fmt, start])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} hint="Stamp page numbers onto every page." />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={pdf.state.file} pageCount={pdf.state.pageCount} onChange={pdf.reset} />
      <div className="flex flex-wrap items-end gap-3">
        <ToolField label="Position" className="w-44"><NativeSelect value={position} onChange={(e) => setPosition(e.target.value as PageNumberPosition)}>{POSITIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</NativeSelect></ToolField>
        <ToolField label="Style" className="w-40"><NativeSelect value={fmt} onChange={(e) => setFmt(e.target.value as typeof fmt)}><option value="n">1, 2, 3</option><option value="n-of-total">1 / N</option><option value="page-n">Page 1</option></NativeSelect></ToolField>
        <ToolField label="Start at" className="w-28"><Input type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value))} className="h-9" /></ToolField>
      </div>
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Stamping…' : 'Add page numbers'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* ---------------------------------------------------------------- watermark -- */

export function WatermarkPdf() {
  const pdf = useSinglePdf()
  const [text, setText] = useToolState('pdf.wm.text', 'CONFIDENTIAL')
  const [opacity, setOpacity] = useToolState('pdf.wm.opacity', 15)
  const [angle, setAngle] = useToolState('pdf.wm.angle', 45)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string }[]>([])

  const run = useCallback(async () => {
    if (pdf.state.kind !== 'ready') return
    if (!text.trim()) { setError('Enter the watermark text.'); return }
    setBusy(true); setError(null); setResult([])
    try {
      const { bytes: src, file } = pdf.state
      const doc = await PDFDocument.load(src)
      const font = await doc.embedFont(StandardFonts.HelveticaBold)
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize()
        const size = Math.max(24, Math.min(width, height) / 8)
        const tw = font.widthOfTextAtSize(text, size)
        page.drawText(text, {
          x: width / 2 - (tw / 2) * Math.cos((angle * Math.PI) / 180),
          y: height / 2 - (tw / 2) * Math.sin((angle * Math.PI) / 180),
          size, font, color: rgb(0.5, 0.5, 0.5), opacity: opacity / 100, rotate: degrees(angle),
        })
      }
      setResult([{ blob: asBlobPart(await doc.save()), name: withSuffix(file.name, '-watermarked') }])
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [pdf.state, text, opacity, angle])

  if (pdf.state.kind === 'empty') return <PdfEmpty onFiles={(f) => f[0] && pdf.load(f[0])} hint="Stamp text diagonally across every page." />
  if (pdf.state.kind === 'loading') return <Loading />
  if (pdf.state.kind === 'error') return <div className="flex flex-col gap-3"><ToolError message={pdf.state.message} /><Button variant="outline" className="w-fit" onClick={pdf.reset}>Try another PDF</Button></div>

  return (
    <div className="flex flex-col gap-4">
      <PdfBar file={pdf.state.file} pageCount={pdf.state.pageCount} onChange={pdf.reset} />
      <ToolField label="Watermark text"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="CONFIDENTIAL" className="h-9" /></ToolField>
      <div className="flex flex-wrap items-end gap-6">
        <ToolField label={<span className="flex items-center gap-2">Opacity <span className="font-mono text-foreground">{opacity}%</span></span>} className="min-w-48 flex-1">
          <input type="range" min={5} max={60} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full accent-primary" />
        </ToolField>
        <ToolField label={<span className="flex items-center gap-2">Angle <span className="font-mono text-foreground">{angle}°</span></span>} className="min-w-48 flex-1">
          <input type="range" min={0} max={90} value={angle} onChange={(e) => setAngle(Number(e.target.value))} className="w-full accent-primary" />
        </ToolField>
      </div>
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Stamping…' : 'Add watermark'}</Button>
      <PdfResult files={result} onReset={() => setResult([])} />
    </div>
  )
}

/* ----------------------------------------------------------------- compress -- */

export function CompressPdf() {
  const [file, setFile] = useState<File | null>(null)
  const [dpi, setDpi] = useToolState('pdf.compress.dpi', 120)
  const [quality, setQuality] = useToolState('pdf.compress.quality', 65)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null)
  const [grew, setGrew] = useState(false)

  const run = useCallback(async () => {
    if (!file) return
    setBusy(true); setError(null); setResult(null); setGrew(false); setDone(0)
    try {
      const bytes_ = new Uint8Array(await file.arrayBuffer())
      const doc = await loadPdf(bytes_)
      setTotal(doc.numPages)
      const out = await PDFDocument.create()
      for (let p = 1; p <= doc.numPages; p++) {
        const { blob, width, height } = await renderPageToImage(doc, p, dpi, 'image/jpeg', quality / 100)
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()))
        const page = out.addPage([width * 72 / dpi, height * 72 / dpi])
        page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
        setDone(p)
      }
      void doc.cleanup()
      const data = await out.save()
      const name = withSuffix(file.name, '-compressed')
      setResult({ blob: asBlobPart(data), name })
      setGrew(data.byteLength >= file.size)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }, [file, dpi, quality])

  if (!file) return <PdfEmpty onFiles={(f) => f[0] && setFile(f[0])} hint="Shrink a heavy, image-rich PDF by re-rendering it." />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{file.name}</div><div className="font-mono text-xs text-muted-foreground tabular-nums">{bytes(file.size)}</div></div>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setFile(null); setResult(null) }}><Undo2 />Change</Button>
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
        <RotateCw className="mt-0.5 size-4 shrink-0" />
        <span>Lossy — every page is re-rendered to an image, so text stops being selectable. Best for scanned or image-heavy PDFs. If it can't beat the original, it'll tell you.</span>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3.5">
        <ToolField label="Resolution" className="w-36"><NativeSelect value={String(dpi)} onChange={(e) => setDpi(Number(e.target.value))}><option value="72">72 DPI (small)</option><option value="120">120 DPI</option><option value="150">150 DPI</option><option value="200">200 DPI (sharp)</option></NativeSelect></ToolField>
        <ToolField label={<span className="flex items-center gap-2">Quality <span className="font-mono text-foreground">{quality}%</span></span>} className="min-w-48 flex-1">
          <input type="range" min={30} max={90} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full accent-primary" />
        </ToolField>
      </div>
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Compressing…' : 'Compress PDF'}</Button>
      {busy && <ProgressBar value={done} total={total} label="Re-rendering pages…" />}
      <ToolError message={error} />
      {result && (
        <div className={cn('flex flex-col gap-2 rounded-xl border p-3', grew ? 'border-amber-500/30 bg-amber-500/5' : 'border-emerald-500/30 bg-emerald-500/5')}>
          <span className={cn('text-sm font-medium', grew ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')}>
            {grew ? 'No smaller than the original' : `Compressed — ${bytes(file.size)} → ${bytes(result.blob.size)}`}
          </span>
          <p className="text-xs text-muted-foreground">{grew
            ? `This PDF was already efficient (${bytes(result.blob.size)}). Re-rendering didn't help — keep the original.`
            : `Saved ${Math.max(0, Math.round((1 - result.blob.size / file.size) * 100))}% at ${dpi} DPI.`}</p>
          <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => downloadBlob(result.blob, result.name)}><Download />Download compressed PDF</Button>
        </div>
      )}
      <PrivacyNote />
    </div>
  )
}

/* ------------------------------------------------------------------- unlock -- */

export function UnlockPdf() {
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null)

  const run = useCallback(async () => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try {
      const bytes_ = new Uint8Array(await file.arrayBuffer())
      const doc = await loadPdf(bytes_, password || undefined)
      const data = await doc.saveDocument() // pdf.js rewrites the file without its encryption
      void doc.cleanup()
      setResult({ blob: asBlobPart(data), name: withSuffix(file.name, '-unlocked') })
    } catch (e) {
      setError(e instanceof PdfPasswordError ? e.message : (e as Error).message)
    }
    setBusy(false)
  }, [file, password])

  if (!file) {
    return (
      <div className="flex flex-col gap-3">
        <Dropzone accept="application/pdf,.pdf" onFiles={(f) => f[0] && setFile(f[0])} title="Drop a protected PDF" hint="Removes a password you know, keeping text and layout." icon={<FileText className="size-6" />} />
        <PrivacyNote />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</div>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setFile(null); setResult(null); setPassword('') }}><Undo2 />Change</Button>
      </div>
      <ToolField label="Password" hint={<span className="ml-auto">leave blank for permission-only locks</span>}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="The PDF's open password" className="h-9" />
      </ToolField>
      <p className="text-xs text-muted-foreground">Only works for a password you already know — this doesn't guess or crack anything.</p>
      <ToolError message={error} />
      <Button type="button" className="w-fit" onClick={run} disabled={busy}>{busy ? 'Unlocking…' : 'Remove password'}</Button>
      {result && (
        <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Password removed</span>
          <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => downloadBlob(result.blob, result.name)}><Download />Download unlocked PDF</Button>
        </div>
      )}
      <PrivacyNote />
    </div>
  )
}
