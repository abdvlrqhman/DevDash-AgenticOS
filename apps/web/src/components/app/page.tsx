import type { CSSProperties, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Every page uses one column, so titles, actions and content start at the same place on every page (see .page-col).
 * "full" is only for canvases that want every pixel (a board or a terminal); their headers still use the column.
 */
const WIDTHS = { default: '72rem', full: '100%' } as const
export type PageWidth = keyof typeof WIDTHS
/** Style for a custom body that sits in the page column (with className="page-col"). */
export const pageCol = (width: PageWidth = 'default') => ({ '--page-max': WIDTHS[width] }) as CSSProperties
const col = pageCol

/** Top bar of every app page: optional back link, title, actions; aligned with the page's content column. */
export function PageHeader({ title, description, back, backOnSmall, actions, width = 'default', className }: {
  title: ReactNode
  description?: ReactNode
  back?: string
  /** Hide the back link on wide screens, where a list beside the page already shows where you are. */
  backOnSmall?: boolean
  actions?: ReactNode
  width?: PageWidth
  className?: string
}) {
  return (
    <header style={col(width)} className={cn(
      'page-col sticky top-0 z-20 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md',
      className,
    )}>
      {back && (
        <Button variant="ghost" size="icon-lg" asChild className={cn('-ml-2', backOnSmall && 'lg:hidden')}>
          <Link to={back} aria-label="Back"><ArrowLeft /></Link>
        </Button>
      )}
      <div className="min-w-0 flex-1 py-2">
        <h1 className="truncate text-base leading-tight font-semibold">{title}</h1>
        {description && <div className="truncate text-xs text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  )
}

/** Standard content column under a PageHeader. */
export function PageBody({ children, width = 'default', className }: { children: ReactNode; width?: PageWidth; className?: string }) {
  return <div style={col(width)} className={cn('page-col flex w-full flex-col gap-6 py-6', className)}>{children}</div>
}

/** A settings group: what it is on the left (wide screens), its controls on the right; stacked on phones. */
export function SettingsSection({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t pt-6 first:border-t-0 first:pt-0 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-12">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  )
}

/** A titled group of content inside a page. */
export function Section({ title, description, action, children, className }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {(title || action) && (
        <div className="flex min-h-7 items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}
