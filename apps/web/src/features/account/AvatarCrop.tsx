import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ImagePlus, ZoomIn, ZoomOut } from 'lucide-react'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { clampCrop, cropRect, cropSide, cropToBlob, loadPicture, MAX_ZOOM, type Crop } from '@/lib/avatar'
import { ErrorAlert } from '../auth/LoginPage'

/**
 * Pick the part of a photo that becomes your picture: drag (or the arrow keys) to move it, zoom with the slider, the
 * mouse wheel or a pinch, and see it in the round frame it will have. Only the chosen square is uploaded.
 */
export function AvatarCropDialog({ file, saving, onCancel, onPickAnother, onSave }: {
  file: File | null; saving: boolean; onCancel: () => void; onPickAnother: () => void; onSave: (picture: Blob) => void
}) {
  const [pic, setPic] = useState<{ img: HTMLImageElement; url: string } | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [crop, setCrop] = useState<Crop>({ cx: 0, cy: 0, zoom: 1 })
  const [box, setBox] = useState(0)
  const view = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)

  useEffect(() => {
    if (!file) return
    let alive = true
    let opened: string | null = null
    setPic(null)
    setError(null)
    loadPicture(file).then((p) => {
      opened = p.url
      if (!alive) return void URL.revokeObjectURL(p.url)
      setPic(p)
      setCrop({ cx: p.img.naturalWidth / 2, cy: p.img.naturalHeight / 2, zoom: 1 })
    }, (e: Error) => alive && setError(e))
    return () => { alive = false; if (opened) URL.revokeObjectURL(opened) }
  }, [file])

  // The square's size on screen follows the dialog's width.
  useEffect(() => {
    const el = view.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [pic, file])

  const w = pic?.img.naturalWidth ?? 1
  const h = pic?.img.naturalHeight ?? 1
  const update = (f: (c: Crop) => Crop) => setCrop((c) => clampCrop(f(c), w, h))
  /** Screen pixels per photo pixel at a zoom. */
  const scaleAt = (zoom: number) => box / cropSide(zoom, w, h)
  const pan = (dx: number, dy: number) => update((c) => ({ ...c, cx: c.cx - dx / scaleAt(c.zoom), cy: c.cy - dy / scaleAt(c.zoom) }))
  const zoomBy = (f: number) => update((c) => ({ ...c, zoom: c.zoom * f }))

  // The wheel zooms instead of scrolling the page (a passive React listener couldn't prevent that).
  useEffect(() => {
    const el = view.current
    if (!el) return
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)) }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const all = [...pointers.current.values()]
    if (all.length === 1) return pan(e.clientX - prev.x, e.clientY - prev.y)
    // Two fingers: pinch to zoom.
    const dist = Math.hypot(all[0]!.x - all[1]!.x, all[0]!.y - all[1]!.y)
    if (!pinch.current) pinch.current = { dist, zoom: crop.zoom }
    else update((c) => ({ ...c, zoom: pinch.current!.zoom * (dist / pinch.current!.dist) }))
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10
    const act: Record<string, () => void> = {
      ArrowLeft: () => pan(-step, 0), ArrowRight: () => pan(step, 0), ArrowUp: () => pan(0, -step), ArrowDown: () => pan(0, step), // the photo moves that way
      '+': () => zoomBy(1.1), '=': () => zoomBy(1.1), '-': () => zoomBy(1 / 1.1),
    }
    if (act[e.key]) { e.preventDefault(); act[e.key]!() }
  }
  const save = async () => {
    if (!pic) return
    try {
      onSave(await cropToBlob(pic.img, cropRect(crop, w, h)))
    } catch (e) {
      setError(e as Error)
    }
  }

  const scale = scaleAt(crop.zoom)
  return (
    <ResponsiveDialog open={!!file} onOpenChange={(v) => { if (!v && !saving) onCancel() }} title="Your picture"
      description="Drag to choose the part to show, and zoom in or out.">
      <div className="flex flex-col gap-4">
        <div ref={view} role="application" tabIndex={0} data-vaul-no-drag=""
          aria-label="Picture: drag or use the arrow keys to move it, plus and minus to zoom"
          className="relative mx-auto aspect-square w-full max-w-72 cursor-grab touch-none overflow-hidden rounded-lg bg-muted outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={keys}>
          {pic && box > 0 ? (
            <img src={pic.url} alt="" draggable={false} className="pointer-events-none absolute top-0 left-0 max-w-none"
              style={{ width: w * scale, height: h * scale, transform: `translate(${box / 2 - crop.cx * scale}px, ${box / 2 - crop.cy * scale}px)` }} />
          ) : !error && <div className="flex h-full items-center justify-center"><Spinner /></div>}
          {/* The round frame the picture is shown in; what's outside it is dimmed. */}
          <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgb(0_0_0/0.5)] ring-2 ring-white/80" />
        </div>
        <label className="mx-auto flex w-full max-w-72 items-center gap-3">
          <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input type="range" aria-label="Zoom" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} disabled={!pic}
            onChange={(e) => update((c) => ({ ...c, zoom: Number(e.target.value) }))} className="h-2 w-full cursor-pointer accent-primary" />
          <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </label>
        <ErrorAlert error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onPickAnother}><ImagePlus />Choose another</Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
            <Button type="button" disabled={!pic || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  )
}
