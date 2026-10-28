import { useEffect, useRef, useState, type FormEvent } from 'react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { InferResponseType } from 'hono/client'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, meQuery, spaceQuery, unwrap } from '@/lib/api'
import { inShell, openExternal } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

const statusQuery = queryOptions({ queryKey: ['storage'], queryFn: () => unwrap(api.api.storage.$get()) })
const appQuery = queryOptions({ queryKey: ['storage', 'app'], queryFn: () => unwrap(api.api.storage.google.app.$get()) })

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`

/** Each member's own Google Drive, for the big files their Claude sessions make. */
export function StoragePage() {
  const me = useQuery(meQuery).data!
  const [waiting, setWaiting] = useState(false) // Google is open in the system browser (native app): watch for the result
  const q = useQuery({ ...statusQuery, refetchInterval: waiting ? 3000 : false })
  const s = q.data
  useEffect(() => {
    if (waiting && s?.connected && !s.broken) {
      setWaiting(false)
      toast.success('Google Drive connected')
    }
  }, [waiting, s?.connected, s?.broken])

  return (
    <>
      <PageHeader
        title="Storage"
        description="Your own Google Drive for big files, so Claude can keep videos and renders off the server"
        actions={<Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void q.refetch()}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} /></Button>}
      />
      <PageBody>
        {!s ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <>
            {!s.configured ? (
              <SettingsSection title="Google Drive" description="Not set up for this space yet.">
                <p className="text-sm text-muted-foreground">
                  {me.role === 'admin' ? 'Register the space’s Google app below first; then everyone can connect their own Drive.' : 'An admin needs to register the space’s Google app once. Ask one of them.'}
                </p>
              </SettingsSection>
            ) : s.connected ? (
              <Connected s={s} onReconnect={() => setWaiting(inShell())} />
            ) : (
              <SettingsSection title="Connect your Google Drive" description="Claude sessions you start — in every Claude profile — and your terminals get it as the rclone remote drive:, so big outputs leave the server's disk.">
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  <li>DevDash makes a <span className="text-foreground">DevDash</span> folder in your Drive and only ever sees what it puts there — never the rest of your Drive.</li>
                  <li>Your Google sign-in stays on the DevDash server; your sessions get a link you can cut off here at any time.</li>
                  <li>Free Google accounts have 15 GB, shared with Gmail and Photos. Videos fill that quickly.</li>
                </ul>
                <ConnectButton label="Connect Google Drive" onWaiting={() => setWaiting(true)} />
                {waiting && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Finish on Google in your browser; this page updates by itself.</p>}
              </SettingsSection>
            )}
            {s.connected && <HowClaudeUsesIt />}
            {me.role === 'admin' && <GoogleApp />}
          </>
        )}
      </PageBody>
    </>
  )
}

/** Sends the browser to Google's consent page. The native app opens it in the system browser (Google refuses web views). */
function ConnectButton({ label, variant = 'default', onWaiting }: { label: string; variant?: 'default' | 'outline'; onWaiting: () => void }) {
  const connect = useMutation({
    mutationFn: () => unwrap(api.api.storage.google.connect.$post()),
    onSuccess: ({ url }) => {
      if (inShell()) {
        openExternal(url)
        onWaiting()
      } else {
        window.location.assign(url)
      }
    },
    onError: (e) => toast.error(e.message),
  })
  return <Button variant={variant} className="self-start" disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? 'Opening Google…' : label}</Button>
}

type Status = InferResponseType<typeof api.api.storage.$get>

function Connected({ s, onReconnect }: { s: Status; onReconnect: () => void }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.api.storage.disconnect.$post()),
    onSuccess: () => { toast.success('Google Drive disconnected'); setConfirm(false); void qc.invalidateQueries({ queryKey: ['storage'] }) },
    onError: (e) => toast.error(e.message),
  })
  const used = s.quota && s.quota.limit ? Math.min(100, (s.quota.used / s.quota.limit) * 100) : null
  return (
    <SettingsSection title="Your Google Drive" description={s.account ?? undefined}>
      {s.broken && (
        <Alert variant="destructive">
          <AlertTitle>Not working right now</AlertTitle>
          <AlertDescription>{s.broken}</AlertDescription>
        </Alert>
      )}
      {s.broken && <ConnectButton label="Connect again" onWaiting={onReconnect} />}
      {s.quota && (
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <span>{gb(s.quota.used)} used</span>
            <span className="text-muted-foreground">{s.quota.limit ? `of ${gb(s.quota.limit)}` : 'no limit'}</span>
          </div>
          {used !== null && (
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100}>
              <div className={`h-full rounded-full ${used > 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${used}%` }} />
            </div>
          )}
          <span className="text-xs text-muted-foreground">Your whole Google account (Drive, Gmail and Photos together).</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {s.folderUrl && <Button variant="outline" asChild><a href={s.folderUrl} target="_blank" rel="noreferrer"><ExternalLink />Open the DevDash folder</a></Button>}
        {confirm ? (
          <>
            <Button variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirm(true)}>Disconnect</Button>
        )}
      </div>
      {confirm && <p className="text-xs text-muted-foreground">Your files stay in your Drive. Sessions lose the drive: remote and DevDash's access is revoked at Google.</p>}
    </SettingsSection>
  )
}

function HowClaudeUsesIt() {
  return (
    <SettingsSection title="How Claude uses it" description="Every session you start knows the rule and applies it on its own — you don't have to ask. You can also use drive: yourself in a terminal.">
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li><span className="text-foreground">Goes to your Drive:</span> anything heavy (about 100 MB or more, or lots of files adding up) the work doesn't need on the server — videos, audio, renders and image sets, exported builds (APK, IPA, zips), datasets and big downloads once used, recordings, backups, dumps and archives.</li>
        <li><span className="text-foreground">Stays on the server:</span> what the work runs on — code and git repos, node_modules, SDKs, caches, databases in use, files a service serves. Secrets (.env, keys) never leave.</li>
        <li><span className="text-foreground">When and where:</span> as soon as something heavy is finished, into a folder per project (<code>drive:my-app/videos/</code>, <code>drive:my-app/builds/</code>), and Claude tells you the path and a share link.</li>
      </ul>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">{[
        'rclone move render.mp4 drive:my-app/videos/   # off the server once uploaded',
        'rclone move dist/ drive:my-app/builds/dist    # a whole folder',
        'tar czf frames.tgz frames/                    # many small files: archive first',
        'rclone lsf drive:my-app/                      # what is there',
        'rclone copy drive:my-app/data/set.csv .       # bring one back',
        'rclone link drive:my-app/videos/render.mp4    # a link to open or send',
        'rclone about drive:                           # free space',
      ].join('\n')}</pre>
      <p className="text-xs text-muted-foreground">Files you add to the folder yourself in Google Drive aren't visible to DevDash: it can only see what it created.</p>
    </SettingsSection>
  )
}

/** A read-only value with a copy button (addresses to paste into Google Cloud). */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  return (
    <div className="flex items-center gap-2">
      <Input readOnly aria-label={label} value={value} className="h-10 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" size="icon" className="size-10 shrink-0" aria-label={`Copy ${label}`} onClick={copy}>{copied ? <Check /> : <Copy />}</Button>
    </div>
  )
}

const link = 'text-foreground underline underline-offset-4'

/** Admins register the space's Google OAuth app once (Google Cloud console), following Google's own checklist. */
function GoogleApp() {
  const qc = useQueryClient()
  const app = useQuery(appQuery).data
  const space = useQuery(spaceQuery).data
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [contact, setContact] = useState('')
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    if (app?.clientId) setClientId(app.clientId)
    if (app?.contactEmail) setContact(app.contactEmail)
  }, [app?.clientId, app?.contactEmail])
  const save = useMutation({
    mutationFn: () => unwrap(api.api.storage.google.app.$put({ json: { clientId, contactEmail: contact.trim(), ...(secret.trim() && { clientSecret: secret }) } })),
    onSuccess: () => { toast.success('Google app saved'); setSecret(''); setError(null); void qc.invalidateQueries({ queryKey: ['storage'] }) },
    onError: (e) => setError(e),
  })
  if (!app) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  const domain = new URL(app.homeUrl).hostname.split('.').slice(-2).join('.') // dev.example.com → example.com
  return (
    <SettingsSection title="Google app (admins)" description="One Google OAuth app for the whole space; each member connects their own Drive with it. Only admins see this.">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
        <li>In <a className={link} href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud</a>, create a project and enable the <a className={link} href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a>.</li>
        <li>Google Auth Platform → <b className="text-foreground">Data access</b>: add only <code>openid</code>, <code>…/auth/userinfo.email</code> and <code>…/auth/drive.file</code> (all non-sensitive).</li>
        <li>
          <b className="text-foreground">Branding</b>: app name <b className="text-foreground">{space?.name ?? 'DevDash'}</b> (the same name the pages below show), your support email, no logo (a logo needs extra review), the authorized domain <b className="text-foreground">{domain}</b>, and these two public pages, which explain the app without signing in:
          <div className="mt-2 flex flex-col gap-2">
            <span className="text-xs">Application home page</span>
            <CopyField label="home page address" value={app.homeUrl} />
            <span className="text-xs">Privacy policy</span>
            <CopyField label="privacy policy address" value={app.privacyUrl} />
          </div>
        </li>
        <li><b className="text-foreground">Audience</b>: External, then <b className="text-foreground">Publish app</b> (greyed out until Branding is complete — hover it to see what's missing). While it's in Testing, Google blocks everyone who isn't a listed test user ("has not completed the Google verification process"), and connections stop working every 7 days. If Google asks, prove you own {domain} in <a className={link} href="https://search.google.com/search-console" target="_blank" rel="noreferrer">Search Console</a> (a DNS record).</li>
        <li>
          <b className="text-foreground">Clients</b>: create an OAuth client of type <b className="text-foreground">Web application</b> with this authorized redirect URI, and paste its ID and secret below.
          <div className="mt-2"><CopyField label="redirect URI" value={app.redirectUri} /></div>
        </li>
      </ol>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="g-client">Client ID</FieldLabel>
            <Input id="g-client" className="h-10 font-mono text-xs" placeholder="123…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel htmlFor="g-secret">Client secret</FieldLabel>
            <Input id="g-secret" type="password" className="h-10 font-mono text-xs" placeholder={app.configured ? 'Saved — paste a new one to replace it' : 'GOCSPX-…'} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            <FieldDescription>Google shows the secret only once, when you create the client. It's encrypted on the server and never shown again.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="g-contact">Contact email for the public pages</FieldLabel>
            <Input id="g-contact" type="email" className="h-10" placeholder="team@example.com" value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" />
            <FieldDescription>Shown on the home page and privacy policy above, for questions about members' data. Anyone can see it.</FieldDescription>
          </Field>
          {app.configured && app.clientId && clientId.trim() !== app.clientId && (
            <p className="text-sm text-attention-foreground">A different Google app disconnects everyone; they'll need to connect their Drive again.</p>
          )}
          <ErrorAlert error={error} />
          <Button type="submit" className="h-10 self-start" disabled={save.isPending || !clientId.trim() || (!app.configured && !secret.trim())}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </FieldGroup>
      </form>
    </SettingsSection>
  )
}

/** Google sends the browser here after consent (outside the sign-in guard: the native app finishes in the system browser). */
export function StorageCallbackPage() {
  const navigate = useNavigate()
  const me = useQuery(meQuery).data
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    const p = new URLSearchParams(window.location.search)
    const body = { code: p.get('code') ?? undefined, state: p.get('state') ?? undefined, error: p.get('error') ?? undefined }
    window.history.replaceState(null, '', '/storage/callback') // the code is single-use; keep it out of history
    unwrap(api.api.storage.google.callback.$post({ json: body }))
      .then((r) => setResult(r), (e: Error) => setResult({ ok: false, message: e.message }))
  }, [])
  useEffect(() => {
    if (!result || !me) return
    if (result.ok) toast.success(result.message)
    else toast.error(result.message)
    void navigate({ to: '/storage' })
  }, [result, me, navigate])
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {!result ? (
          <><Spinner /><p className="text-sm text-muted-foreground">Connecting your Google Drive…</p></>
        ) : (
          <>
            <p className="font-medium">{result.ok ? 'Google Drive connected' : 'Not connected'}</p>
            <p className="text-sm text-muted-foreground">{result.message}</p>
            {!me && <p className="text-sm text-muted-foreground">You can close this tab and go back to DevDash.</p>}
            {me && <Link to="/storage" className="text-sm underline underline-offset-4">Back to Storage</Link>}
          </>
        )}
      </div>
    </div>
  )
}
