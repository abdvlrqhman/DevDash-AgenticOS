import { ThinkingOrb } from 'thinking-orbs'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

export type OrbState = 'working' | 'searching' | 'solving' | 'listening' | 'connecting' | 'weaving' | 'composing' | 'breathing' | 'shaping'

/**
 * Claude's presence: a dotted orb (thinking-orbs) that moves while Claude works. Grey ink like the rest of the app, in its
 * theme (given, so no orb watches the page for it); one still frame for reduced motion, paused off screen.
 */
export function Orb({ state = 'working', size = 20, label, className }: { state?: OrbState; size?: 20 | 64; label?: string; className?: string }) {
  const theme = useTheme()
  return (
    <span className={cn('inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      <ThinkingOrb state={state} size={size} theme={theme === 'dark' ? 'dark' : 'light'} aria-label={label} />
    </span>
  )
}
