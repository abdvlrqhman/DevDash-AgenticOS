import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BellRing } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { looking, useTopic } from '@/lib/live'
import { disableIosPush, enableIosPush, iosPushActive, iosPushApp, iosPushState, syncIosPush, type IosPushState } from '@/lib/ios-push'
import { disablePush, enablePush, needsHomeScreen, pushEnabled, pushSupported } from '@/lib/push'
import { backgroundOff, inIosShell, inShell, notificationPermission, setBackgroundNotifications, syncBackgroundNotifications } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'
import { deliver } from './deliver'

type Event = { notification: { title: string; body: string; url: string } }

/** Shows notifications as they happen: a toast while you're looking, a system notification from the native app otherwise. */
export function useNotificationEvents() {
  const navigate = useNavigate()
  useEffect(() => void syncBackgroundNotifications().then(syncIosPush), [])
  useTopic('notifications', (e) => {
    const n = (e as unknown as Event).notification
    const open = { label: 'Open', onClick: () => void navigate({ to: n.url }) }
    switch (deliver({
      looking: looking(),
      onPage: location.pathname === n.url,
      // The device's own pushes show it: Android's background connection, or Apple push in the iPhone app.
      backgroundPush: !!window.DevDashAndroid?.backgroundNotifications() || iosPushActive(),
      nativeNotify: !!window.devdashShell?.notify, // the Tauri shell (desktop/iOS) posts a native OS notification
    })) {
      case 'native':
        window.devdashShell?.notify?.(n.title, n.body || '') // guarded: a missing bridge never throws
        break
      case 'toast':
        toast(n.title, { description: n.body || undefined, action: open })
        break
      // A browser that isn't being looked at gets Web Push from the server; the toast waits for whoever comes back.
      case 'toast-sticky':
        toast(n.title, { description: n.body || undefined, duration: Infinity, closeButton: true, action: open })
        break
      case 'none':
        break
    }
  })
}

type Prefs = { needs_you: boolean; finished: boolean; errors: boolean; shared: boolean }
const KINDS: { key: keyof Prefs; label: string; description: string }[] = [
  { key: 'needs_you', label: 'Claude needs you', description: 'A question, a plan to approve, or a permission to grant.' },
  { key: 'finished', label: 'Claude finished', description: 'A reply or task is done.' },
  { key: 'errors', label: 'Claude stopped with an error', description: 'Usage limits, sign-in problems, crashes.' },
  { key: 'shared', label: 'Shared with you', description: 'A teammate shares a Claude session, asks to join yours, or comments on it.' },
]

export function NotificationsPanel() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['notifications', 'prefs'], queryFn: () => unwrap(api.api.notifications.prefs.$get()) })
  const save = useMutation({
    mutationFn: (p: Prefs) => unwrap(api.api.notifications.prefs.$put({ json: p })),
    onSuccess: (r) => qc.setQueryData(['notifications', 'prefs'], (old: typeof q.data) => old && { ...old, prefs: r.prefs }),
  })
  // In the native app the server test would just toast (you're looking at this screen), so also fire a real system
  // notification through the shell bridge — that exercises the device's native path and shows whether it actually works.
  // Not on an iPhone getting Apple push: the test itself arrives through Apple, which is the path worth checking.
  const nativeTest = inShell() && !!window.devdashShell?.notify && !iosPushActive()
  const test = useMutation({
    mutationFn: async () => {
      await unwrap(api.api.notifications.test.$post())
      if (nativeTest) window.devdashShell!.notify!('DevDash', 'Test notification — this is how it looks on this device.')
    },
    onSuccess: () => toast.success(iosPushActive()
      ? 'Sent through Apple. It shows on this iPhone in a moment, the same way it will when the app is closed.'
      : nativeTest
        ? 'Sent. Check for a system notification on this device — if none appears, allow DevDash in your phone’s Settings → Notifications.'
        : 'Test sent. It shows on every device where notifications are on.'),
  })
  const prefs = q.data?.prefs

  return (
    <FieldGroup>
      <ThisDevice publicKey={q.data?.publicKey} apns={q.data?.apns} />
      <Separator />
      <ErrorAlert error={q.error ?? save.error} />
      {KINDS.map((k) => (
        <Field key={k.key} orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`n-${k.key}`}>{k.label}</FieldLabel>
            <FieldDescription>{k.description}</FieldDescription>
          </FieldContent>
          <Switch id={`n-${k.key}`} disabled={!prefs} checked={prefs?.[k.key] ?? false}
            onCheckedChange={(v) => prefs && save.mutate({ ...prefs, [k.key]: v })} />
        </Field>
      ))}
      <ErrorAlert error={test.error} />
      <div><Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}><BellRing />Send a test notification</Button></div>
    </FieldGroup>
  )
}

/** What reaches the iPhone app while it's closed, and if nothing does, why. */
function iosNote(push: IosPushState | null | undefined, apns: boolean | undefined) {
  if (push === undefined) return 'Arrive while the app is open. Checking whether they can arrive while it’s closed…'
  if (push?.token && apns) return 'Arrive even when the app is closed.'
  return 'Arrive while the app is open. For notifications while it’s closed, turn on ntfy below.'
}

/** Turns notifications on for the device in hand: Web Push in browsers, system permission (and Apple push) in the app. */
function ThisDevice({ publicKey, apns }: { publicKey?: string; apns?: boolean }) {
  const shell = inShell()
  const native = shell && !!window.devdashShell?.notificationPermission
  const android = !!window.DevDashAndroid
  const ios = iosPushApp()
  const [on, setOn] = useState<boolean | null>(null)
  const [push, setPush] = useState<IosPushState | null | undefined>(undefined) // undefined: not known yet
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (android) void notificationPermission(false).then((s) => setOn(s === 'granted' && window.DevDashAndroid!.backgroundNotifications()))
    else if (ios) {
      void notificationPermission(false).then((s) => setOn(s === 'granted' && !backgroundOff()))
      void iosPushState().then(setPush)
    } else if (native) void notificationPermission(false).then((s) => setOn(s === 'granted'))
    else if (pushSupported()) void pushEnabled().then(setOn, () => setOn(false))
  }, [native])
  // The app's answer can come later than this screen, or change.
  useEffect(() => {
    if (!ios) return
    const changed = () => setPush(window.__devdashPushState ?? null)
    window.addEventListener('devdash-push', changed)
    return () => window.removeEventListener('devdash-push', changed)
  }, [ios])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e as Error) } finally { setBusy(false) }
  }
  const enable = () => run(async () => {
    if (ios) {
      const r = await enableIosPush()
      setPush(r.state)
      setOn(true)
    } else if (native) {
      const s = await notificationPermission(true)
      if (s !== 'granted') throw new Error('Notifications are off for DevDash. Turn them on in your phone’s settings, then come back.')
      setBackgroundNotifications(true)
      setOn(true)
      window.devdashShell?.notify?.('DevDash', 'Notifications are on for this device.') // the real system path, not a toast
    } else {
      await enablePush(publicKey!)
      setOn(true)
    }
  })
  const disable = () => run(async () => {
    if (android) setBackgroundNotifications(false)
    else if (ios) await disableIosPush()
    else await disablePush()
    setOn(false)
  })

  let body
  if (shell && !native) body = <FieldDescription>Update the DevDash app to get notifications on this device.</FieldDescription>
  else if (!shell && needsHomeScreen()) body = <FieldDescription>On iPhone, notifications work once DevDash is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.</FieldDescription>
  else if (!native && !pushSupported()) body = <FieldDescription>This browser can't show notifications. Use the DevDash app, or Chrome, Edge, Firefox or Safari.</FieldDescription>
  else body = (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="n-device">Notifications on this device</FieldLabel>
        <FieldDescription>
          {android ? 'Arrive even when the app is closed. Android keeps a quiet “DevDash is connected” notification for that.'
            : ios ? iosNote(push, apns)
            : inIosShell() ? 'Arrive while the app is open. For notifications when it’s closed, open this site in Safari, tap Share, then Add to Home Screen, and turn them on there.'
            : native ? 'Arrive while the app is open or in the background.' : 'Arrive even when DevDash is closed.'} You won't get them twice: while you're using DevDash somewhere, they show inside it.
        </FieldDescription>
      </FieldContent>
      <Switch id="n-device" disabled={on === null || busy || (native && !android && !ios && on)} checked={!!on}
        onCheckedChange={(v) => void (v ? enable() : disable())} />
    </Field>
  )
  return (
    <>
      {body}
      <ErrorAlert error={error} />
    </>
  )
}
