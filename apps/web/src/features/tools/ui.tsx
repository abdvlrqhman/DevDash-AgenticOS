import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Remember a tool's last input on this device, keyed per tool, so it's there when you come back. */
export function useToolState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const storageKey = `devdash.tools.${key}`
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch { return initial }
  })
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* private mode: not remembered */ }
  }, [storageKey, value])
  return [value, setValue]
}

/** Copy text to the clipboard with a tick of feedback. Disabled when there's nothing to copy. */
export function CopyButton({ value, className, label = 'Copy', size = 'sm', variant = 'outline' }: {
  value: string
  className?: string
  label?: string
  size?: 'sm' | 'xs' | 'icon-sm'
  variant?: 'outline' | 'ghost'
}) {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copy = useCallback(() => {
    if (!value) return
    void navigator.clipboard.writeText(value).then(() => {
      setDone(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(false), 1400)
    }, () => {})
  }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const iconOnly = size === 'icon-sm'
  return (
    <Button type="button" size={size} variant={variant} onClick={copy} disabled={!value}
      aria-label={label} className={cn(done && 'text-emerald-600 dark:text-emerald-400', className)}>
      {done ? <Check /> : <Copy />}{!iconOnly && (done ? 'Copied' : label)}
    </Button>
  )
}

/** A labelled control row. */
export function ToolField({ label, htmlFor, hint, children, className }: {
  label?: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {label}{hint && <span className="font-normal">{hint}</span>}
        </label>
      )}
      {children}
    </div>
  )
}

/** The read-only result of a tool: monospace by default, with a copy button floating top-right. */
export function Output({ value, label = 'Output', mono = true, className, placeholder = 'Output appears here.', children }: {
  value: string; label?: string; mono?: boolean; className?: string; placeholder?: string; children?: ReactNode
}) {
  return (
    <ToolField label={label}>
      <div className="relative">
        <pre className={cn(
          'max-h-[28rem] min-h-16 overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 pr-14 text-sm break-words whitespace-pre-wrap',
          mono && 'font-mono', !value && 'text-muted-foreground', className,
        )}>{value || placeholder}</pre>
        {value && <CopyButton value={value} size="icon-sm" className="absolute top-2 right-2 bg-background" />}
        {children}
      </div>
    </ToolField>
  )
}

/** A friendly inline error below the inputs. */
export function ToolError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{message}</span>
    </div>
  )
}

/** Two equal columns on wide screens; stacked on phones. The canonical input-left, output-right layout. */
export function TwoPane({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4 lg:grid-cols-2', className)}>{children}</div>
}

/** Run `fn`, returning its result or a readable error message — the pattern every tool uses. */
export function tryRun<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: (e as Error).message } }
}
