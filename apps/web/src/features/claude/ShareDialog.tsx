import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { useMembers } from '../work/TaskBits'
import type { Person } from './Collab'
import type { Session } from './data'

type Audience = 'private' | 'everyone' | 'people'
export type SharedPerson = Person & { canSend: boolean; full?: boolean }
/**
 * What someone it's shared with may do. Watch: read along and comment. Ask: message Claude, and whatever would use the
 * owner's access waits for the owner. Full: their messages run with the owner's access, like the owner's own.
 */
type Level = 'watch' | 'ask' | 'full'
const levelOf = (p: SharedPerson): Level => (p.full ? 'full' : p.canSend ? 'ask' : 'watch')

/**
 * What the owner can let teammates' requests use of theirs without asking (the agent's guest gate enforces each). None by
 * default; set per session here, or as the owner's default for a project (GuestCapsDefault on the project page).
 */
export type Cap = 'drive' | 'tailnet' | 'github' | 'apps'
export const CAPS: { value: Cap; label: string; what: string }[] = [
  { value: 'drive', label: 'Google Drive', what: 'rclone on your DevDash Drive folder.' },
  { value: 'tailnet', label: 'Tailscale', what: 'Your tailnet devices: ssh, curl, web pages and tailnet MCPs.' },
  { value: 'github', label: 'GitHub', what: 'gh, and git with GitHub (push, pull, pull requests), as you. Never your login or deleting repos.' },
  { value: 'apps', label: 'Connected apps', what: 'Your other MCP servers and connectors, and DevDash tools, as you.' },
]
export const capsLabel = (caps: readonly string[]) =>
  caps.length ? CAPS.filter((c) => caps.includes(c.value)).map((c) => c.label).join(', ') : 'nothing'
export const projectCapsQuery = (slug: string) => ({
  queryKey: ['claude', 'project-caps', slug],
  queryFn: () => unwrap(api.api.claude.projects[':slug']['guest-caps'].$get({ param: { slug } })),
})

const AUDIENCE: { value: Audience; label: string }[] = [
  { value: 'private', label: 'Only me' }, { value: 'everyone', label: 'Whole team' }, { value: 'people', label: 'Chosen people' },
]

/** One line for who can see a session, e.g. "Shared with 2 people". Empty when only the owner can. */
export function sharingLabel(s: Pick<Session, 'audience' | 'sharedWith' | 'sharedCanSend'>) {
  if (s.audience === 'everyone') return s.sharedCanSend ? 'shared, others can ask Claude' : 'shared'
  if (s.audience === 'people') return `shared with ${s.sharedWith} ${s.sharedWith === 1 ? 'person' : 'people'}`
  return ''
}

/** The owner picks who can see a session: only them, the whole team, or chosen people, each at a level (Level). */
export function ShareDialog({ open, onOpenChange, s, me, people, writers, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; s: Session; me: number
  people: SharedPerson[]; writers: Person[]; onSaved: () => void
}) {
  const qc = useQueryClient()
  const members = useMembers().filter((m) => m.id !== me)
  const [audience, setAudience] = useState<Audience>(s.audience)
  const [everyoneCanSend, setEveryoneCanSend] = useState(s.sharedCanSend)
  const [picked, setPicked] = useState<Map<number, Level>>(new Map())
  const [caps, setCaps] = useState<Set<Cap>>(new Set())
  // In a project: follow my default for it, until a switch here is changed.
  const [follow, setFollow] = useState(s.guestCapsFromProject)
  const [error, setError] = useState<Error | null>(null)
  const savedCaps = s.guestCaps.join()
  const projectCaps = useQuery({ ...projectCapsQuery(s.project?.slug ?? ''), enabled: open && !!s.project })
  useEffect(() => {
    if (!open) return
    setAudience(s.audience)
    setEveryoneCanSend(s.sharedCanSend)
    setPicked(new Map(people.map((p) => [p.id, levelOf(p)])))
    setCaps(new Set(savedCaps.split(',').filter(Boolean) as Cap[]))
    setFollow(s.guestCapsFromProject)
    setError(null)
  }, [open, s.audience, s.sharedCanSend, people, savedCaps, s.guestCapsFromProject])
  const shown = follow && projectCaps.data ? new Set(projectCaps.data.caps) : caps
  const capsJson = follow ? null : [...caps]

  const save = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions[':id'].sharing.$put({
      param: { id: s.id },
      json: audience === 'people'
        ? { audience, people: [...picked].map(([id, level]) => ({ id, canSend: level !== 'watch', full: level === 'full' })), caps: capsJson }
        : { audience, everyoneCanSend: audience === 'everyone' && everyoneCanSend, caps: audience === 'private' ? null : capsJson },
    })),
    onSuccess: () => { onSaved(); onOpenChange(false) },
    onError: (e) => setError(e),
  })
  const stopSending = useMutation({
    mutationFn: (userId: number) => unwrap(api.api.claude.sessions[':id'].writers[':userId'].$put({ param: { id: s.id, userId: String(userId) }, json: { allowed: false } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['claude', 'session', s.id] }).then(onSaved),
    onError: (e) => toast.error(e.message),
  })
  const toggle = (id: number, on: boolean) => setPicked((m) => {
    const next = new Map(m)
    if (on) next.set(id, next.get(id) ?? 'watch')
    else next.delete(id)
    return next
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  const emptyPick = audience === 'people' && picked.size === 0

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Share session" description={s.title}>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel>Who can see it</FieldLabel>
            <ToggleGroup type="single" variant="outline" value={audience} onValueChange={(v) => v && setAudience(v as Audience)} className="w-full">
              {AUDIENCE.map((a) => <ToggleGroupItem key={a.value} value={a.value} className="flex-1">{a.label}</ToggleGroupItem>)}
            </ToggleGroup>
          </Field>

          {audience === 'everyone' && (
            <>
              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                <span className="flex flex-col gap-0.5">
                  <span>Everyone can ask Claude</span>
                  <span className="text-xs text-muted-foreground">What would use your accounts or private files waits for your approval, unless you share it below.</span>
                </span>
                <Switch checked={everyoneCanSend} onCheckedChange={setEveryoneCanSend} />
              </label>
              {!everyoneCanSend && writers.length > 0 && (
                <div className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">Also sending messages (you let them in)</span>
                  {writers.map((w) => (
                    <div key={w.id} className="flex items-center justify-between gap-2">
                      <span>{w.name}</span>
                      <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Stop ${w.name} sending messages`} onClick={() => stopSending.mutate(w.id)}><X /></Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {audience === 'people' && (
            <Field>
              <div className="flex flex-col divide-y rounded-md border">
                {members.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Nobody else is in this space yet.</p>}
                {members.map((m) => {
                  const on = picked.has(m.id)
                  return (
                    <div key={m.id} className="flex min-h-11 items-center gap-3 px-3 py-1.5">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
                        <Checkbox checked={on} onCheckedChange={(v) => toggle(m.id, v === true)} />
                        <span className="truncate">{m.name}</span>
                      </label>
                      {on && (
                        <ToggleGroup type="single" variant="outline" size="sm" value={picked.get(m.id) ?? 'watch'}
                          onValueChange={(v) => v && setPicked((p) => new Map(p).set(m.id, v as Level))} aria-label={`What ${m.name} can do`}>
                          <ToggleGroupItem value="watch">Watch</ToggleGroupItem>
                          <ToggleGroupItem value="ask">Ask</ToggleGroupItem>
                          <ToggleGroupItem value="full">Full</ToggleGroupItem>
                        </ToggleGroup>
                      )}
                    </div>
                  )
                })}
              </div>
              <FieldDescription>
                Only the people you tick see this session. <b>Watch:</b> read along and comment. <b>Ask:</b> message Claude; what
                would use your accounts or private files waits for your approval, unless you share it below.
                <b> Full:</b> their messages run with your access, like yours, and they can use the CLI.
              </FieldDescription>
              {[...picked.values()].includes('full') && (
                <p className="rounded-md border border-attention/50 bg-attention-soft px-3 py-2 text-xs text-attention-foreground">
                  Full access lets them use your GitHub, Drive, Tailscale and files through Claude without asking you. Only give it
                  to people you'd hand your laptop to.
                </p>
              )}
            </Field>
          )}

          {audience !== 'private' && (
            <Field>
              <FieldLabel>What their requests can use without asking you</FieldLabel>
              <div className="flex flex-col divide-y rounded-md border">
                {CAPS.map((c) => (
                  <label key={c.value} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>{c.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {c.what}{c.value === 'tailnet' && !s.reachTailnet && ' This session doesn’t reach your tailnet now.'}
                      </span>
                    </span>
                    <Switch checked={shown.has(c.value)} aria-label={`Share ${c.label}`} onCheckedChange={(on) => {
                      const next = new Set(shown)
                      if (on) next.add(c.value)
                      else next.delete(c.value)
                      setCaps(next)
                      setFollow(false)
                    }} />
                  </label>
                ))}
              </div>
              <FieldDescription>
                Off: Claude asks you each time. Other commands run, and Claude never does anything for them that harms you.
                {s.project && (follow
                  ? <> Your settings for {s.project.name}.</>
                  : <> Just this session. <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => setFollow(true)}>Use my {s.project.name} settings</button></>)}
              </FieldDescription>
            </Field>
          )}

          <ErrorAlert error={error} />
          <p className="text-xs text-muted-foreground">
            {audience === 'private' ? 'Only you can see this session.' : 'Claude runs as you. When others ask it for something that would use your access, you decide.'}
          </p>
          <Button type="submit" className="h-10" disabled={save.isPending || emptyPick}>
            {save.isPending ? 'Saving…' : emptyPick ? 'Pick at least one person' : 'Save'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
