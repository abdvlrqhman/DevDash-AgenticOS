import { useState, type FormEvent, type ReactNode } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, UserPlus, Ellipsis, Mail, UserMinus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, meQuery, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'

const membersQuery = { queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) }
const daysLeft = (unix: number) => Math.max(0, Math.ceil((unix * 1000 - Date.now()) / 86_400_000))

export function MembersPage() {
  const me = useQuery(meQuery).data!
  const { data, error } = useQuery(membersQuery)
  const [inviting, setInviting] = useState(false)
  const [removing, setRemoving] = useState<{ id: number; name: string } | null>(null)
  const users = (data?.users ?? []).filter((u) => !u.disabled_at)

  return (
    <>
      <PageHeader title="Members" actions={me.role === 'admin' && <Button size="sm" onClick={() => setInviting(true)}><UserPlus />Invite</Button>} />
      <PageBody className="gap-12 py-8 md:py-12">
        <ErrorAlert error={error} />
        {/* The people are the page: each one a card with their face first, as many across as fit without cutting emails. */}
        <Block title="Team" count={data ? users.length : undefined}>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-2">
            {!data && [0, 1, 2].map((i) => <li key={i}><Skeleton className="h-[5.5rem] rounded-2xl" /></li>)}
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-4 rounded-2xl bg-surface p-4">
                <UserAvatar user={u} className="size-12" textClassName="text-sm" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="truncate font-medium">{u.name}{u.id === me.id && <span className="font-normal text-muted-foreground"> (you)</span>}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.username}, {u.email}</div>
                  {(u.role === 'admin' || (me.role === 'admin' && !u.provisioned_at)) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {u.role === 'admin' && <Tag>Admin</Tag>}
                      {me.role === 'admin' && !u.provisioned_at && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Tag className={cn(u.provision_error && 'bg-destructive/10 text-destructive')}>{u.provision_error ? 'Server account failed' : 'Setting up'}</Tag>
                          </TooltipTrigger>
                          {u.provision_error && <TooltipContent>{u.provision_error}</TooltipContent>}
                        </Tooltip>
                      )}
                    </div>
                  )}
                </div>
                {me.role === 'admin' && u.id !== me.id && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" className="-mr-1.5 self-start hover:bg-surface-2 dark:hover:bg-surface-2" aria-label={`Options for ${u.name}`}><Ellipsis /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onSelect={() => setRemoving({ id: u.id, name: u.name })}><UserMinus />Remove from the team</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            ))}
          </ul>
        </Block>
        {!!data?.invites.length && (
          <Block title="Invited" count={data.invites.length}>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {data.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground"><Mail className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.email}</span>
                    <span className="block truncate text-xs text-muted-foreground">{i.username}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    Expires in {daysLeft(i.expires_at)} {daysLeft(i.expires_at) === 1 ? 'day' : 'days'}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </PageBody>
      {removing && <RemoveMember member={removing} onClose={() => setRemoving(null)} />}
      {me.role === 'admin' && <InviteDialog open={inviting} onOpenChange={setInviting} />}
    </>
  )
}

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-base font-semibold tracking-[-0.01em]">{title}{count !== undefined && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span>}</h2>
      {children}
    </section>
  )
}

/** A quiet word on a card: a role, or how their server account is coming along. */
const Tag = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span {...props} className={cn('rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground', className)} />
)

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [touched, setTouched] = useState(false)
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [copied, setCopied] = useState(false)

  const invite = useMutation({
    mutationFn: () => unwrap(api.api.members.invites.$post({ json: { email, username, role } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
  })
  const reset = () => {
    invite.reset()
    setEmail('')
    setUsername('')
    setTouched(false)
    setCopied(false)
  }
  const onEmail = (v: string) => {
    setEmail(v)
    if (!touched) setUsername(v.split('@')[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '').slice(0, 31))
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    invite.mutate()
  }
  const copy = (link: string) => navigator.clipboard.writeText(link).then(() => { setCopied(true); toast.success('Invite link copied') })

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset() }}
      title={invite.data ? `Invite link for ${email}` : 'Invite a member'}
      description={invite.data ? 'Send it privately. It works once and expires in 7 days.' : 'They get their own login, 2FA and Linux account on the server.'}>
      {invite.data ? (
        <div className="flex flex-col gap-3">
          <code className="block rounded-xl bg-surface px-3 py-2.5 font-mono text-xs break-all">{invite.data.link}</code>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => copy(invite.data.link)}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button>
            <Button variant="outline" onClick={reset}>Invite another</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="inv-email">Email</FieldLabel>
              <Input id="inv-email" type="email" required className="h-10" value={email} onChange={(e) => onEmail(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="inv-user">Username</FieldLabel>
              <Input id="inv-user" required pattern="[a-z][a-z0-9\-]{1,30}" className="h-10" value={username}
                onChange={(e) => { setTouched(true); setUsername(e.target.value.toLowerCase()) }} />
              <FieldDescription>Also their Linux user on the server. Lowercase letters, digits and dashes. Can't be changed later.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <ToggleGroup type="single" spacing={1} value={role} onValueChange={(v) => v && setRole(v as 'member' | 'admin')} className="w-full rounded-full bg-surface p-1">
                <ToggleGroupItem value="member" className="flex-1 rounded-full hover:bg-surface-2">Member</ToggleGroupItem>
                <ToggleGroupItem value="admin" className="flex-1 rounded-full hover:bg-surface-2">Admin</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>{role === 'admin' ? 'Admins invite people and can open the root shell.' : 'Members use everything except admin tools.'}</FieldDescription>
            </Field>
            <ErrorAlert error={invite.error} />
            <Button type="submit" className="h-10" disabled={!email || !username || invite.isPending}>Create invite link</Button>
          </FieldGroup>
        </form>
      )}
    </ResponsiveDialog>
  )
}

function RemoveMember({ member, onClose }: { member: { id: number; name: string }; onClose: () => void }) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.members[':id'].remove.$post({ param: { id: String(member.id) } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['members'] }); toast.success(`${member.name} was removed.`); onClose() },
  })
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title={`Remove ${member.name}?`}
      description="They're signed out everywhere and can't sign in again. Their server account and files stay, so nothing they built is lost. The team vault gets a new key the next time someone unlocks it.">
      <div className="flex flex-col gap-3">
        <ErrorAlert error={remove.error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Keep them</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove {member.name.split(' ')[0]}</Button>
        </div>
      </div>
    </ResponsiveDialog>
  )
}
