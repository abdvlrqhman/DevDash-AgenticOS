import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'

type GSAP = typeof import('gsap')['gsap']

/**
 * GSAP loads right after the app, off the first-load path (it is about 27 KB). Until it has arrived, and for anyone
 * who asked for reduced motion, things simply appear, finished: motion here is never what makes content visible.
 */
let gsap: GSAP | null = null
void import('gsap').then((m) => { gsap = m.gsap })

export const motionOk = () => gsap !== null && matchMedia('(prefers-reduced-motion: no-preference)').matches

/**
 * Runs `fn` inside a gsap.context scoped to `scope` (selectors only match inside it) and reverts it when `deps`
 * change or the component unmounts, so no tween outlives what it animates.
 */
export function useMotion(fn: (g: GSAP) => void, deps: DependencyList, scope?: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!motionOk()) return
    const ctx = gsap!.context(() => fn(gsap!), scope?.current ?? undefined)
    return () => ctx.revert()
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A line landing in a list: the same motion for the handover on Home and anything that arrives live. Always fromTo
 * with explicit ends, so two tweens meeting on one row can't leave it half faded; inline styles go when done.
 */
export const landFrom = { opacity: 0, y: -6 } as const
export const landTo = { opacity: 1, y: 0, duration: 0.32, ease: 'power3.out', overwrite: 'auto', clearProps: 'opacity,transform' } as const

/**
 * Rows that appear after the list first loaded (a session that starts waiting, a new activity line) land the way the
 * handover's lines do. Each row carries data-key; `keys` is undefined until the data has loaded, so the first load
 * never counts as an arrival.
 */
export function useArrivals(scope: RefObject<HTMLElement | null>, keys: string[] | undefined) {
  const seen = useRef<Set<string> | null>(null)
  useLayoutEffect(() => {
    if (!keys) return
    const before = seen.current
    seen.current = new Set(keys)
    const rows = (before ? keys.filter((k) => !before.has(k)) : [])
      .map((k) => scope.current?.querySelector(`[data-key="${CSS.escape(k)}"]`)).filter(Boolean)
    if (rows.length && motionOk()) gsap!.fromTo(rows, landFrom, landTo)
  }, [keys?.join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps
}
