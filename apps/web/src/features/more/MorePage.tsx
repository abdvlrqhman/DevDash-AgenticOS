import { useQuery } from '@tanstack/react-query'
import { UserAvatar } from '@/components/app/user-avatar'
import { Link } from '@tanstack/react-router'
import { Activity, ArrowLeftRight, ChevronRight, Cloud, Download, Globe, HardDrive, Inbox, KeyRound, LogOut, Network, PocketKnife, Search, Server, Settings, Sparkles, SquareTerminal, StickyNote, Users } from 'lucide-react'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { showSearch } from '@/components/app/search'
import { meQuery } from '@/lib/api'
import { PinnedList } from '../pins/pins'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'

const LINKS = [
  { to: '/approvals', label: 'Approvals', description: 'What your AI team wants to do that needs a person', icon: Inbox }, // Team
  { to: '/tools', label: 'Tools', description: 'Offline developer utilities — JSON, base64, cron and more', icon: PocketKnife },
  { to: '/vault', label: 'Vault', description: 'Passwords and 2FA codes, encrypted on your device', icon: KeyRound },
  { to: '/network', label: 'Network', description: 'Reach your own devices over your private tailnet', icon: Network },
  { to: '/storage', label: 'Storage', description: 'Your Google Drive, for big files like videos', icon: Cloud },
  { to: '/notes', label: 'Notes', description: 'Decisions, setup steps and links for the team', icon: StickyNote },
  { to: '/terminal', label: 'Terminal', description: 'Shells on the server that keep running', icon: SquareTerminal },
  { to: '/browser', label: 'Browser', description: 'A shared browser on the server that stays signed in', icon: Globe },
  { to: '/files', label: 'Files', description: 'Browse, upload and share files on the server', icon: HardDrive },
  { to: '/services', label: 'Services', description: 'Websites, APIs and containers that stay up', icon: Server },
  { to: '/server', label: 'Server', description: 'Health, versions and backups', icon: Activity },
  { to: '/members', label: 'Members', description: 'Invite people and see who has access', icon: Users },
  { to: '/claude/setup', label: 'Claude setup', description: 'Profiles, sign-in and defaults', icon: Sparkles },
  { to: '/account', label: 'Account', description: 'Password, email and appearance', icon: Settings },
] as const

/** Phone navigation for everything that doesn't fit in the bottom tabs. */
export function MorePage() {
  const me = useQuery(meQuery).data!
  const theme = useTheme()
  const signOut = useSignOut()
  return (
    <>
      <PageHeader title="More" />
      <PageBody>
        <PinnedList />
        <Item variant="muted">
          <ItemMedia><UserAvatar user={me} className="size-10" /></ItemMedia>
          <ItemContent>
            <ItemTitle>{me.name}</ItemTitle>
            <ItemDescription>{me.email}</ItemDescription>
          </ItemContent>
        </Item>
        <Item variant="outline" asChild>
          <button onClick={showSearch}><ItemMedia variant="icon"><Search /></ItemMedia><ItemContent><ItemTitle>Search</ItemTitle><ItemDescription>Projects, tasks, notes, sessions and services</ItemDescription></ItemContent></button>
        </Item>
        <ItemGroup className="rounded-xl border">
          {LINKS.map((l) => (
            <Item key={l.to} size="sm" asChild className="rounded-none border-0 border-b last:border-b-0">
              <Link to={l.to}>
                <ItemMedia variant="icon"><l.icon /></ItemMedia>
                <ItemContent><ItemTitle>{l.label}</ItemTitle><ItemDescription className="line-clamp-1">{l.description}</ItemDescription></ItemContent>
                <ItemActions><ChevronRight className="size-4 text-muted-foreground" /></ItemActions>
              </Link>
            </Item>
          ))}
          {inShell() ? (
            <Item size="sm" asChild className="rounded-none border-0">
              <button onClick={() => window.devdashShell!.switchSpace()}>
                <ItemMedia variant="icon"><ArrowLeftRight /></ItemMedia>
                <ItemContent><ItemTitle>Switch space</ItemTitle><ItemDescription>Connect to a different DevDash server</ItemDescription></ItemContent>
              </button>
            </Item>
          ) : (
            <Item size="sm" asChild className="rounded-none border-0">
              <button onClick={() => openExternal(APP_DOWNLOADS)}>
                <ItemMedia variant="icon"><Download /></ItemMedia>
                <ItemContent><ItemTitle>Get the app</ItemTitle><ItemDescription>Windows, Android and iPhone</ItemDescription></ItemContent>
              </button>
            </Item>
          )}
        </ItemGroup>
        <Section title="Appearance">
          <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)} className="w-full">
            <ToggleGroupItem value="system" className="flex-1">Device</ToggleGroupItem>
            <ToggleGroupItem value="light" className="flex-1">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark" className="flex-1">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Section>
        <Item asChild variant="outline" className="text-destructive">
          <button onClick={() => void signOut()}>
            <ItemMedia variant="icon"><LogOut /></ItemMedia>
            <ItemContent><ItemTitle>Sign out</ItemTitle></ItemContent>
          </button>
        </Item>
      </PageBody>
    </>
  )
}
