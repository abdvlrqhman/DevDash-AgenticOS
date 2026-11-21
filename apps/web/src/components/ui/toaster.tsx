import { useMemo } from 'react'
import { Toaster as Sileo } from 'sileo'
import 'sileo/styles.css'
import { useIsMobile } from '@/hooks/use-mobile'
import { useResolvedTheme } from '@/lib/theme'

/** Sileo's toasts (lib/toast.tsx): bottom-right above Hamasa's button on a desk, bottom-centre above the tab bar on a phone. */
export function Toaster() {
  const mobile = useIsMobile()
  const theme = useResolvedTheme()
  // Sileo's built-in "dark" theme inverts the pill to bright white (#f2f2f2). Keep dark surfaces in both themes.
  const options = useMemo(() => ({ fill: theme === 'dark' ? '#242424' : '#1a1a1a' }), [theme])
  return (
    <Sileo
      position={mobile ? 'bottom-center' : 'bottom-right'}
      offset={mobile ? { bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' } : { bottom: 84, right: 20 }}
      theme="light"
      options={options}
    />
  )
}
