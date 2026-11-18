// What Hamasa follows: a strip in its panel, the switch in its settings (in
// testing: admins only), and the hook the session chip and the sessions list read.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Eye, X } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { Switch } from '@/components/ui/switch'
import { api, meQuery, unwrap } from '@/lib/api'
import { useTopic } from '@/lib/live'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { assistantQuery } from './AssistantDock'
import { followLabel, followLight as light } from './follow-label'
import { AGENT_NAME, panelCoversPage, setAssistantOpen } from './store'

type State = Awaited<ReturnType<typeof assistantQuery.queryFn & {}>>
export type Follow = State['following']['sessions'][number]

/** The session Hamasa follows with this id, if it does. */
export function useFollowed(sessionId: string): Follow | undefined {
  return useQuery(assistantQuery).data?.following.sessions.find((f) => f.sessionId === sessionId)
}

export function useUnfollow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => unwrap(api.api.assistant.follows[':sessionId'].$delete({ param: { sessionId } })),
    onSuccess: (r) => qc.setQueryData(assistantQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
}


/** In Hamasa's panel, under its header: the sessions it follows, each with its status, a tap away; × stops following. */
export function FollowStrip({ st }: { st: State }) {
  const unfollow = useUnfollow()
  // Statuses as they change (the list only moves when Hamasa is told something).
  const [live, setLive] = useState<Record<string, string>>({})
  useTopic(st.following.sessions.length ? 'sessions' : null, (e) => {
    const s = e.session as { id?: string; status?: string } | undefined
    if (e.type === 'session' && s?.id && s.status && st.following.sessions.some((f) => f.sessionId === s.id)) setLive((m) => ({ ...m, [s.id!]: s.status! }))
  })
  if (!st.following.on || !st.following.sessions.length) return null
  return (
    <div className="flex shrink-0 flex-col border-b bg-surface-2/60 px-3 py-1.5" aria-label={`Sessions ${AGENT_NAME} follows`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Eye className="size-3" />Following</div>
      <ul className="flex flex-col">
        {st.following.sessions.map((f) => (
          <li key={f.sessionId} className="flex min-h-8 items-center gap-2 text-sm">
            <StatusLight state={light(live[f.sessionId] ?? f.status)} className="shrink-0" />
            <Link to="/sessions/$id" params={{ id: f.sessionId }} title={f.goal} className="min-w-0 flex-1 truncate hover:underline"
              onClick={() => { if (panelCoversPage()) setAssistantOpen(false) }}>{f.title}</Link>
            <span className={cn('shrink-0 text-xs tabular-nums', f.state === 'waiting_you' ? 'text-attention-foreground dark:text-attention' : 'text-muted-foreground')}>{followLabel(f)}</span>
            <button type="button" aria-label={`Stop following ${f.title}`} title="Stop following" disabled={unfollow.isPending}
              className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => unfollow.mutate(f.sessionId)}><X className="size-3.5" /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** In Hamasa's settings, for admins while it's tested: following on or off for themself. */
export function FollowSetting({ st }: { st: State }) {
  const me = useQuery(meQuery).data
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (on: boolean) => unwrap(api.api.assistant.following.$put({ json: { on } })),
    onSuccess: (r) => qc.setQueryData(assistantQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  if (me?.role !== 'admin' && !st.following.on) return null
  return (
    <section className="flex flex-col gap-3 border-t pt-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <label htmlFor="follow-sessions" className="font-medium">Follow sessions <span className="text-xs font-normal text-muted-foreground">(testing)</span></label>
          <p className="mt-1 text-xs text-pretty text-muted-foreground">
            Ask “{AGENT_NAME}, follow this session”. When it finishes, asks something or fails, {AGENT_NAME} reads it and continues it
            (only within your autopilot rules) or tells you here. One notification when it’s done or needs you.
          </p>
        </div>
        <Switch id="follow-sessions" checked={st.following.on} disabled={save.isPending || me?.role !== 'admin'} onCheckedChange={(v) => save.mutate(v)} />
      </div>
    </section>
  )
}

/** A small eye on sessions Hamasa follows, in the session lists. */
export function FollowGlyph({ id, className }: { id: string; className?: string }) {
  const f = useFollowed(id)
  if (!f) return null
  const label = `${AGENT_NAME} is following`
  return <Eye role="img" aria-label={label} className={cn('size-3.5 shrink-0 text-muted-foreground', className)}><title>{label}</title></Eye>
}
