import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Lock, UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shared building blocks for the file-based tools (image + PDF). These tools never touch the network — everything runs
 * on the device — so the hero of each is a big, friendly drop zone and a plain reassurance that files stay local.
 */

/** The line every file tool shows: work happens here, nothing is uploaded. */
export function PrivacyNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <Lock className="size-3.5 shrink-0" />
      Runs entirely in your browser — files never leave this device.
    </p>
  )
}

/**
 * A large drag-and-drop target that also opens the file picker on click or keyboard. Accessible: the visible affordance
 * is a real button, so Enter/Space work and focus is obvious; the native input stays hidden.
 */
export function Dropzone({ accept, multiple = false, onFiles, disabled, title, hint, icon, compact }: {
  accept?: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  disabled?: boolean
  title?: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  /** A slimmer zone, for tools that already have files and just want an "add more" target. */
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const take = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return
    onFiles(Array.from(list))
  }, [onFiles])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    take(e.dataTransfer.files)
  }
  const onDragEnter = (e: DragEvent) => { e.preventDefault(); depth.current++; if (!disabled) setDragging(true) }
  const onDragLeave = (e: DragEvent) => { e.preventDefault(); depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false) }

  return (
    <div
      onDrop={onDrop} onDragOver={(e) => e.preventDefault()} onDragEnter={onDragEnter} onDragLeave={onDragLeave}
      className={cn(
        'group relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/30 px-6 text-center transition-colors',
        compact ? 'py-6' : 'py-12 sm:py-16',
        dragging && 'border-primary/60 bg-primary/5',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <div className={cn('flex items-center justify-center rounded-full bg-background text-muted-foreground shadow-xs transition-colors group-hover:text-foreground',
        compact ? 'size-9' : 'size-12', dragging && 'text-primary')}>
        {icon ?? <UploadCloud className={compact ? 'size-4.5' : 'size-6'} />}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>
          {dragging ? 'Drop to add' : (title ?? (multiple ? 'Drop files here' : 'Drop a file here'))}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled}
        className="mt-1 rounded-lg border bg-background px-3 py-1.5 text-sm font-medium shadow-xs transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        {multiple ? 'Choose files' : 'Choose a file'}
      </button>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="sr-only" tabIndex={-1} aria-hidden
        onChange={(e) => { take(e.target.files); e.target.value = '' }} />
    </div>
  )
}

/** A determinate progress bar with a caption, for batch work. */
export function ProgressBar({ value, total, label }: { value: number; total: number; label?: ReactNode }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label ?? 'Working…'}</span>
        <span className="font-mono tabular-nums">{value} / {total}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Hold object URLs for live previews and revoke them when they change or the component unmounts. */
export function useObjectUrls() {
  const urls = useRef<string[]>([])
  const make = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    urls.current.push(url)
    return url
  }, [])
  const clear = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u)
    urls.current = []
  }, [])
  useEffect(() => () => { for (const u of urls.current) URL.revokeObjectURL(u) }, [])
  return { make, clear }
}
