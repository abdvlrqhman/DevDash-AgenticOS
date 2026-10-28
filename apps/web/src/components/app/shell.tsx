import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveMembers, UserAvatar } from '@/components/app/user-avatar'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Activity, ArrowLeftRight, ChevronsUpDown, Cloud, Download, Ellipsis, FolderGit2, Globe, HardDrive, House, Inbox, KeyRound, ListTodo, LogOut, Monitor, Moon, Network, PocketKnife, Search, Server, Settings, Sparkles, SquareTerminal, StickyNote, Sun, Users,
} from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmHost } from '@/components/app/confirm'
import { api, meQuery, spaceQuery } from '@/lib/api'
import { forgetIosPush } from '@/lib/ios-push'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { useMotion } from '@/lib/motion'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { useUpdateCheck } from '@/lib/update'
import { cn } from '@/lib/utils'
import { sessionsQuery, useLiveSessions } from '@/features/claude/data'
import { useNotificationEvents } from '@/features/notifications/Notifications'
import { Logo } from './brand'
import { useDragWidth, useStoredWidth } from './resize-handle'
import { SearchDialog, showSearch } from './search'
import { ApprovalsBadge } from '@/features/team/Approvals' // Team (optional)
import { SidebarPins } from '@/features/pins/pins'

type NavItem = { to: string; label: string; icon: typeof House; exact?: true }
const NAV: { label?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Home', icon: House, exact: true }] },
  { label: 'Work', items: [
    { to: '/projects', label: 'Projects', icon: FolderGit2 },
    { to: '/tasks', label: 'Tasks', icon: ListTodo },
    { to: '/claude', label: 'Claude', icon: Sparkles },
    { to: '/approvals', label: 'Approvals', icon: Inbox }, // Team
    { to: '/notes', label: 'Notes', icon: StickyNote },
  ] },
  { label: 'Core', items: [
    { to: '/tools', label: 'Tools', icon: PocketKnife },
    { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
    { to: '/services', label: 'Services', icon: Server },
    { to: '/files', label: 'Files', icon: HardDrive },
    { to: '/browser', label: 'Browser', icon: Globe },
    { to: '/vault', label: 'Vault', icon: KeyRound },
    { to: '/network', label: 'Network', icon: Network },
    { to: '/storage', label: 'Storage', icon: Cloud },
  ] },
  { label: 'Team', items: [
    { to: '/members', label: 'Members', icon: Users },
    { to: '/server', label: 'Server', icon: Activity },
  ] },
]

/**
 * Pins the app to the visible area. When the on-screen keyboard opens, iOS shrinks the visual viewport and scrolls the
 * page to keep the input in view, which slides everything off screen. Following the visual viewport (height and offset)
 * keeps the header, conversation and composer still, like a native chat. While typing, the tab bar steps aside.
 */
function usePinToVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const set = () => {
      root.style.setProperty('--app-h', `${vv.height}px`)
      root.style.setProperty('--app-top', `${vv.offsetTop}px`)
      root.classList.toggle('keyboard-open', vv.height < window.innerHeight * 0.8)
    }
    set()
    vv.addEventListener('resize', set)
    vv.addEventListener('scroll', set)
    return () => {
      vv.removeEventListener('resize', set)
      vv.removeEventListener('scroll', set)
    }
  }, [])
}

function useActive() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (to: string, exact?: boolean) => (exact ? path === to : path === to || path.startsWith(`${to}/`))
}

/** Sessions waiting on the member: the badge on Claude in both navigations. */
function useWaitingCount() {
  useLiveSessions()
  useLiveMembers() // someone's new profile picture shows everywhere at once
  return useQuery(sessionsQuery(false)).data?.sessions.filter((s) => s.status === 'waiting').length ?? 0
}

const OPEN_KEY = 'devdash.sidebar-open'
const storedOpen = () => {
  try { return localStorage.getItem(OPEN_KEY) !== 'false' } catch { return true }
}

export function AppShell() {
  usePinToVisualViewport()
  useNotificationEvents()
  useUpdateCheck()
  const waiting = useWaitingCount()
  const pane = useStoredWidth('sidebar', 256, 200, 400)
  const [open, setOpen] = useState(storedOpen)
  const onOpenChange = (v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(OPEN_KEY, String(v)) } catch { /* not remembered */ }
  }
  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={onOpenChange} style={{ '--sidebar-width': `${pane.width}px` } as React.CSSProperties}
        className="fixed inset-x-0 top-0 h-[var(--app-h,100dvh)] min-h-0 translate-y-[var(--app-top,0px)] overflow-hidden">
        <AppSidebar waiting={waiting} pane={pane} />
        <SidebarInset className="min-h-0 min-w-0">
          <PageMotion><Outlet /></PageMotion>
          <MobileTabs waiting={waiting} />
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="bottom-right" mobileOffset={{ bottom: 'calc(4rem + env(safe-area-inset-bottom))' }} />
      <ConfirmHost />
      <SearchDialog />
    </TooltipProvider>
  )
}

/**
 * The scrolling area pages live in. A new page starts at the top, and moving to another section settles it in (180ms).
 * Not into a Claude chat or the terminal: a live stream or a canvas shouldn't wait on a fade.
 */
function PageMotion({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const path = useRouterState({ select: (s) => s.location.pathname })
  const section = path.split('/')[1] ?? ''
  const mounted = useRef(false)
  useEffect(() => { ref.current?.scrollTo(0, 0) }, [path])
  useEffect(() => { mounted.current = true }, [])
  useMotion((gsap) => {
    if (!mounted.current || /^\/(claude\/[0-9a-f-]{36}|terminal)/.test(path)) return
    gsap.fromTo(ref.current, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.18, ease: 'power2.out', clearProps: 'opacity,transform' })
  }, [section])
  return <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">{children}</div>
}

/** The sidebar's edge: drag to resize (remembered on this device), click to collapse to icons. */
function AppRail({ pane }: { pane: ReturnType<typeof useStoredWidth> }) {
  const { state, setOpen, toggleSidebar } = useSidebar()
  const drag = useDragWidth(pane.width, (w) => (state === 'collapsed' ? w - pane.width > 24 && setOpen(true) : pane.setWidth(w)))
  return (
    <SidebarRail {...drag.handlers} title="Drag to resize, click to collapse" aria-label="Resize or collapse the sidebar"
      className="group-data-[state=expanded]:cursor-col-resize! touch-none"
      onClick={() => !drag.moved() && toggleSidebar()} />
  )
}

function AppSidebar({ waiting, pane }: { waiting: number; pane: ReturnType<typeof useStoredWidth> }) {
  const space = useQuery(spaceQuery).data
  const active = useActive()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center gap-1 py-1.5">
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <Logo size={32} className="size-8!" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">{space?.name ?? 'DevDash'}</span>
                  <span className="truncate text-xs text-muted-foreground">{location.host}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarTrigger title="Collapse the sidebar (Ctrl+B)" className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((g, gi) => (<Fragment key={g.label ?? 'top'}>
          {gi === 1 && <SidebarPins />}
          <SidebarGroup className={cn('px-2 py-1.5', gi > 0 && 'pt-0')}>
            {g.label && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {gi === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Search" onClick={showSearch} className="h-7 text-muted-foreground">
                    <Search /><span>Search</span><kbd className="ml-auto rounded border px-1 font-mono text-[10px]">⌘K</kbd>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {g.items.map((n) => (
                <SidebarMenuItem key={n.to}>
                  <SidebarMenuButton asChild isActive={active(n.to, !!n.exact)} tooltip={n.label} className="h-7">
                    <Link to={n.to}><n.icon /><span>{n.label}</span></Link>
                  </SidebarMenuButton>
                  {n.to === '/approvals' && <ApprovalsBadge />}
                  {n.to === '/claude' && waiting > 0 && (
                    <SidebarMenuBadge className="bg-attention-soft text-attention-foreground">{waiting}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </Fragment>))}
      </SidebarContent>
      <SidebarFooter className="py-1.5">
        <SidebarTrigger title="Expand the sidebar (Ctrl+B)" className="mx-auto hidden text-muted-foreground group-data-[collapsible=icon]:inline-flex" />
        <UserMenu />
      </SidebarFooter>
      <AppRail pane={pane} />
    </Sidebar>
  )
}

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Match device', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function useSignOut() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    await forgetIosPush() // this iPhone stops getting the member's notifications
    await api.api.auth.logout.$post()
    qc.clear()
    navigate({ to: '/login' })
  }
}

function UserMenu() {
  const me = useQuery(meQuery).data
  const theme = useTheme()
  const signOut = useSignOut()
  if (!me) return null
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <UserAvatar user={me} className="size-8 rounded-lg" textClassName="rounded-lg" />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{me.name}</span>
                <span className="truncate text-xs text-muted-foreground">{me.username}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="min-w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{me.name}</div>
              <div className="text-xs text-muted-foreground">{me.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild><Link to="/account"><Settings />Account</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link to="/claude/setup"><Sparkles />Claude setup</Link></DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Monitor />Theme</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
                    {THEMES.map((t) => <DropdownMenuRadioItem key={t.value} value={t.value}>{t.label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {inShell()
                ? <DropdownMenuItem onSelect={() => window.devdashShell!.switchSpace()}><ArrowLeftRight />Switch space</DropdownMenuItem>
                : <DropdownMenuItem onSelect={() => openExternal(APP_DOWNLOADS)}><Download />Get the app</DropdownMenuItem>}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

const TABS = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/more', label: 'More', icon: Ellipsis },
] as const

function MobileTabs({ waiting }: { waiting: number }) {
  const active = useActive()
  // Inside a Claude chat the tabs step aside, as in messaging apps: the back arrow leads out.
  const inChat = useRouterState({ select: (s) => /^\/claude\/[0-9a-f-]{36}$/.test(s.location.pathname) })
  if (inChat) return null
  const moreActive = ['/more', '/members', '/account', '/notes', '/tools', '/terminal', '/services', '/files', '/vault', '/network', '/storage', '/browser', '/server'].some((p) => active(p)) || active('/claude/setup')
  return (
    <nav aria-label="Sections" className="grid shrink-0 grid-cols-5 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden [.keyboard-open_&]:hidden">
      {TABS.map((t) => {
        const on = t.to === '/more' ? moreActive : t.to === '/claude' ? active(t.to) && !active('/claude/setup') : active(t.to, 'exact' in t)
        return (
          <Link key={t.to} to={t.to} aria-current={on ? 'page' : undefined}
            className={cn('relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', on ? 'text-foreground' : 'text-muted-foreground')}>
            <t.icon className="size-5" strokeWidth={on ? 2.25 : 1.75} />
            {t.label}
            {t.to === '/claude' && waiting > 0 && (
              <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 rounded-full bg-attention px-1 text-center text-[10px] leading-4 text-black">{waiting}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
