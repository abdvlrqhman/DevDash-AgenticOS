import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { membersQuery, UserAvatar } from '@/components/app/user-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { CodeInput, ErrorAlert } from '../auth/LoginPage'
import { NtfyPanel } from '../notifications/Ntfy'
import { AvatarCropDialog } from './AvatarCrop'
import { NotificationsPanel } from '../notifications/Notifications'
import { GitHubConnection } from '../work/GitHub'

const Panel = SettingsSection

/** Choose, change or remove your picture. You pick the square to show (AvatarCrop); only that, shrunk, uploads. */
function ProfilePicture() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const has = useQuery({ ...membersQuery, select: (d) => d.users.find((u) => u.id === me.id)?.avatarAt ?? null }).data
  const input = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File | null>(null)
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: ['members'] }) }
  const upload = useMutation({
    mutationFn: async (picture: Blob) => {
      const res = await fetch('/api/members/me/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': picture.type }, body: picture })
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(e?.error?.message ?? `Upload failed (${res.status})`)
      }
    },
    onSuccess: () => { setPicked(null); done('Picture updated') },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.members.me.avatar.$delete()),
    onSuccess: () => done('Picture removed'),
    onError: (e) => toast.error(e.message),
  })
  return (
    <div className="flex items-center gap-4">
      <UserAvatar user={me} className="size-16" textClassName="text-lg" />
      <div className="flex flex-wrap gap-2">
        <input ref={input} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPicked(f) }} />
        <Button size="sm" variant="outline" onClick={() => input.current?.click()}>{has ? 'Change picture' : 'Choose a picture'}</Button>
        {has && <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>}
      </div>
      <AvatarCropDialog file={picked} saving={upload.isPending} onCancel={() => setPicked(null)}
        onPickAnother={() => input.current?.click()} onSave={(picture) => upload.mutate(picture)} />
    </div>
  )
}

export function AccountPage() {
  const me = useQuery(meQuery).data!
  const signOut = useSignOut()
  const theme = useTheme()

  return (
    <>
      <PageHeader title="Account" />
      <PageBody>
        <Panel title="Profile" description="Your picture shows wherever DevDash shows who you are. You can sign in with your email or your username.">
          <ProfilePicture />
          <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt><dd>{me.name}</dd>
            <dt className="text-muted-foreground">Username</dt><dd className="font-mono">{me.username}</dd>
            <dt className="text-muted-foreground">Email</dt><dd className="break-all">{me.email}</dd>
            <dt className="text-muted-foreground">Role</dt><dd>{me.role === 'admin' ? <Badge variant="outline">Admin</Badge> : 'Member'}</dd>
          </dl>
        </Panel>
        <Panel title="Notifications" description="Choose what DevDash tells you about. These apply to all your devices.">
          <NotificationsPanel />
        </Panel>
        <Panel title="Phone notifications with ntfy" description="For an iPhone app installed with a sideloading app: notifications even while DevDash is closed, through the free ntfy app.">
          <NtfyPanel />
        </Panel>
        <Panel title="GitHub" description="Your own GitHub account on the server. DevDash clones, fetches and pushes as you; you sign in once with a code in your browser.">
          <GitHubConnection />
        </Panel>
        <Panel title="Password" description="Changing it signs you out on your other devices."><PasswordForm /></Panel>
        <Panel title="Email"><EmailForm /></Panel>
        {me.role === 'admin' && (
          <Panel title="Server password" description={`The Linux password for ${me.username} on the server. sudo asks for it, for example in the admin shell.`}>
            <ServerPasswordForm />
          </Panel>
        )}
        <Panel title="Appearance">
          <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)}>
            <ToggleGroupItem value="system">Match device</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Panel>
        {!inShell() && (
          <Panel title="Apps" description="Windows and Android installers, and an iPhone build for AltStore or SideStore. On iPhone you can also open this site in Safari and use Share, then Add to Home Screen.">
            <Button variant="outline" onClick={() => openExternal(APP_DOWNLOADS)}><Download />Download DevDash</Button>
          </Panel>
        )}
        <div className="border-t pt-6 lg:pl-[calc(17rem+3rem)]"><Button variant="destructive" onClick={() => void signOut()}><LogOut />Sign out</Button></div>
      </PageBody>
    </>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.api.auth.password.$post({ json: { current, next } })),
    onSuccess: (r) => {
      setCurrent('')
      setNext('')
      toast.success(r.signedOutSessions ? `Password changed. Signed out ${r.signedOutSessions} other ${r.signedOutSessions === 1 ? 'device' : 'devices'}.` : 'Password changed.')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (current && next) change.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <input type="hidden" autoComplete="username" />
        <Field>
          <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
          <Input id="pw-current" type="password" autoComplete="current-password" required className="h-10" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="pw-next">New password</FieldLabel>
          <Input id="pw-next" type="password" autoComplete="new-password" required className="h-10" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <ErrorAlert error={change.error} />
        <div><Button type="submit" disabled={!current || !next || change.isPending}>Change password</Button></div>
      </FieldGroup>
    </form>
  )
}

function ServerPasswordForm() {
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [code, setCode] = useState('')
  const set = useMutation({
    mutationFn: () => unwrap(api.api.terminals.admin.password.$post({ json: { password, currentPassword: current, code } })),
    onSuccess: () => {
      setPassword('')
      setCurrent('')
      setCode('')
      toast.success('Server password set. Use it when sudo asks.')
    },
    onError: () => setCode(''),
  })
  const ready = password.length >= 8 && current && code.length === 6
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) set.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="sp-new">New server password</FieldLabel>
          <Input id="sp-new" type="password" autoComplete="new-password" required className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="sp-current">Your DevDash password</FieldLabel>
          <Input id="sp-current" type="password" autoComplete="current-password" required className="h-10" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="sp-code">Code from your authenticator</FieldLabel>
          <CodeInput id="sp-code" value={code} onChange={setCode} />
        </Field>
        <ErrorAlert error={set.error} />
        <div><Button type="submit" disabled={!ready || set.isPending}>Set server password</Button></div>
      </FieldGroup>
    </form>
  )
}

function EmailForm() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.api.auth.email.$post({ json: { email, password } })),
    onSuccess: (r) => {
      qc.setQueryData(meQuery.queryKey, r.user)
      setEmail('')
      setPassword('')
      toast.success('Email changed.')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (email && password) change.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="em-new">New email</FieldLabel>
          <Input id="em-new" type="email" autoComplete="email" required className="h-10" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="em-pw">Current password</FieldLabel>
          <Input id="em-pw" type="password" autoComplete="current-password" required className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorAlert error={change.error} />
        <div><Button type="submit" disabled={!email || !password || change.isPending}>Change email</Button></div>
      </FieldGroup>
    </form>
  )
}
