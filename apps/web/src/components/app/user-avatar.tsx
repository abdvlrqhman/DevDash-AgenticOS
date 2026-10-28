import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { api, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { initials } from './brand'

/** Everyone in the space, with when each one's picture last changed (null: no picture). Shared with the members page. */
export const membersQuery = queryOptions({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()), staleTime: 60_000 })

/** A member's picture changing reaches every open page (call once, in the app shell). */
export function useLiveMembers() {
  const qc = useQueryClient()
  useTopic('members', () => void qc.invalidateQueries({ queryKey: ['members'] }))
}

/** The address of a member's picture; the version makes a new picture a new address, so browsers can cache forever. */
export const avatarUrl = (id: number, version: number) => `/api/members/${id}/avatar?v=${version}`

/** Someone's profile picture, or their initials while there's none (or it's loading). */
export function UserAvatar({ user, className, textClassName, title }: {
  user: { id: number; name: string }; className?: string; textClassName?: string; title?: string
}) {
  const version = useQuery({ ...membersQuery, select: (d) => d.users.find((u) => u.id === user.id)?.avatarAt ?? null }).data
  return (
    <Avatar className={className} title={title}>
      {version ? <AvatarImage src={avatarUrl(user.id, version)} alt="" className="rounded-[inherit]" /> : null}
      <AvatarFallback className={textClassName}>{initials(user.name)}</AvatarFallback>
    </Avatar>
  )
}
