import { useState, useSyncExternalStore } from 'react'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'

// "Are you sure?" in the app's own dialog (a sheet on phones). The browser's confirm() shows nothing in the phone apps:
// their WebViews answer "no" without asking, so whatever it guarded never happened there.

type Ask = { title: string; description?: string; action: string; destructive?: boolean; resolve: (ok: boolean) => void }
let current: Ask | null = null
const listeners = new Set<() => void>()
const set = (a: Ask | null) => {
  current = a
  for (const l of listeners) l()
}

/** Resolves true when the person confirms, false when they cancel or close it. */
export function confirmAction(o: Omit<Ask, 'resolve'>): Promise<boolean> {
  current?.resolve(false)
  // Next tick: a menu item that asks closes its menu first, and a dialog opened in the same moment gets stuck.
  return new Promise((resolve) => setTimeout(() => set({ ...o, resolve }), 0))
}

/** Rendered once, in the app shell. */
export function ConfirmHost() {
  const ask = useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l) }, () => current)
  // Keeps its text while it closes.
  const [shown, setShown] = useState(ask)
  if (ask && ask !== shown) setShown(ask)
  const done = (ok: boolean) => {
    current?.resolve(ok)
    set(null)
  }
  return (
    <ResponsiveDialog open={!!ask} onOpenChange={(v) => { if (!v) done(false) }} title={shown?.title ?? ''} description={shown?.description}>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => done(false)}>Cancel</Button>
        <Button variant={shown?.destructive ? 'destructive' : 'default'} onClick={() => done(true)}>{shown?.action}</Button>
      </div>
    </ResponsiveDialog>
  )
}
