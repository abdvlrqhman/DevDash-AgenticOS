import { useSyncExternalStore } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
const KEY = 'devdash-theme'
const dark = matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function getResolvedTheme(): ResolvedTheme {
  const t = getTheme()
  return t === 'dark' || (t === 'system' && dark.matches) ? 'dark' : 'light'
}

function apply() {
  const on = getResolvedTheme() === 'dark'
  document.documentElement.classList.toggle('dark', on)
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', on ? '#0A0A0A' : '#FFFFFF')
}

export function setTheme(t: ThemePref) {
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  apply()
  for (const fn of listeners) fn()
}

dark.addEventListener('change', () => {
  apply()
  for (const fn of listeners) fn()
})
apply()

const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))
export const useTheme = () => useSyncExternalStore(subscribe, getTheme)
export const useResolvedTheme = () => useSyncExternalStore(subscribe, getResolvedTheme)
