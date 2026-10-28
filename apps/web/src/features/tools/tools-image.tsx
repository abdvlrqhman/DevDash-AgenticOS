import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, ImageOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/app/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { bytes, cn } from '@/lib/utils'
import {
  extForFormat, formatLabel, formatUsesQuality, IMAGE_FORMATS, percentSaved, renameExt, withSuffix,
  type ImageFormat,
} from './image-lib'
import { decodeImage, processImage, renderIcon, type EncodeOptions } from './image-canvas'
import { downloadAll, downloadBlob } from '@/lib/download'
import { Dropzone, PrivacyNote, ProgressBar } from './files'
import { ToolError, ToolField, useToolState } from './ui'

const MAX_BYTES = 60 * 1024 ** 2 // 60 MB per image — past this, decoding risks crashing the tab.

type Out = { blob: Blob; url: string; w: number; h: number; name: string; note?: string }
type Item = {
  id: string
  file: File
  srcUrl: string
  srcW: number
  srcH: number
  status: 'idle' | 'running' | 'done' | 'error'
  out: Out | null
  error: string | null
}

let seq = 0

/** Manage the list of images: previews, measured dimensions, and cleaning up object URLs. */
function useImageItems() {
  const [items, setItems] = useState<Item[]>([])
  const urls = useRef<Set<string>>(new Set())

  const add = useCallback((files: File[]) => {
    const next: Item[] = []
    for (const file of files) {
      if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(file.name)) continue
      const srcUrl = URL.createObjectURL(file)
      urls.current.add(srcUrl)
      next.push({ id: `img-${++seq}`, file, srcUrl, srcW: 0, srcH: 0, status: 'idle', out: null, error: null })
    }
    if (next.length) setItems((prev) => [...prev, ...next])
  }, [])

  const measure = useCallback((id: string, w: number, h: number) => {
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, srcW: w, srcH: h } : it))
  }, [])

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.id === id)
      if (it) { URL.revokeObjectURL(it.srcUrl); urls.current.delete(it.srcUrl); if (it.out) URL.revokeObjectURL(it.out.url) }
      return prev.filter((x) => x.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u)
    urls.current.clear()
    setItems((prev) => { for (const it of prev) if (it.out) URL.revokeObjectURL(it.out.url) ; return [] })
  }, [])

  return { items, setItems, add, measure, remove, clear }
}

type Encode = (item: Item) => Promise<Out>

/** The shared image workbench: drop zone, controls, a run button, batch progress and a results list. */
function Workbench({ q, actionLabel, encode, children }: {
  q: ReturnType<typeof useImageItems>
  actionLabel: string
  encode: Encode
  children?: ReactNode
}) {
  const { items, setItems, add, measure, remove, clear } = q
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)

  const run = useCallback(async () => {
    setRunning(true)
    setDone(0)
    const current = items
    for (let i = 0; i < current.length; i++) {
      const it = current[i]!
      setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, status: 'running', error: null } : x))
      try {
        if (it.file.size > MAX_BYTES) throw new Error(`"${it.file.name}" is ${bytes(it.file.size)} — larger than the 60 MB limit.`)
        const out = await encode(it)
        setItems((prev) => prev.map((x) => {
          if (x.id !== it.id) return x
          if (x.out) URL.revokeObjectURL(x.out.url)
          return { ...x, status: 'done', out, error: null }
        }))
      } catch (e) {
        setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, status: 'error', out: null, error: (e as Error).message } : x))
      }
      setDone(i + 1)
    }
    setRunning(false)
  }, [items, setItems, encode])

  const outs = items.filter((it) => it.out).map((it) => ({ blob: it.out!.blob, name: it.out!.name }))

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Dropzone multiple accept="image/*" onFiles={add} title="Drop images here"
          hint="PNG, JPEG, WebP, GIF and more — one or many." icon={<ImageOff className="size-6" />} />
        <PrivacyNote />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {children && <div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5">{children}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={run} disabled={running}>{running ? 'Working…' : `${actionLabel} ${items.length} image${items.length === 1 ? '' : 's'}`}</Button>
        {outs.length > 1 && <Button type="button" variant="outline" onClick={() => void downloadAll(outs)} disabled={running}><Download />Download all ({outs.length})</Button>}
        <Button type="button" variant="ghost" className="ml-auto" onClick={clear} disabled={running}><Trash2 />Clear</Button>
      </div>

      {running && <ProgressBar value={done} total={items.length} label={`${actionLabel.replace(/e$/, '')}ing images…`} />}

      <ul className="flex flex-col gap-2">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
              <img src={it.out?.url ?? it.srcUrl} alt="" loading="lazy" className="max-h-full max-w-full object-contain"
                onLoad={it.srcW ? undefined : (e) => measure(it.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{it.out?.name ?? it.file.name}</div>
              {it.status === 'error' ? (
                <div className="mt-0.5 text-xs text-destructive">{it.error}</div>
              ) : (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">{it.srcW ? `${it.srcW}×${it.srcH}` : '…'} · {bytes(it.file.size)}</span>
                  {it.out && <SavedBadge before={it.file.size} after={it.out.blob.size} outDims={`${it.out.w}×${it.out.h}`} note={it.out.note} />}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {it.out && (
                <Button type="button" size="icon-sm" variant="outline" aria-label={`Download ${it.out.name}`} onClick={() => downloadBlob(it.out!.blob, it.out!.name)}><Download /></Button>
              )}
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => remove(it.id)} disabled={running}><Trash2 /></Button>
            </div>
          </li>
        ))}
      </ul>

      <Dropzone compact multiple accept="image/*" onFiles={add} title="Add more images" />
    </div>
  )
}

function SavedBadge({ before, after, outDims, note }: { before: number; after: number; outDims: string; note?: string }) {
  const pct = percentSaved(before, after)
  return (
    <>
      <span aria-hidden>→</span>
      <span className="font-mono tabular-nums text-foreground">{outDims} · {bytes(after)}</span>
      {note ? <Badge variant="outline" className="text-muted-foreground">{note}</Badge>
        : pct > 0 ? <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">{pct}% smaller</Badge>
        : pct < 0 ? <Badge variant="outline" className="text-amber-600 dark:text-amber-400">{-pct}% larger</Badge>
        : null}
    </>
  )
}

function QualityField({ format, quality, setQuality }: { format: ImageFormat; quality: number; setQuality: (n: number) => void }) {
  if (!formatUsesQuality(format)) return null
  return (
    <ToolField label={<span className="flex w-full items-center justify-between"><span>Quality</span><span className="font-mono text-foreground">{quality}%</span></span>}>
      <input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full accent-primary" />
    </ToolField>
  )
}

/* ---------------------------------------------------------- image converter -- */

export function ImageConverter() {
  const q = useImageItems()
  const [format, setFormat] = useToolState<ImageFormat>('img.conv.format', 'webp')
  const [quality, setQuality] = useToolState('img.conv.quality', 85)
  const [resize, setResize] = useToolState('img.conv.resize', false)
  const [maxW, setMaxW] = useToolState('img.conv.maxw', '1920')
  const [maxH, setMaxH] = useToolState('img.conv.maxh', '1080')

  const encode = useCallback<Encode>(async (it) => {
    const opts: EncodeOptions = {
      format, quality: quality / 100,
      maxW: resize ? Number(maxW) || null : null,
      maxH: resize ? Number(maxH) || null : null,
    }
    const { blob, width, height } = await processImage(it.file, opts)
    const url = URL.createObjectURL(blob)
    return { blob, url, w: width, h: height, name: renameExt(it.file.name, extForFormat(format)) }
  }, [format, quality, resize, maxW, maxH])

  return (
    <Workbench q={q} actionLabel="Convert" encode={encode}>
      <ToolField label="Convert to">
        <ToggleGroup type="single" variant="outline" size="sm" value={format} onValueChange={(v) => v && setFormat(v as ImageFormat)}>
          {IMAGE_FORMATS.map((f) => <ToggleGroupItem key={f} value={f}>{formatLabel(f)}</ToggleGroupItem>)}
        </ToggleGroup>
      </ToolField>
      <QualityField format={format} quality={quality} setQuality={setQuality} />
      <ToolField>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={resize} onChange={(e) => setResize(e.target.checked)} className="accent-primary" />
          Resize to fit within a box (keeps aspect ratio)
        </label>
      </ToolField>
      {resize && (
        <div className="flex flex-wrap items-end gap-3">
          <ToolField label="Max width (px)" className="w-32"><Input value={maxW} onChange={(e) => setMaxW(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="h-9 font-mono" placeholder="1920" /></ToolField>
          <ToolField label="Max height (px)" className="w-32"><Input value={maxH} onChange={(e) => setMaxH(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="h-9 font-mono" placeholder="1080" /></ToolField>
        </div>
      )}
    </Workbench>
  )
}

/* --------------------------------------------------------- image compressor -- */

export function ImageCompressor() {
  const q = useImageItems()
  const [format, setFormat] = useToolState<'jpeg' | 'webp'>('img.comp.format', 'webp')
  const [quality, setQuality] = useToolState('img.comp.quality', 70)

  const encode = useCallback<Encode>(async (it) => {
    const { blob, width, height } = await processImage(it.file, { format, quality: quality / 100 })
    const url = URL.createObjectURL(blob)
    return { blob, url, w: width, h: height, name: withSuffix(renameExt(it.file.name, extForFormat(format)), '-min') }
  }, [format, quality])

  return (
    <Workbench q={q} actionLabel="Compress" encode={encode}>
      <ToolField label="Re-encode as" hint={<span className="ml-1 font-normal">WebP usually wins</span>}>
        <ToggleGroup type="single" variant="outline" size="sm" value={format} onValueChange={(v) => v && setFormat(v as 'jpeg' | 'webp')}>
          <ToggleGroupItem value="webp">WEBP</ToggleGroupItem>
          <ToggleGroupItem value="jpeg">JPEG</ToggleGroupItem>
        </ToggleGroup>
      </ToolField>
      <QualityField format={format} quality={quality} setQuality={setQuality} />
      <p className="text-xs text-muted-foreground">Lower quality means a smaller file. Each result shows how much it saved.</p>
    </Workbench>
  )
}

/* ------------------------------------------------------------ image resizer -- */

export function ImageResizer() {
  const q = useImageItems()
  const [mode, setMode] = useToolState<'px' | 'pct'>('img.rsz.mode', 'px')
  const [width, setWidth] = useToolState('img.rsz.w', '1280')
  const [height, setHeight] = useToolState('img.rsz.h', '')
  const [pct, setPct] = useToolState('img.rsz.pct', 50)
  const [format, setFormat] = useToolState<ImageFormat>('img.rsz.format', 'png')
  const [quality, setQuality] = useToolState('img.rsz.quality', 90)

  const PRESETS: [string, string, string][] = [['1920×1080', '1920', '1080'], ['1280×720', '1280', '720'], ['800×800', '800', '800'], ['Width 640', '640', '']]

  const encode = useCallback<Encode>(async (it) => {
    const w = Number(width) || 0
    const h = Number(height) || 0
    let opts: EncodeOptions
    if (mode === 'pct') {
      // Decode once to read dimensions, then resize to an exact scaled size.
      const img = await decodeImage(it.file)
      img.bitmap.close?.()
      opts = { format, quality: quality / 100, exact: { w: Math.round(img.width * pct / 100), h: Math.round(img.height * pct / 100) } }
    } else if (w && h) {
      opts = { format, quality: quality / 100, exact: { w, h } }
    } else {
      opts = { format, quality: quality / 100, maxW: w || null, maxH: h || null } // one bound: fit within, keep aspect
    }
    const { blob, width: ow, height: oh } = await processImage(it.file, opts)
    const url = URL.createObjectURL(blob)
    return { blob, url, w: ow, h: oh, name: withSuffix(renameExt(it.file.name, extForFormat(format)), `-${ow}x${oh}`) }
  }, [mode, width, height, pct, format, quality])

  return (
    <Workbench q={q} actionLabel="Resize" encode={encode}>
      <ToolField label="Resize by">
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as 'px' | 'pct')}>
          <ToggleGroupItem value="px">Pixels</ToggleGroupItem>
          <ToggleGroupItem value="pct">Percent</ToggleGroupItem>
        </ToggleGroup>
      </ToolField>
      {mode === 'px' ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <ToolField label="Width (px)" className="w-32"><Input value={width} onChange={(e) => setWidth(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="h-9 font-mono" placeholder="1280" /></ToolField>
            <ToolField label="Height (px)" className="w-32"><Input value={height} onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="h-9 font-mono" placeholder="auto" /></ToolField>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(([label, w, h]) => (
              <button key={label} type="button" onClick={() => { setWidth(w); setHeight(h) }} className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">{label}</button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Set both for an exact size, or just one to keep the aspect ratio.</p>
        </>
      ) : (
        <ToolField label={<span className="flex w-full items-center justify-between"><span>Scale</span><span className="font-mono text-foreground">{pct}%</span></span>}>
          <input type="range" min={5} max={200} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-full accent-primary" />
        </ToolField>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <ToolField label="Save as" className="w-36">
          <NativeSelect value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)}>
            {IMAGE_FORMATS.map((f) => <option key={f} value={f}>{formatLabel(f)}</option>)}
          </NativeSelect>
        </ToolField>
        {formatUsesQuality(format) && <div className="min-w-48 flex-1"><QualityField format={format} quality={quality} setQuality={setQuality} /></div>}
      </div>
    </Workbench>
  )
}

/* ----------------------------------------------------------- favicon maker --- */

const ICON_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512]

export function FaviconMaker() {
  const [file, setFile] = useState<File | null>(null)
  const [sizes, setSizes] = useToolState<number[]>('img.favicon.sizes', [16, 32, 48, 180, 192, 512])
  const [results, setResults] = useState<{ size: number; blob: Blob; url: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : '', [file])

  const toggle = (s: number) => setSizes(sizes.includes(s) ? sizes.filter((x) => x !== s) : [...sizes, s].sort((a, b) => a - b))

  const run = useCallback(async () => {
    if (!file || sizes.length === 0) return
    setRunning(true); setError(null)
    try {
      const img = await decodeImage(file)
      const out: { size: number; blob: Blob; url: string }[] = []
      for (const s of [...sizes].sort((a, b) => a - b)) {
        const blob = await renderIcon(img, s)
        out.push({ size: s, blob, url: URL.createObjectURL(blob) })
      }
      img.bitmap.close?.()
      setResults((prev) => { for (const r of prev) URL.revokeObjectURL(r.url); return out })
    } catch (e) {
      setError((e as Error).message)
    }
    setRunning(false)
  }, [file, sizes])

  if (!file) {
    return (
      <div className="flex flex-col gap-3">
        <Dropzone accept="image/*" onFiles={(f) => f[0] && setFile(f[0])} title="Drop a square image"
          hint="A 512×512 PNG works best. It'll be scaled to each icon size." />
        <PrivacyNote />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-2.5">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
          <img src={previewUrl} alt="" className="max-h-full max-w-full object-contain" />
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</div>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setFile(null); setResults((p) => { for (const r of p) URL.revokeObjectURL(r.url); return [] }) }}><Trash2 />Change</Button>
      </div>

      <ToolField label="Sizes (px)">
        <div className="flex flex-wrap gap-2">
          {ICON_SIZES.map((s) => {
            const on = sizes.includes(s)
            return (
              <button key={s} type="button" onClick={() => toggle(s)}
                className={cn('rounded-lg border px-3 py-1.5 font-mono text-sm transition-colors', on ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted')}>{s}</button>
            )
          })}
        </div>
      </ToolField>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={run} disabled={running || sizes.length === 0}>{running ? 'Rendering…' : `Make ${sizes.length} icon${sizes.length === 1 ? '' : 's'}`}</Button>
        {results.length > 1 && <Button type="button" variant="outline" onClick={() => void downloadAll(results.map((r) => ({ blob: r.blob, name: `icon-${r.size}.png` })))}><Download />Download all</Button>}
      </div>

      <ToolError message={error} />

      {results.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {results.map((r) => (
            <li key={r.size} className="flex flex-col items-center gap-2 rounded-xl border bg-card p-3">
              <div className="flex h-16 items-center justify-center"><img src={r.url} alt={`${r.size} pixel icon`} width={Math.min(r.size, 64)} height={Math.min(r.size, 64)} style={{ imageRendering: r.size <= 48 ? 'pixelated' : 'auto' }} /></div>
              <div className="font-mono text-xs text-muted-foreground">{r.size}×{r.size} · {bytes(r.blob.size)}</div>
              <Button type="button" size="xs" variant="outline" className="w-full" onClick={() => downloadBlob(r.blob, `icon-${r.size}.png`)}><Download />PNG</Button>
            </li>
          ))}
        </ul>
      )}
      <PrivacyNote />
    </div>
  )
}
