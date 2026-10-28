import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'

export const GITHUB_LOGIN_TERMINAL = 'github-login'
export const githubQuery = { queryKey: ['github'], queryFn: () => unwrap(api.api.terminals.github.$get()), staleTime: 30_000 }

/**
 * This member's own GitHub connection on the server. DevDash clones, fetches and pushes as each person with their
 * own credentials, so nobody's access or identity gets mixed up with anyone else's.
 */
export function GitHubConnection({ compact, className }: { compact?: boolean; className?: string }) {
  const q = useQuery(githubQuery)
  if (q.isPending) return <Skeleton className={cn('h-10', className)} />
  const gh = q.data
  const connect = (
    <Button size={compact ? 'sm' : 'default'} variant={gh?.connected ? 'outline' : 'default'} asChild>
      <Link to="/terminal" search={{ open: GITHUB_LOGIN_TERMINAL }}><KeyRound />{gh?.connected ? 'Reconnect' : 'Connect GitHub'}</Link>
    </Button>
  )
  return (
    <div className={cn('flex items-center gap-3', compact ? 'rounded-lg border px-3 py-2' : '', className)}>
      <div className="min-w-0 flex-1 text-sm">
        {q.error ? <span className="text-muted-foreground">Couldn't check GitHub right now.</span>
          : gh?.connected ? <span className="flex items-center gap-1.5"><CircleCheck className="size-4 shrink-0 text-live" />Connected as <span className="font-mono">{gh.login ?? 'your account'}</span></span>
          : <span className="text-muted-foreground">{compact ? 'GitHub isn’t connected. Needed for private repositories.' : 'Not connected. Connect to clone private repositories and push from the server.'}</span>}
      </div>
      {connect}
    </div>
  )
}
