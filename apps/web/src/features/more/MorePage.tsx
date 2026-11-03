import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { UserAvatar } from '@/components/app/user-avatar'
import { Link } from '@tanstack/react-router'
import { Activity, ArrowLeftRight, ChevronRight, Cloud, Download, Globe, HardDrive, Inbox, KeyRound, LogOut, Network, PocketKnife, Search, Server, Settings, Sparkles, SquareTerminal, StickyNote, Users } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { showSearch } from '@/components/app/search'
import { meQuery } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PinnedList } from '../pins/pins'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'

type Destination = { to: string; label: string; description: string; icon: typeof Inbox }

// Everything the bottom tabs leave out, in the groups people look for it in.
const GROUPS: { title: string; links: Destination[] }[] = [
  { title: 'Work', links: [
    { to: '/approvals', label: 'Approvals', description: 'What your AI team wants to do that needs a person', icon: Inbox }, // Team
    { to: '/notes', label: 'Notes', description: 'Decisions, setup steps and links for the team', icon: StickyNote },
    { to: '/tools', label: 'Tools', description: 'Offline developer utilities: JSON, base64, cron and more', icon: PocketKnife },
    { to: '/vault', label: 'Vault', description: 'Passwords and 2FA codes, encrypted on your device', icon: KeyRound },
  ] },
  { title: 'On the server', links: [
    { to: '/terminal', label: 'Terminal', description: 'Shells on the server that keep running', icon: SquareTerminal },
    { to: '/services', label: 'Services', description: 'Websites, APIs and containers that stay up', icon: Server },
    { to: '/files', label: 'Files', description: 'Browse, upload and share files on the server', icon: HardDrive },
    { to: '/browser', label: 'Browser', description: 'A shared browser on the server that stays signed in', icon: Globe },
    { to: '/server', label: 'Server', description: 'Health, versions and backups', icon: Activity },
    { to: '/network', label: 'Network', description: 'Reach your own devices over your private tailnet', icon: Network },
    { to: '/storage', label: 'Storage', description: 'Your Google Drive, for big files like videos', icon: Cloud },
  ] },
  { title: 'Team and settings', links: [
    { to: '/members', label: 'Members', description: 'Invite people and see who has access', icon: Users },
    { to: '/claude/setup', label: 'Claude setup', description: 'Profiles, sign-in and defaults', icon: Sparkles },
    { to: '/account', label: 'Account', description: 'Password, email and appearance', icon: Settings },
  ] },
]

const rowClass = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'
const pinned = cn(
  'empty:hidden [&_section]:gap-3 [&_h2]:px-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-[-0.01em] [&_h2]:text-foreground',
  '[&_section>div]:gap-0.5 [&_section>div]:divide-y-0 [&_section>div]:rounded-2xl [&_section>div]:border-0 [&_section>div]:bg-surface [&_section>div]:p-1.5',
  '[&_section>div>a]:min-h-0 [&_section>div>a]:rounded-xl [&_section>div>a]:border-0 [&_section>div>a]:py-2.5 [&_section>div>a]:transition-[background-color,scale]',
  '[&_section>div>a]:duration-300 [&_section>div>a]:ease-spring [&_section>div>a:hover]:bg-surface-2 [&_section>div>a:active]:scale-[0.99]',
)

/** Phone navigation for everything that doesn't fit in the bottom tabs. */
export function MorePage() {
  const me = useQuery(meQuery).data!
  const theme = useTheme()
  const signOut = useSignOut()
  return (
    <>
      <PageHeader title="More" />
      <PageBody className="gap-10 py-6 md:py-8">
        {/* Who's signed in, big, and the way to everything else: search. */}
        <header className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <UserAvatar user={me} className="size-14" textClassName="text-base" />
            <div className="min-w-0">
              <div className="truncate text-xl font-semibold tracking-[-0.02em]">{me.name}</div>
              <div className="truncate text-sm text-muted-foreground">{me.email}</div>
            </div>
          </div>
          <button onClick={showSearch}
            className="flex h-11 w-full items-center gap-2.5 rounded-full bg-surface px-4 text-left text-sm text-muted-foreground transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]">
            <Search className="size-4 shrink-0" /><span className="truncate">Search projects, tasks, notes and more</span>
          </button>
        </header>
        {/* The pins list belongs to the pins feature (a bordered list); here it takes this page's panel and rows. */}
        <div className={pinned}><PinnedList /></div>
        <div className="grid gap-10 lg:grid-cols-2 lg:items-start lg:gap-x-8">
          {GROUPS.map((g) => (
            <Group key={g.title} title={g.title}>
              {g.links.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className={rowClass}><Place icon={l.icon} label={l.label} description={l.description} /></Link>
                </li>
              ))}
              {g.title === 'Team and settings' && (
                <li>
                  {inShell()
                    ? <button className={rowClass} onClick={() => window.devdashShell!.switchSpace()}><Place icon={ArrowLeftRight} label="Switch space" description="Connect to a different DevDash server" /></button>
                    : <button className={rowClass} onClick={() => openExternal(APP_DOWNLOADS)}><Place icon={Download} label="Get the app" description="Windows, Android and iPhone" /></button>}
                </li>
              )}
            </Group>
          ))}
        </div>
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Appearance</h2>
          <ToggleGroup type="single" spacing={1} value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)} aria-label="Appearance"
            className="w-full rounded-full bg-surface p-1 lg:w-fit">
            <ToggleGroupItem value="system" className="min-w-fit flex-1 rounded-full px-4 hover:bg-surface-2">Device</ToggleGroupItem>
            <ToggleGroupItem value="light" className="min-w-fit flex-1 rounded-full px-4 hover:bg-surface-2">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark" className="min-w-fit flex-1 rounded-full px-4 hover:bg-surface-2">Dark</ToggleGroupItem>
          </ToggleGroup>
        </section>
        <button onClick={() => void signOut()} className={cn(rowClass, 'rounded-2xl bg-surface px-4 py-3 font-medium text-destructive lg:w-fit lg:pr-6')}>
          <LogOut className="size-4 shrink-0" />Sign out
        </button>
      </PageBody>
    </>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
      <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">{children}</ul>
    </section>
  )
}

function Place({ icon: Icon, label, description }: { icon: typeof Inbox; label: string; description: string }) {
  return <>
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><Icon className="size-4" /></span>
    <span className="min-w-0 flex-1">
      <span className="block font-medium">{label}</span>
      <span className="line-clamp-1 text-xs text-muted-foreground">{description}</span>
    </span>
    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
  </>
}
