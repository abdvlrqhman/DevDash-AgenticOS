import { useState, type FormEvent } from 'react'
import { UserAvatar } from '@/components/app/user-avatar'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, UserPlus, Ellipsis, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, meQuery, unwrap } from '@/lib/api'
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
      <PageBody>
        <ErrorAlert error={error} />
        <Section title={data ? `${users.length} ${users.length === 1 ? 'member' : 'members'}` : 'Members'}>
          <ItemGroup className="rounded-xl border">
            {users.map((u) => (
              <Item key={u.id} className="rounded-none border-0 border-b last:border-b-0">
                <ItemMedia><UserAvatar user={u} className="size-9" /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{u.name}{u.id === me.id && <span className="font-normal text-muted-foreground">(you)</span>}</ItemTitle>
                  <ItemDescription className="truncate">{u.username}, {u.email}</ItemDescription>
                </ItemContent>
                <ItemActions className="gap-1.5">
                  {me.role === 'admin' && !u.provisioned_at && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant={u.provision_error ? 'destructive' : 'secondary'}>{u.provision_error ? 'Server account failed' : 'Setting up'}</Badge>
                      </TooltipTrigger>
                      {u.provision_error && <TooltipContent>{u.provision_error}</TooltipContent>}
                    </Tooltip>
                  )}
                  {u.role === 'admin' && <Badge variant="outline">Admin</Badge>}
                  {me.role === 'admin' && u.id !== me.id && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Options for ${u.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving({ id: u.id, name: u.name })}><UserMinus />Remove from the team</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {me.role === 'admin' && u.id === me.id && <span aria-hidden className="size-7 shrink-0 pointer-coarse:size-9" />}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </Section>
        {!!data?.invites.length && (
          <Section title="Invited">
            <ItemGroup className="rounded-xl border">
              {data.invites.map((i) => (
                <Item key={i.id} className="rounded-none border-0 border-b last:border-b-0">
                  <ItemContent>
                    <ItemTitle>{i.email}</ItemTitle>
                    <ItemDescription>{i.username}</ItemDescription>
                  </ItemContent>
                  <ItemActions><Badge variant="secondary">Expires in {daysLeft(i.expires_at)} days</Badge></ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </Section>
        )}
      </PageBody>
      {removing && <RemoveMember member={removing} onClose={() => setRemoving(null)} />}
      {me.role === 'admin' && <InviteDialog open={inviting} onOpenChange={setInviting} />}
    </>
  )
}

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
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">{invite.data.link}</code>
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
              <Input id="inv-user" required pattern="[a-z][a-z0-9\-]{1,30}" className="h-10 font-mono" value={username}
                onChange={(e) => { setTouched(true); setUsername(e.target.value.toLowerCase()) }} />
              <FieldDescription>Also their Linux user on the server. Lowercase letters, digits and dashes. Can't be changed later.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <ToggleGroup type="single" variant="outline" value={role} onValueChange={(v) => v && setRole(v as 'member' | 'admin')} className="w-full">
                <ToggleGroupItem value="member" className="flex-1">Member</ToggleGroupItem>
                <ToggleGroupItem value="admin" className="flex-1">Admin</ToggleGroupItem>
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
