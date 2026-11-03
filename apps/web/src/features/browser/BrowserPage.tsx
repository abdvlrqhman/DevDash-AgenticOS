import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Globe, Maximize, Power, UserPlus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { PageHeader, pageCol } from '@/components/app/page'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, meQuery, unwrap } from '@/lib/api'
import { inShell } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

/**
 * The team's shared browser on the server: one Chromium that stays signed in to things (logins and tabs persist),
 * streamed here. One person controls it at a time; the others watch. It stops after 30 minutes nobody is looking.
 */
export function BrowserPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['browser'], queryFn: () => unwrap(api.api.browser.$get()) })
  const [url, setUrl] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const open = useMutation({
    mutationFn: () => unwrap(api.api.browser.open.$post()),
    onSuccess: (r) => { setUrl(r.url); void qc.invalidateQueries({ queryKey: ['browser'] }) },
  })
  const stop = useMutation({
    mutationFn: () => unwrap(api.api.browser.stop.$post()),
    onSuccess: () => { setUrl(null); void qc.invalidateQueries({ queryKey: ['browser'] }); toast.success('Browser stopped. Logins are kept for next time.') },
    onError: (e) => toast.error(e.message),
  })

  // Tell the server someone is watching, so it doesn't stop the browser.
  useEffect(() => {
    if (!url) return
    const beat = () => { if (document.visibilityState === 'visible') void api.api.browser.heartbeat.$post() }
    const i = setInterval(beat, 60_000)
    return () => clearInterval(i)
  }, [url])
  // Already running? Join straight away.
  useEffect(() => { if (status.data?.running && !url && !open.isPending && !open.isError) open.mutate() }, [status.data?.running]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Browser" description="One shared browser on the server, signed in to your team's tools"
        actions={<>
          <Button size="sm" variant="outline" onClick={() => setInviting(true)}><UserPlus /><span className="hidden sm:inline">Invite to watch</span></Button>
          {url && !inShell() && <Button size="sm" variant="outline" onClick={() => document.getElementById('dd-browser')?.requestFullscreen?.()}><Maximize /><span className="hidden sm:inline">Full screen</span></Button>}
          {url && me.role === 'admin' && <Button size="icon-sm" variant="ghost" aria-label="Stop the browser" disabled={stop.isPending} onClick={() => stop.mutate()}><Power /></Button>}
        </>} />
      {inviting && <Invites onClose={() => setInviting(false)} />}
      {url ? (
        <div style={pageCol()} className="page-col canvas flex min-h-0 flex-1 flex-col py-2 md:py-4"><iframe id="dd-browser" title="Shared browser" src={url} className="min-h-0 w-full flex-1 rounded-2xl border-0 bg-black"
          allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone" /></div>
      ) : (
        // Not running: the panel stands where the browser will be, with the one button that starts it.
        <div style={pageCol()} className="page-col flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto py-6 md:py-8">
          <div className="flex min-h-[22rem] flex-1 flex-col items-center justify-center gap-6 rounded-2xl bg-surface px-6 py-12 text-center md:max-h-[34rem]">
            <span className="flex size-16 items-center justify-center rounded-full bg-background"><Globe className="size-7" strokeWidth={1.75} /></span>
            <div className="flex max-w-md flex-col gap-2">
              <h2 className="text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance md:text-[2.25rem]">One browser for the whole team</h2>
              <p className="text-sm text-pretty text-muted-foreground">A Chromium on the server that everyone shares, streamed here.</p>
            </div>
            <ErrorAlert error={status.error ?? open.error} />
            <Button size="lg" className="h-11 px-5" disabled={open.isPending || status.isPending} onClick={() => open.mutate()}>
              {open.isPending ? <><Spinner />Starting…</> : status.data?.running ? 'Join' : 'Start the browser'}
            </Button>
          </div>
          <ul className="grid gap-x-10 gap-y-5 text-sm text-pretty md:grid-cols-3">
            <li className="flex flex-col gap-1"><span className="font-medium">Signed in once, for everyone</span><span className="text-muted-foreground">Sign in to a site once (an admin panel, a store console, a test account) and it stays signed in for the whole team, from any device.</span></li>
            <li className="flex flex-col gap-1"><span className="font-medium">One drives, the others watch</span><span className="text-muted-foreground">One person controls it at a time. People without an account can watch with an invite link.</span></li>
            <li className="flex flex-col gap-1"><span className="font-medium">Stops by itself</span><span className="text-muted-foreground">After 30 minutes nobody is watching. Logins and open tabs are kept for next time.</span></li>
          </ul>
        </div>
      )}
    </div>
  )
}

const DURATIONS = [[1, '1 hour'], [8, '8 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days']] as const

/** Links for people without a DevDash account: they open the shared browser, watch-only unless allowed to take control. */
function Invites({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['browser', 'invites'], queryFn: () => unwrap(api.api.browser.invites.$get()) })
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState(24)
  const create = useMutation({
    mutationFn: () => unwrap(api.api.browser.invites.$post({ json: { label, hours, canControl: false } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['browser', 'invites'] })
      setLabel('')
      void navigator.clipboard.writeText(r.invite.url).then(() => toast.success('Invite link copied'), () => {})
    },
  })
  const revoke = useMutation({
    mutationFn: (id: number) => unwrap(api.api.browser.invites[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['browser', 'invites'] }),
  })
  const copy = (u: string) => void navigator.clipboard.writeText(u).then(() => toast.success('Invite link copied'))
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()} title="Invite people to watch"
      description="Anyone with the link sees the shared browser live, without a DevDash account. They can't control it or reach anything else in DevDash.">
      <div className="flex flex-col gap-5 pb-2">
        <form onSubmit={(e) => { e.preventDefault(); if (label.trim()) create.mutate() }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="bi-label">Their name</FieldLabel>
              <Input id="bi-label" autoFocus className="h-10" placeholder="Sara from QA" value={label} onChange={(e) => setLabel(e.target.value)} />
              <FieldDescription>Shown to everyone in the browser, marked as a guest.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="bi-hours">Link works for</FieldLabel>
              <NativeSelect id="bi-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {DURATIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
              </NativeSelect>
            </Field>
            <ErrorAlert error={create.error} />
            <Button type="submit" className="h-10" disabled={!label.trim() || create.isPending}><UserPlus />Create and copy link</Button>
          </FieldGroup>
        </form>
        {!!list.data?.invites.length && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Active invites<span className="ml-2 font-normal text-muted-foreground tabular-nums">{list.data.invites.length}</span></h3>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {list.data.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2 rounded-xl py-2 pr-1.5 pl-3 text-sm transition-colors duration-200 hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">Watch only, until {new Date(i.expiresAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </span>
                  <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={() => copy(i.url)}><Copy /></Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Turn off</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  )
}
