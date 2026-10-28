import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

const APP_STORE = 'https://apps.apple.com/app/ntfy/id1625396347'
const statusQuery = { queryKey: ['notifications', 'ntfy'], queryFn: () => unwrap(api.api.notifications.ntfy.$get()) }

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  return (
    <div className="flex items-center gap-2">
      <Input readOnly aria-label={label} value={value} className="h-10 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" size="icon" className="size-10 shrink-0" aria-label={`Copy ${label}`} onClick={copy}>{copied ? <Check /> : <Copy />}</Button>
    </div>
  )
}

/**
 * Notifications on a phone whose DevDash app can't get them while it's closed (an iPhone app installed with a
 * sideloading service), through the free ntfy app, which has its own Apple push. Server: notifications/ntfy.ts.
 */
export function NtfyPanel() {
  const qc = useQueryClient()
  const q = useQuery(statusQuery)
  const s = q.data
  const [advanced, setAdvanced] = useState(false)
  const [server, setServer] = useState('')
  const [token, setToken] = useState('')
  const set = (r: NonNullable<typeof s>) => qc.setQueryData(statusQuery.queryKey, r)
  const configure = useMutation({
    mutationFn: (v: { server?: string; token?: string | null; newTopic?: boolean }) => unwrap(api.api.notifications.ntfy.$put({ json: v })),
    onSuccess: (r) => { set(r); setToken('') },
    onError: (e) => toast.error(e.message),
  })
  const off = useMutation({ mutationFn: () => unwrap(api.api.notifications.ntfy.$delete()), onSuccess: set, onError: (e) => toast.error(e.message) })
  const test = useMutation({
    mutationFn: () => unwrap(api.api.notifications.ntfy.test.$post()),
    onSuccess: (r) => {
      void q.refetch()
      if (r.ok) toast.success('Sent to ntfy. It should show on your phone in a moment.')
      else toast.error(r.error ?? 'ntfy refused it.')
    },
    onError: (e) => toast.error(e.message),
  })

  if (!s) return <ErrorAlert error={q.error} />
  if (!s.enabled) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          For an iPhone whose DevDash app is installed with a sideloading app: real-time notifications even while DevDash is
          closed, through the free <b className="text-foreground">ntfy</b> app. Tapping one opens the right page.
        </p>
        <Button className="self-start" disabled={configure.isPending} onClick={() => configure.mutate({})}><BellRing />Turn on ntfy notifications</Button>
      </div>
    )
  }

  const custom = s.server !== 'https://ntfy.sh'
  const saveAdvanced = (e: FormEvent) => {
    e.preventDefault()
    configure.mutate({ server: server.trim() || 'https://ntfy.sh', ...(token.trim() && { token: token.trim() }) })
  }
  return (
    <FieldGroup>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
        <li>Install <button type="button" className="text-foreground underline underline-offset-4" onClick={() => openExternal(APP_STORE)}>ntfy from the App Store</button> on your iPhone and allow its notifications.</li>
        <li>
          In ntfy, tap <b className="text-foreground">+</b>, enter this topic{custom ? <>, turn on <b className="text-foreground">Use another server</b> and enter {s.server}</> : null}, and subscribe:
          <div className="mt-2"><CopyValue label="topic" value={s.topic!} /></div>
        </li>
        <li>Send a test below. From then on, what DevDash would notify you about arrives there too — not while you're using DevDash.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}><BellRing />Send a test to ntfy</Button>
        <Button variant="ghost" onClick={() => openExternal(s.subscribeUrl!)}><ExternalLink />Open the topic in a browser</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {s.lastError ? <span className="text-destructive">Last try failed: {s.lastError}</span>
          : s.lastOkAt ? `Last delivered ${new Date(s.lastOkAt * 1000).toLocaleString()}.` : 'Nothing sent yet.'}
      </p>
      <p className="text-xs text-muted-foreground">
        Keep the topic private: on {custom ? 'a public ntfy server' : 'ntfy.sh, a public service,'} anyone who knows it can read these
        notifications, which pass through that server. Tapping one opens DevDash in Safari.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={configure.isPending} onClick={() => configure.mutate({ newTopic: true })}><RefreshCw />New topic</Button>
        <Button size="sm" variant="ghost" onClick={() => { setServer(custom ? s.server : ''); setAdvanced((a) => !a) }}>{advanced ? 'Hide' : 'Use'} your own ntfy server</Button>
        <Button size="sm" variant="ghost" disabled={off.isPending} onClick={() => off.mutate()}>Turn off</Button>
      </div>
      {advanced && (
        <form onSubmit={saveAdvanced}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ntfy-server">Server</FieldLabel>
              <Input id="ntfy-server" className="h-10 font-mono text-xs" placeholder="https://ntfy.sh" value={server} onChange={(e) => setServer(e.target.value)} />
              <FieldDescription>A server your team runs keeps notification text off ntfy.sh (with upstream-base-url set, iPhones still get them instantly).</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ntfy-token">Access token (optional)</FieldLabel>
              <Input id="ntfy-token" type="password" className="h-10 font-mono text-xs" placeholder={s.hasToken ? 'Saved — paste a new one to replace it' : 'tk_…'} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
              <FieldDescription>For a server where publishing needs one. Encrypted on the DevDash server and never shown again.</FieldDescription>
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={configure.isPending}>Save</Button>
              {s.hasToken && <Button type="button" size="sm" variant="ghost" onClick={() => configure.mutate({ token: null })}>Remove token</Button>}
            </div>
          </FieldGroup>
        </form>
      )}
    </FieldGroup>
  )
}
