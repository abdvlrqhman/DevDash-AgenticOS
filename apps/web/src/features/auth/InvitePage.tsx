import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Check, Copy, Download, ExternalLink } from 'lucide-react'
import QRCode from 'qrcode'
import { Logo } from '@/components/app/brand'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, meQuery, unwrap } from '@/lib/api'
import { downloadBlob } from '@/lib/download'
import { AuthLayout, CodeInput, ErrorAlert } from './LoginPage'

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' })
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => unwrap(api.api.auth.invites[':token'].$get({ param: { token } })),
    retry: false,
    staleTime: Infinity,
  })
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  return (
    <AuthLayout>
      <div className="mb-6 flex justify-center"><Logo size={44} /></div>
      {invite.isPending && <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />Checking your invite…</p>}
      {invite.isError && (
        <div className="flex flex-col gap-3 text-center">
          <h1 className="text-xl font-semibold tracking-tight">This invite can't be used</h1>
          <ErrorAlert error={invite.error} />
        </div>
      )}
      {invite.data && !backupCodes && <AcceptForm token={token} invite={invite.data} onDone={setBackupCodes} />}
      {backupCodes && <BackupCodes codes={backupCodes} space={invite.data?.spaceName ?? 'DevDash'} />}
    </AuthLayout>
  )
}

type Invite = { email: string; username: string; role: string; spaceName: string; totpSecret: string; totpUri: string }

function AcceptForm({ token, invite, onDone }: { token: string; invite: Invite; onDone: (codes: string[]) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => { QRCode.toDataURL(invite.totpUri, { margin: 1, width: 320 }).then(setQr) }, [invite.totpUri])

  const accept = useMutation({
    mutationFn: () => unwrap(api.api.auth.invites[':token'].$post({ param: { token }, json: { name, password, code } })),
    onSuccess: (r) => {
      qc.setQueryData(meQuery.queryKey, r.user)
      onDone(r.backupCodes)
    },
    onError: () => setCode(''),
  })
  const ready = name.trim() && password && code.length === 6
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !accept.isPending) accept.mutate()
  }

  return (
    <>
      <div className="mb-5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Join {invite.spaceName}</h1>
        <p className="text-sm text-muted-foreground">
          You'll sign in as <span className="font-medium text-foreground">{invite.username}</span> or {invite.email}
          {invite.role === 'admin' && <Badge variant="secondary" className="ml-1.5 align-middle">Admin</Badge>}
        </p>
      </div>
      <form onSubmit={submit} className="rounded-xl border bg-card p-5 shadow-xs md:p-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Your name</FieldLabel>
            <Input id="name" autoComplete="name" required className="h-10" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <input type="hidden" autoComplete="username" value={invite.email} readOnly />
            <Input id="password" type="password" autoComplete="new-password" required className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <FieldSeparator>Two-step sign-in</FieldSeparator>
          <Field>
            <FieldDescription>Add this space to an authenticator app (Google Authenticator, 1Password, Aegis…), then enter the 6-digit code it shows.</FieldDescription>
            <Button asChild variant="outline" className="h-10 md:hidden">
              <a href={invite.totpUri}><ExternalLink />Add to authenticator app</a>
            </Button>
            {qr && <img src={qr} alt="QR code for your authenticator app" className="mx-auto hidden size-40 rounded-lg bg-white p-1.5 md:block" />}
            <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
              <code className="flex-1 font-mono text-xs break-words text-muted-foreground">{invite.totpSecret.match(/.{1,4}/g)!.join(' ')}</code>
              <Button type="button" size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(invite.totpSecret).then(() => setCopied(true))}>
                {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy key'}
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="otp">Code from the app</FieldLabel>
            <CodeInput id="otp" value={code} onChange={setCode} />
          </Field>
          <ErrorAlert error={accept.error} />
          <Button type="submit" size="lg" className="h-10 w-full" disabled={!ready || accept.isPending}>
            {accept.isPending && <Spinner />}Create account
          </Button>
        </FieldGroup>
      </form>
    </>
  )
}

function BackupCodes({ codes, space }: { codes: string[]; space: string }) {
  const navigate = useNavigate()
  const [saved, setSaved] = useState(false)
  const text = `${space} backup codes. Each code works once.\n\n${codes.join('\n')}\n`
  const download = () => {
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${space.toLowerCase().replace(/\W+/g, '-')}-backup-codes.txt`)
    setSaved(true)
  }
  return (
    <>
      <div className="mb-5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Save your backup codes</h1>
        <p className="text-sm text-muted-foreground">If you lose your phone, each code signs you in once. You won't see them again.</p>
      </div>
      <div className="rounded-xl border bg-card p-5 shadow-xs">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-10" onClick={download}><Download />Download</Button>
          <Button variant="outline" className="h-10" onClick={() => navigator.clipboard.writeText(text).then(() => setSaved(true))}><Copy />Copy</Button>
        </div>
        <Button size="lg" className="mt-3 h-10 w-full" disabled={!saved} onClick={() => navigate({ to: '/' })}>
          {saved ? 'Continue to DevDash' : 'Download or copy the codes first'}
        </Button>
      </div>
    </>
  )
}
