import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LogOut } from 'lucide-react'
import { toast } from '@/lib/toast'
import { PageBody, PageHeader } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { membersQuery, UserAvatar } from '@/components/app/user-avatar'
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

/**
 * A settings group: what it is on the left (wide screens), its controls on a panel to the right; stacked on phones.
 * Outline buttons are surface pills, so on the panel they step down to the ground tone and still read as buttons.
 */
function Panel({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-12">
      <div className="min-w-0 lg:pt-5">
        <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
        {description && <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4 self-start rounded-2xl bg-surface p-4 md:p-5 [&_[data-variant=outline]]:bg-background [&_[data-variant=outline]:hover]:bg-surface-2">
        {children}
      </div>
    </section>
  )
}

/**
 * Who you are, and your picture: choose, change or remove it. You pick the square to show (AvatarCrop); only that,
 * shrunk, uploads.
 */
function Profile() {
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
  // The picture leads the page (the one big thing on it); changing it sits right under who you are.
  return (
    <header className="flex items-start gap-4 md:gap-6">
      <UserAvatar user={me} className="size-16 md:size-24" textClassName="text-xl md:text-2xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:pt-1">
        <h1 className="truncate text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] md:text-[2.25rem]">{me.name}</h1>
        <p className="text-[15px] text-muted-foreground"><span>{me.username}</span>, <span className="break-all">{me.email}</span></p>
        <p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">
          {me.role === 'admin' ? 'Admin' : 'Member'}. You can sign in with your email or your username, and your picture shows wherever DevDash shows who you are.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <input ref={input} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPicked(f) }} />
          <Button size="sm" variant="outline" onClick={() => input.current?.click()}>{has ? 'Change picture' : 'Choose a picture'}</Button>
          {has && <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>}
        </div>
      </div>
      <AvatarCropDialog file={picked} saving={upload.isPending} onCancel={() => setPicked(null)}
        onPickAnother={() => input.current?.click()} onSave={(picture) => upload.mutate(picture)} />
    </header>
  )
}

export function AccountPage() {
  const me = useQuery(meQuery).data!
  const signOut = useSignOut()
  const theme = useTheme()

  return (
    <>
      <PageHeader title="Account" />
      <PageBody className="gap-12 py-8 md:py-12">
        <Profile />
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
          <ToggleGroup type="single" spacing={1} value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)} aria-label="Appearance"
            className="w-full rounded-full bg-background p-1 sm:w-fit">
            <ToggleGroupItem value="system" className="min-w-fit flex-1 rounded-full px-4">Match device</ToggleGroupItem>
            <ToggleGroupItem value="light" className="min-w-fit flex-1 rounded-full px-4">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark" className="min-w-fit flex-1 rounded-full px-4">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Panel>
        {!inShell() && (
          <Panel title="Apps" description="Windows and Android installers, and an iPhone build for AltStore or SideStore. On iPhone you can also open this site in Safari and use Share, then Add to Home Screen.">
            <div><Button variant="outline" onClick={() => openExternal(APP_DOWNLOADS)}><Download />Download DevDash</Button></div>
          </Panel>
        )}
        <div className="lg:pl-[calc(17rem+3rem)]"><Button variant="destructive" onClick={() => void signOut()}><LogOut />Sign out</Button></div>
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
