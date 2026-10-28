import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { AlertCircle } from 'lucide-react'
import { Logo } from '@/components/app/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { api, meQuery, spaceQuery, unwrap } from '@/lib/api'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-muted/40">
      <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  )
}

/** Six one-digit cells; one real input underneath, so autofill and paste work. */
export function CodeInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <InputOTP id={id} maxLength={6} pattern={REGEXP_ONLY_DIGITS} value={value} onChange={onChange} autoComplete="one-time-code"
      autoFocus={autoFocus} containerClassName="w-full">
      <InputOTPGroup className="grid w-full grid-cols-6 gap-2 *:data-[slot=input-otp-slot]:h-11 *:data-[slot=input-otp-slot]:w-full *:data-[slot=input-otp-slot]:rounded-md *:data-[slot=input-otp-slot]:border *:data-[slot=input-otp-slot]:text-base">
        {Array.from({ length: 6 }, (_, i) => <InputOTPSlot key={i} index={i} />)}
      </InputOTPGroup>
    </InputOTP>
  )
}

export function LoginPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const space = useQuery(spaceQuery)
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [remember, setRemember] = useState(true)

  const signIn = useMutation({
    mutationFn: () => unwrap(api.api.auth.login.$post({ json: { login, password, code, remember } })),
    onSuccess: ({ user }) => {
      qc.setQueryData(meQuery.queryKey, user)
      navigate({ to: '/' })
    },
    onError: () => setCode(''),
  })

  const ready = login.trim() && password && (useBackup ? code.replace(/\W/g, '').length >= 16 : code.length === 6)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !signIn.isPending) signIn.mutate()
  }

  return (
    <AuthLayout>
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <Logo size={44} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to {space.data?.name ?? 'DevDash'}</h1>
          <p className="text-sm text-muted-foreground">{location.host}</p>
        </div>
      </div>
      <form onSubmit={submit} className="rounded-xl border bg-card p-5 shadow-xs md:p-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="login">Email or username</FieldLabel>
            <Input id="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required className="h-10"
              value={login} onChange={(e) => setLogin(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input id="password" type="password" autoComplete="current-password" required className="h-10"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {useBackup ? (
            <Field>
              <FieldLabel htmlFor="backup">Backup code</FieldLabel>
              <Input id="backup" autoComplete="off" spellCheck={false} className="h-10 font-mono uppercase"
                value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <FieldDescription>Each backup code works once.</FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="otp">Code from your authenticator</FieldLabel>
              <CodeInput id="otp" value={code} onChange={setCode} />
            </Field>
          )}
          <Field orientation="horizontal">
            <Switch id="remember" checked={remember} onCheckedChange={setRemember} />
            <FieldLabel htmlFor="remember" className="font-normal">Remember this device for 30 days</FieldLabel>
          </Field>
          <ErrorAlert error={signIn.error} />
          <Button type="submit" size="lg" className="h-10 w-full" disabled={!ready || signIn.isPending}>
            {signIn.isPending && <Spinner />}Sign in
          </Button>
          <Button type="button" variant="link" className="h-auto p-0 text-muted-foreground" onClick={() => { setUseBackup(!useBackup); setCode('') }}>
            {useBackup ? 'Use my authenticator instead' : 'Use a backup code'}
          </Button>
        </FieldGroup>
      </form>
      <p className="mt-5 text-center text-xs text-muted-foreground">Invite only. Ask an admin of this space for a link.</p>
    </AuthLayout>
  )
}
