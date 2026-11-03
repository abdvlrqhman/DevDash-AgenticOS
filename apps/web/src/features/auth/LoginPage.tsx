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
    <div className="h-full overflow-y-auto bg-background">
      <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}

/** What went wrong, in the server's own words, on a soft destructive tone (no box lines). Used across the app. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <Alert variant="destructive" className="rounded-xl border-0 bg-destructive/10 px-3.5 py-2.5 dark:bg-destructive/15">
      <AlertCircle />
      <AlertDescription className="text-pretty">{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  )
}

/** Fields on the sign-in panels sit a tone off it (the ground's), so no outline is needed until one is focused. */
export const authInput = 'h-10 border-transparent bg-background dark:bg-background'
export const authSlot = 'border-transparent bg-background dark:bg-background'

/** Six one-digit cells; one real input underneath, so autofill and paste work. */
export function CodeInput({ id, value, onChange, autoFocus, slotClassName }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; slotClassName?: string }) {
  return (
    <InputOTP id={id} maxLength={6} pattern={REGEXP_ONLY_DIGITS} value={value} onChange={onChange} autoComplete="one-time-code"
      autoFocus={autoFocus} containerClassName="w-full">
      <InputOTPGroup className="grid w-full grid-cols-6 gap-2 *:data-[slot=input-otp-slot]:h-11 *:data-[slot=input-otp-slot]:w-full *:data-[slot=input-otp-slot]:rounded-xl *:data-[slot=input-otp-slot]:border *:data-[slot=input-otp-slot]:text-base *:data-[slot=input-otp-slot]:tabular-nums">
        {Array.from({ length: 6 }, (_, i) => <InputOTPSlot key={i} index={i} className={slotClassName} />)}
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
      {/* The space's name is the one big thing: you know where you're signing in. */}
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <Logo size={48} />
        <div className="flex flex-col gap-1">
          <h1 className="text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">Sign in to {space.data?.name ?? 'DevDash'}</h1>
          <p className="text-sm text-muted-foreground">{location.host}</p>
        </div>
      </div>
      <form onSubmit={submit} className="rounded-2xl bg-surface p-5 md:p-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="login">Email or username</FieldLabel>
            <Input id="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required className={authInput}
              value={login} onChange={(e) => setLogin(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input id="password" type="password" autoComplete="current-password" required className={authInput}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {useBackup ? (
            <Field>
              <FieldLabel htmlFor="backup">Backup code</FieldLabel>
              <Input id="backup" autoComplete="off" spellCheck={false} className={`${authInput} font-mono uppercase`}
                value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <FieldDescription>Each backup code works once.</FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="otp">Code from your authenticator</FieldLabel>
              <CodeInput id="otp" value={code} onChange={setCode} slotClassName={authSlot} />
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
