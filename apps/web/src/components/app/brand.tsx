import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Square-Kufic د built from grid cells with a brass cursor block. Same drawing as public/icon.svg. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={cn('shrink-0', className)}>
      <rect width="64" height="64" rx="15" fill="var(--logo-bg)" />
      <g fill="#F5F5F5">
        <rect x="31" y="7.5" width="11" height="11" rx="1.6" /><rect x="44" y="7.5" width="11" height="11" rx="1.6" />
        <rect x="44" y="20.5" width="11" height="11" rx="1.6" /><rect x="44" y="33.5" width="11" height="11" rx="1.6" />
        <rect x="5" y="46.5" width="11" height="11" rx="1.6" /><rect x="18" y="46.5" width="11" height="11" rx="1.6" />
        <rect x="31" y="46.5" width="11" height="11" rx="1.6" /><rect x="44" y="46.5" width="11" height="11" rx="1.6" />
      </g>
      <rect x="18" y="20.5" width="11" height="24" rx="1.6" fill="#E3B45A" />
    </svg>
  )
}

export type LightState = 'live' | 'waiting' | 'idle' | 'error'

/** Status as a grid cell, like the logo: running (green), waiting for you (brass, blinks), idle (outline), error. */
export function StatusLight({ state, label, className }: { state: LightState; label?: string; className?: string }) {
  // When a light changes while you watch (a service comes up, a session fails) it catches like an LED; see .led-on.
  const prev = useRef(state)
  const [changes, setChanges] = useState(0)
  useEffect(() => {
    if (prev.current !== state) { prev.current = state; setChanges((n) => n + 1) }
  }, [state])
  return (
    <span
      key={changes}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-[3px]',
        state === 'live' && 'bg-live',
        state === 'waiting' && 'needs-you bg-attention',
        state === 'idle' && 'bg-muted-foreground/55',
        state === 'error' && 'bg-destructive',
        changes > 0 && (state === 'live' || state === 'error') && 'led-on',
        className,
      )}
    />
  )
}

export function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}
