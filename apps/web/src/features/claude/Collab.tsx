import { useEffect, useRef, useState } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Hand, MessageSquareText, SendHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from './data'

export type Person = { id: number; name: string }
export type Comment = { id: number; body: string; createdAt: number; user: Person }

const names = (people: Person[]) =>
  people.length <= 2 ? people.map((p) => p.name).join(' and ') : `${people.slice(0, -1).map((p) => p.name).join(', ')} and ${people.at(-1)!.name}`

/** Everyone else who has this session open right now. */
export function Watchers({ viewers, me }: { viewers: Person[]; me: number }) {
  const others = viewers.filter((v) => v.id !== me)
  if (!others.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full py-1 pr-1 pl-2 text-xs text-muted-foreground" aria-label={`${names(others)} ${others.length === 1 ? 'is' : 'are'} watching`}>
          <Eye className="size-3.5" />
          <div className="flex -space-x-1.5">
            {others.slice(0, 3).map((v) => (
              <UserAvatar key={v.id} user={v} className="size-6 ring-2 ring-background" textClassName="text-[10px]" />
            ))}
          </div>
          {others.length > 3 && <span>+{others.length - 3}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent>{names(others)} {others.length === 1 ? 'is' : 'are'} watching</TooltipContent>
    </Tooltip>
  )
}

export const commentsQuery = (id: string) => queryOptions({
  queryKey: ['claude', 'comments', id],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].comments.$get({ param: { id } })),
})

/** The team's side conversation about a session. Never sent to Claude. */
export function Comments({ id, open, onOpenChange, me }: { id: string; open: boolean; onOpenChange: (v: boolean) => void; me: number }) {
  const qc = useQueryClient()
  const q = useQuery({ ...commentsQuery(id), enabled: open })
  const [body, setBody] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const post = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions[':id'].comments.$post({ param: { id }, json: { body } })),
    onSuccess: ({ comment }) => {
      setBody('')
      qc.setQueryData(commentsQuery(id).queryKey, (old) => old && !old.comments.some((c) => c.id === comment.id) ? { comments: [...old.comments, comment] } : old)
    },
  })
  const list = q.data?.comments ?? []
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [list.length, open])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Comments" description="For the team. Claude doesn't see these.">
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
          {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!q.isPending && !list.length && <p className="py-6 text-center text-sm text-muted-foreground">No comments yet. Leave a note for whoever is driving.</p>}
          {list.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <UserAvatar user={c.user} className="size-7 shrink-0" textClassName="text-[11px]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium">{c.user.id === me ? 'You' : c.user.name}</span>
                  <span className="text-muted-foreground">{relativeTime(c.createdAt)}</span>
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{c.body}</p>
              </div>
            </div>
          ))}
          <div ref={end} />
        </div>
        <ErrorAlert error={post.error} />
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) post.mutate() }}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={1} maxLength={5000} placeholder="Write a comment" aria-label="Comment"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (body.trim()) post.mutate() } }}
            className="max-h-40 min-h-10 flex-1 resize-none [field-sizing:content]" />
          <Button type="submit" size="icon" className="size-10 shrink-0" aria-label="Post comment" disabled={!body.trim() || post.isPending}><SendHorizontal /></Button>
        </form>
      </div>
    </ResponsiveDialog>
  )
}

export function CommentsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="relative shrink-0 max-sm:size-9 max-sm:px-0" aria-label={`Comments${count ? ` (${count})` : ''}`} onClick={onClick}>
      <MessageSquareText />
      <span className="hidden sm:inline">Comments</span>
      {count > 0 && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground max-sm:absolute max-sm:-top-0.5 max-sm:-right-0.5 max-sm:bg-foreground max-sm:text-background">{count}</span>}
    </Button>
  )
}

/** Instead of the message box, for teammates who can watch but not send. */
export function WatchOnly({ id, owner, onComment }: { id: string; owner: string; onComment: () => void }) {
  const [asked, setAsked] = useState(false)
  const ask = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions[':id'].join.$post({ param: { id } })),
    onSuccess: () => { setAsked(true); toast.success(`Asked ${owner}. You'll get a notification when they let you in.`) },
    onError: (e) => toast.error(e.message),
  })
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm text-muted-foreground">{owner} shared this session to watch.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onComment}><MessageSquareText />Comment</Button>
        <Button size="sm" disabled={asked || ask.isPending} onClick={() => ask.mutate()}><Hand />{asked ? 'Asked' : 'Ask to join'}</Button>
      </div>
    </div>
  )
}
