import { Toaster as Sileo } from 'sileo'
import 'sileo/styles.css'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTheme } from '@/lib/theme'

/** Sileo's toasts (lib/toast.tsx): bottom-right on a desk, bottom-centre above the tab bar on a phone, in the app's theme. */
export function Toaster() {
  const mobile = useIsMobile()
  const theme = useTheme()
  return (
    <Sileo
      position={mobile ? 'bottom-center' : 'bottom-right'}
      offset={mobile ? { bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' } : { bottom: 20, right: 20 }}
      theme={theme === 'dark' ? 'dark' : 'light'}
    />
  )
}
