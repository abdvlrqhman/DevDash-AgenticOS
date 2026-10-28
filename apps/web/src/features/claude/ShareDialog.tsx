import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
export type SharedPerson = Person & { canSend: boolean }

const AUDIENCE: { value: Audience; label: string }[] = [
  { value: 'private', label: 'Only me' }, { value: 'everyone', label: 'Whole team' }, { value: 'people', label: 'Chosen people' },
]

/** One line for who can see a session, e.g. "Shared with 2 people". Empty when only the owner can. */
export function sharingLabel(s: Pick<Session, 'audience' | 'sharedWith' | 'sharedCanSend'>) {
  if (s.audience === 'everyone') return s.sharedCanSend ? 'shared, others can type' : 'shared'
  if (s.audience === 'people') return `shared with ${s.sharedWith} ${s.sharedWith === 1 ? 'person' : 'people'}`
  return ''
}

/** The owner picks who can see a session: only them, the whole team, or chosen people — each watching or also sending. */
export function ShareDialog({ open, onOpenChange, s, me, people, writers, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; s: Session; me: number
  people: SharedPerson[]; writers: Person[]; onSaved: () => void
}) {
  const qc = useQueryClient()
  const members = useMembers().filter((m) => m.id !== me)
  const [audience, setAudience] = useState<Audience>(s.audience)
  const [everyoneCanSend, setEveryoneCanSend] = useState(s.sharedCanSend)
  const [picked, setPicked] = useState<Map<number, boolean>>(new Map()) // member id → may send
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    if (!open) return
    setAudience(s.audience)
    setEveryoneCanSend(s.sharedCanSend)
    setPicked(new Map(people.map((p) => [p.id, p.canSend])))
    setError(null)
  }, [open, s.audience, s.sharedCanSend, people])

  const save = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions[':id'].sharing.$put({
      param: { id: s.id },
      json: audience === 'people'
        ? { audience, people: [...picked].map(([id, canSend]) => ({ id, canSend })) }
        : { audience, everyoneCanSend: audience === 'everyone' && everyoneCanSend },
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
    if (on) next.set(id, next.get(id) ?? false)
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
                <span>Everyone can send messages</span>
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
                        <ToggleGroup type="single" variant="outline" size="sm" value={picked.get(m.id) ? 'send' : 'watch'}
                          onValueChange={(v) => v && setPicked((p) => new Map(p).set(m.id, v === 'send'))} aria-label={`What ${m.name} can do`}>
                          <ToggleGroupItem value="watch">Watch</ToggleGroupItem>
                          <ToggleGroupItem value="send">Send</ToggleGroupItem>
                        </ToggleGroup>
                      )}
                    </div>
                  )
                })}
              </div>
              <FieldDescription>Only the people you tick see this session. Watch: read along and comment. Send: they can message Claude too.</FieldDescription>
            </Field>
          )}

          <ErrorAlert error={error} />
          <p className="text-xs text-muted-foreground">
            {audience === 'private' ? 'Only you can see this session.' : 'Claude still runs as you, with your account and permissions.'}
          </p>
          <Button type="submit" className="h-10" disabled={save.isPending || emptyPick}>
            {save.isPending ? 'Saving…' : emptyPick ? 'Pick at least one person' : 'Save'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
