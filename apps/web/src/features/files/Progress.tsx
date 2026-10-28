import { cn } from '@/lib/utils'

/** A thin progress bar (0–100). */
export function Progress({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-foreground/80 transition-[width]" style={{ width: `${v}%` }} />
    </div>
  )
}
