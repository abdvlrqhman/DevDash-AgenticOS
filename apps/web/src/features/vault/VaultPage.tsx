import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Ellipsis, Eye, EyeOff, ExternalLink, KeyRound, Lock, LockOpen, Plus, RefreshCw, Search, ShieldCheck, StickyNote, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useIsMobile } from '@/hooks/use-mobile'
import { api, meQuery, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import * as vc from './crypto'
import { copySecret, REMEMBER_OPTIONS, rememberMinutes, setRememberMinutes, useVault, vault } from './session'
import { NativeSelect } from '@/components/app/native-select'

type LoginItem = { type: 'login'; name: string; username?: string; password?: string; url?: string; totp?: string; notes?: string }
type NoteItem = { type: 'note'; name: string; notes?: string }
type ItemValue = LoginItem | NoteItem
type Item = { id: string; value: ItemValue; updatedAt: number; updatedBy: string | null }

const meVault = { queryKey: ['vault', 'me'], queryFn: () => unwrap(api.api.vault.me.$get()) }

export function VaultPage() {
  const user = useQuery(meQuery).data!
  const v = useQuery(meVault)
  const session = useVault()
  const qc = useQueryClient()
  // Decrypted items never outlive a lock.
  useEffect(() => { if (!session.unlocked) qc.removeQueries({ queryKey: ['vault-items'] }) }, [session.unlocked, qc])
  // Still remembered on this device? Then no password needed.
  const [restoring, setRestoring] = useState(!session.unlocked)
  useEffect(() => { if (restoring) void vault.restore(user.id).finally(() => setRestoring(false)) }, [restoring, user.id])

  if (v.error) return <Shell><div className="p-4"><ErrorAlert error={v.error} /></div></Shell>
  if (!v.data || restoring) return <Shell><div className="p-4"><Skeleton className="h-48" /></div></Shell>
  if (!v.data.setup) return <Shell><Setup userId={user.id} /></Shell>
  if (!session.unlocked) return <Shell><Unlock userId={user.id} me={v.data} /></Shell>
  return <Unlocked userId={user.id} publicKey={v.data.publicKey} />
}

const Shell = ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
  <div className="flex h-full flex-col"><PageHeader title="Vault" description="Only you can open it: encrypted on your device" actions={actions} />{children}</div>
)

/** Opens every vault this member holds a key for; gives new teammates the team key; replaces the key after someone left. */
async function openVaults(userId: number, publicKey: string) {
  const r = await unwrap(api.api.vault.vaults.$get())
  const s = vault.get()
  if (!s.unlocked) return r
  for (const v of r.vaults) {
    if (v.key) vault.setKey(v.id, await vc.unwrap(v.key, s.privateKey, vc.wrapInfo(v.id, v.keyVersion, userId)), v.keyVersion)
    else if (v.fresh) {
      const key = await vc.newVaultKey()
      await unwrap(api.api.vault.vaults[':id'].init.$post({ param: { id: String(v.id) }, json: { wrapped: await vc.wrapFor(key, publicKey, vc.wrapInfo(v.id, v.keyVersion, userId)) } }))
      vault.setKey(v.id, key, v.keyVersion)
    }
  }
  const team = r.vaults.find((v) => v.kind === 'team')
  const tk = team && vault.get().unlocked ? (vault.get() as { keys: Map<number, { key: CryptoKey; version: number }> }).keys.get(team.id) : undefined
  if (team && tk) {
    if (team.needsRotation) await rotate(team.id, tk, r.members)
    else for (const w of r.waiting) {
      await unwrap(api.api.vault.vaults[':id'].keys.$post({
        param: { id: String(team.id) }, json: { userId: w.userId, keyVersion: team.keyVersion, wrapped: await vc.wrapFor(tk.key, w.publicKey, vc.wrapInfo(team.id, team.keyVersion, w.userId)) },
      }))
    }
  }
  return r
}

/** Someone lost access: a new team key, every item re-encrypted, wrapped for everyone who stays. */
async function rotate(vaultId: number, old: { key: CryptoKey; version: number }, members: { userId: number; publicKey: string }[]) {
  const next = old.version + 1
  const key = await vc.newVaultKey()
  const { items } = await unwrap(api.api.vault.vaults[':id'].items.$get({ param: { id: String(vaultId) } }))
  const reencrypted = await Promise.all(items.map(async (i) => {
    const value = await vc.decryptItem(old.key, vaultId, i.id, { iv: i.iv, data: i.data })
    return { id: i.id, ...(await vc.encryptItem(key, vaultId, i.id, value)) }
  }))
  const keys = await Promise.all(members.map(async (m) => ({ userId: m.userId, wrapped: await vc.wrapFor(key, m.publicKey, vc.wrapInfo(vaultId, next, m.userId)) })))
  await unwrap(api.api.vault.vaults[':id'].rotate.$post({ param: { id: String(vaultId) }, json: { keyVersion: next, keys, items: reencrypted } }))
  vault.setKey(vaultId, key, next)
  toast.success('Team vault key replaced, since someone left the team.')
}

function Setup({ userId }: { userId: number }) {
  const qc = useQueryClient()
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [ack, setAck] = useState(false)
  const create = useMutation({
    mutationFn: async () => {
      const id = await vc.newIdentity(pw, userId)
      await unwrap(api.api.vault.setup.$post({ json: id.body }))
      const { privateKey, pkcs8 } = await vc.unlockIdentity(pw, id.body, userId)
      vault.unlock(privateKey, pkcs8, userId)
      await openVaults(userId, id.publicKey)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vault'] }),
  })
  const mismatch = again.length > 0 && again !== pw
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <ShieldCheck className="size-8" />
        <h2 className="text-xl font-semibold tracking-tight">Set up your vault</h2>
        <p className="text-sm text-muted-foreground">Passwords, 2FA codes and secrets for you and the team. Everything is encrypted on your device with a vault password only you know. The server stores scrambled data it cannot read.</p>
      </div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (ack && pw && pw === again) create.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="vp">Vault password</FieldLabel>
            <Input id="vp" type="password" autoComplete="new-password" className="h-10" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <FieldDescription>Different from your DevDash password. A long phrase is easiest to remember.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="vp2">Type it again</FieldLabel>
            <Input id="vp2" type="password" autoComplete="new-password" className="h-10" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} />
            {mismatch && <FieldDescription className="text-destructive">These don't match.</FieldDescription>}
          </Field>
          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
            <span>I understand nobody can recover this password, not even an admin. If I forget it, my personal vault is gone (team items stay with my teammates).</span>
          </label>
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!ack || !pw || pw !== again || create.isPending}>{create.isPending && <Spinner />}Create my vault</Button>
        </FieldGroup>
      </form>
    </div>
  )
}

function Unlock({ userId, me }: { userId: number; me: { salt: string; iterations: number; privateKey: vc.Sealed; publicKey: string } }) {
  const [pw, setPw] = useState('')
  const open = useMutation({
    mutationFn: async () => {
      const { privateKey, pkcs8 } = await vc.unlockIdentity(pw, me, userId)
      vault.unlock(privateKey, pkcs8, userId)
      await openVaults(userId, me.publicKey)
    },
    onError: () => setPw(''),
  })
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 px-4 py-14">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted"><Lock className="size-5" /></span>
        <h2 className="text-lg font-semibold">Unlock your vault</h2>
        <p className="text-sm text-muted-foreground">Once unlocked, this device remembers it for a while, so you don't type it every time.</p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (pw) open.mutate() }}>
        <Input type="password" aria-label="Vault password" placeholder="Vault password" autoComplete="current-password" autoFocus className="h-10" value={pw} onChange={(e) => setPw(e.target.value)} />
        <RememberFor />
        <ErrorAlert error={open.error} />
        <Button type="submit" className="h-10" disabled={!pw || open.isPending}>{open.isPending ? <Spinner /> : <LockOpen />}Unlock</Button>
      </form>
    </div>
  )
}

function Unlocked({ userId, publicKey }: { userId: number; publicKey: string }) {
  const session = useVault()
  const mobile = useIsMobile()
  const vaults = useQuery({ queryKey: ['vault', 'list'], queryFn: () => openVaults(userId, publicKey), staleTime: 60_000 })
  const [kind, setKind] = useState<'personal' | 'team'>('personal')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ item: Item | null; type: 'login' | 'note' } | null>(null)
  const [changing, setChanging] = useState(false)
  const v = vaults.data?.vaults.find((x) => x.kind === kind)
  const key = v && session.unlocked ? session.keys.get(v.id) : undefined
  const items = useQuery({
    queryKey: ['vault-items', v?.id, key?.version],
    enabled: !!v && !!key,
    gcTime: 0,
    queryFn: async () => {
      const { items } = await unwrap(api.api.vault.vaults[':id'].items.$get({ param: { id: String(v!.id) } }))
      const out = await Promise.all(items.map(async (i) => ({
        id: i.id, updatedAt: i.updatedAt, updatedBy: i.updatedBy,
        value: await vc.decryptItem<ItemValue>(key!.key, v!.id, i.id, { iv: i.iv, data: i.data }).catch(() => ({ type: 'note', name: 'Unreadable item', notes: 'This item could not be decrypted.' }) as NoteItem),
      })))
      return out.sort((a, b) => a.value.name.localeCompare(b.value.name))
    },
  })
  const shown = useMemo(() => (items.data ?? []).filter((i) => {
    const n = q.trim().toLowerCase()
    return !n || i.value.name.toLowerCase().includes(n) || (i.value.type === 'login' && (i.value.username?.toLowerCase().includes(n) || i.value.url?.toLowerCase().includes(n)))
  }), [items.data, q])
  const current = shown.find((i) => i.id === selected) ?? null

  const header = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" disabled={!key}><Plus />New</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing({ item: null, type: 'login' })}><KeyRound />Login</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditing({ item: null, type: 'note' })}><StickyNote />Secure note</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="outline" onClick={() => vault.lock()}><Lock /><span className="hidden sm:inline">Lock</span></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Vault options"><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5"><RememberFor /></div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setChanging(true)}><KeyRound />Change vault password</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  const detail = current && key && v && (
    <ItemDetail item={current} onEdit={() => setEditing({ item: current, type: current.value.type })} vaultId={v.id} keyVersion={key.version} onDeleted={() => setSelected(null)} />
  )

  return (
    <Shell actions={header}>
      <div className="flex min-h-0 flex-1">
        <div className={cn('flex min-h-0 w-full flex-col gap-3 p-4 lg:w-96 lg:shrink-0 lg:border-r')}>
          <ToggleGroup type="single" variant="outline" size="sm" value={kind} onValueChange={(x) => { if (x) { setKind(x as typeof kind); setSelected(null) } }} className="w-full">
            <ToggleGroupItem value="personal" className="flex-1"><Lock />Personal</ToggleGroupItem>
            <ToggleGroupItem value="team" className="flex-1"><Users />Team</ToggleGroupItem>
          </ToggleGroup>
          <InputGroup>
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput aria-label="Search the vault" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </InputGroup>
          <ErrorAlert error={vaults.error ?? items.error} />
          {vaults.data && v && !key && <p className="rounded-lg border p-3 text-sm text-muted-foreground">You'll get the team vault's key the next time a teammate who has it unlocks their vault.</p>}
          {items.isPending && key && <Skeleton className="h-40" />}
          {items.data && !items.data.length && <p className="py-8 text-center text-sm text-muted-foreground">{kind === 'team' ? 'Nothing shared yet. Logins here are available to the whole team.' : 'Nothing saved yet.'}</p>}
          <ul className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {shown.map((i) => (
              <li key={i.id}>
                <button onClick={() => setSelected(i.id)} className={cn('flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent', selected === i.id && 'bg-accent')}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-xs font-semibold uppercase">
                    {i.value.type === 'note' ? <StickyNote className="size-4" /> : i.value.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{i.value.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{i.value.type === 'login' ? i.value.username || hostOf(i.value.url) || 'Login' : 'Secure note'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {!mobile && <div className="hidden min-w-0 flex-1 overflow-y-auto p-6 lg:block">{detail ?? <p className="pt-20 text-center text-sm text-muted-foreground">Pick an item to see it.</p>}</div>}
      </div>
      {mobile && <ResponsiveDialog open={!!current} onOpenChange={(o) => !o && setSelected(null)} title={current?.value.name ?? ''}>{detail}</ResponsiveDialog>}
      {editing && v && key && <ItemEditor type={editing.type} item={editing.item} vaultId={v.id} vaultKey={key} onClose={(id) => { setEditing(null); if (id) setSelected(id) }} />}
      {changing && <ChangePassword userId={userId} onClose={() => setChanging(false)} />}
    </Shell>
  )
}

const hostOf = (url?: string) => { try { return url ? new URL(url.includes('://') ? url : `https://${url}`).host : '' } catch { return url ?? '' } }

function Row({ label, value, secret, mono, action }: { label: string; value: string; secret?: boolean; mono?: boolean; action?: ReactNode }) {
  const [show, setShow] = useState(false)
  return (
    <div className="flex items-center gap-2 border-b py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('truncate text-sm select-text', (mono || secret) && 'font-mono')} data-selectable>{secret && !show ? '•'.repeat(Math.min(16, value.length)) : value}</div>
      </div>
      {action}
      {secret && <Button size="icon-sm" variant="ghost" aria-label={show ? 'Hide' : 'Show'} onClick={() => setShow((s) => !s)}>{show ? <EyeOff /> : <Eye />}</Button>}
      <Button size="icon-sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copySecret(value).then(() => toast.success(`${label} copied. The clipboard clears in 30 seconds.`))}><Copy /></Button>
    </div>
  )
}

function TotpRow({ secret }: { secret: string }) {
  const [t, setT] = useState<{ code: string; remaining: number; period: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const tick = () => void vc.totp(secret).then((r) => alive && setT(r), (e: Error) => alive && setError(e.message))
    tick()
    const i = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(i) }
  }, [secret])
  if (error) return <div className="border-b py-2.5 text-sm text-destructive">{error}</div>
  if (!t) return null
  return (
    <Row label="2FA code" value={t.code} mono action={
      <span className="relative flex size-6 items-center justify-center text-[10px] tabular-nums text-muted-foreground" title={`New code in ${t.remaining}s`}>
        <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2" />
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(t.remaining / t.period) * 62.8} 62.8`} className={t.remaining <= 5 ? 'text-destructive' : 'text-foreground'} /></svg>
        {t.remaining}
      </span>} />
  )
}

function ItemDetail({ item, onEdit, vaultId, onDeleted }: { item: Item; onEdit: () => void; vaultId: number; keyVersion: number; onDeleted: () => void }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => unwrap(api.api.vault.vaults[':id'].items[':item'].$delete({ param: { id: String(vaultId), item: item.id } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['vault-items'] }); onDeleted() },
    onError: (e) => toast.error(e.message),
  })
  const v = item.value
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-4">
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{v.name}</h2>
        <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Item options"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuSeparator className="hidden" /><DropdownMenuItem variant="destructive" onSelect={() => del.mutate()}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="rounded-xl border px-4">
        {v.type === 'login' && <>
          {v.username && <Row label="Username" value={v.username} />}
          {v.password && <Row label="Password" value={v.password} secret />}
          {v.totp && <TotpRow secret={v.totp} />}
          {v.url && <Row label="Website" value={v.url} action={<Button size="icon-sm" variant="ghost" aria-label="Open website" onClick={() => openExternal(v.url!.includes('://') ? v.url! : `https://${v.url}`)}><ExternalLink /></Button>} />}
        </>}
        {v.notes && <div className="border-b py-2.5 last:border-b-0"><div className="text-xs text-muted-foreground">Notes</div><p className="text-sm whitespace-pre-wrap select-text" data-selectable>{v.notes}</p></div>}
      </div>
      <p className="text-xs text-muted-foreground">Changed {relativeTime(item.updatedAt)}{item.updatedBy ? ` by ${item.updatedBy}` : ''}.</p>
    </div>
  )
}

function ItemEditor({ type, item, vaultId, vaultKey, onClose }: { type: 'login' | 'note'; item: Item | null; vaultId: number; vaultKey: { key: CryptoKey; version: number }; onClose: (id?: string) => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<ItemValue>(item?.value ?? (type === 'login' ? { type: 'login', name: '' } : { type: 'note', name: '' }))
  const set = (patch: Partial<Omit<LoginItem, 'type'>>) => setF((o) => ({ ...o, ...patch }) as ItemValue)
  const [show, setShow] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const id = item?.id ?? crypto.randomUUID()
      const clean = Object.fromEntries(Object.entries(f).filter(([, x]) => x !== '' && x !== undefined))
      const sealed = await vc.encryptItem(vaultKey.key, vaultId, id, clean)
      await unwrap(api.api.vault.vaults[':id'].items[':item'].$put({ param: { id: String(vaultId), item: id }, json: { keyVersion: vaultKey.version, ...sealed } }))
      return id
    },
    onSuccess: (id) => { void qc.invalidateQueries({ queryKey: ['vault-items'] }); onClose(id) },
  })
  return (
    <ResponsiveDialog open onOpenChange={(o) => !o && onClose()} title={item ? `Edit ${item.value.name}` : f.type === 'login' ? 'New login' : 'New secure note'}
      description="Encrypted on this device before it's saved.">
      <form onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) save.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="vi-name">Name</FieldLabel>
            <Input id="vi-name" autoFocus className="h-10" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={f.type === 'login' ? 'GitHub' : 'Server recovery codes'} />
          </Field>
          {f.type === 'login' && <>
            <Field>
              <FieldLabel htmlFor="vi-user">Username or email</FieldLabel>
              <Input id="vi-user" className="h-10" autoComplete="off" value={f.username ?? ''} onChange={(e) => set({ username: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="vi-pw">Password</FieldLabel>
              <InputGroup>
                <InputGroupInput id="vi-pw" type={show ? 'text' : 'password'} autoComplete="new-password" className="font-mono" value={f.password ?? ''} onChange={(e) => set({ password: e.target.value })} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label={show ? 'Hide' : 'Show'} onClick={() => setShow((s) => !s)}>{show ? <EyeOff /> : <Eye />}</InputGroupButton>
                  <InputGroupButton size="icon-xs" aria-label="Generate a strong password" onClick={() => { set({ password: vc.generatePassword(20) }); setShow(true) }}><RefreshCw /></InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription>The arrows make a strong 20-character password.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="vi-url">Website</FieldLabel>
              <Input id="vi-url" className="h-10" inputMode="url" value={f.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="github.com" />
            </Field>
            <Field>
              <FieldLabel htmlFor="vi-totp">2FA secret</FieldLabel>
              <Input id="vi-totp" className="h-10 font-mono" autoComplete="off" value={f.totp ?? ''} onChange={(e) => set({ totp: e.target.value })} placeholder="JBSWY3DP… or otpauth://…" />
              <FieldDescription>The setup key from the site's 2FA page. DevDash then shows the codes.</FieldDescription>
            </Field>
          </>}
          <Field>
            <FieldLabel htmlFor="vi-notes">Notes</FieldLabel>
            <Textarea id="vi-notes" rows={f.type === 'note' ? 8 : 3} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          <ErrorAlert error={save.error} />
          <Button type="submit" className="h-10" disabled={!f.name.trim() || save.isPending}>{save.isPending && <Spinner />}Save</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

function ChangePassword({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const change = useMutation({
    mutationFn: async () => {
      const s = vault.get()
      if (!s.unlocked) throw new Error('Unlock the vault first.')
      await unwrap(api.api.vault.me.password.$put({ json: await vc.resealIdentity(s.pkcs8, pw, userId) }))
    },
    onSuccess: () => { toast.success('Vault password changed.'); onClose() },
  })
  return (
    <ResponsiveDialog open onOpenChange={(o) => !o && onClose()} title="Change vault password" description="Your vault stays as it is; only the password that opens it changes. There is still no way to recover it.">
      <form onSubmit={(e) => { e.preventDefault(); if (pw && pw === again) change.mutate() }}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="cp1">New vault password</FieldLabel><Input id="cp1" type="password" autoComplete="new-password" className="h-10" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
          <Field><FieldLabel htmlFor="cp2">Type it again</FieldLabel><Input id="cp2" type="password" autoComplete="new-password" className="h-10" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          <ErrorAlert error={change.error} />
          <Button type="submit" className="h-10" disabled={!pw || pw !== again || change.isPending}>{change.isPending && <Spinner />}Change password</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

/** How long this device keeps the vault open after the last use. */
function RememberFor() {
  const [m, setM] = useState(rememberMinutes)
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">Keep unlocked on this device for</span>
      <NativeSelect aria-label="Keep unlocked for" className="w-32 [&_select]:h-8" value={m} onChange={(e) => { const v = Number(e.target.value); setM(v); setRememberMinutes(v) }}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {REMEMBER_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
      </NativeSelect>
    </label>
  )
}
