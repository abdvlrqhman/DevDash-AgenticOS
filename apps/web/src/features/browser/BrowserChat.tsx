import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eraser, Send, SlidersHorizontal, Square, X } from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ErrorAlert } from '../auth/LoginPage'
import { FALLBACK_MODELS, profilesQuery, useOfferedModels } from '../claude/data'
import { HARNESS, agentCapabilities, harnessOf, type Harness } from '../claude/harness'
import { effortLabel, effortLevels, isDefaultModel, modelLabel, type ModelInfo } from '../claude/models'

const chat = api.api.browser.chat

type BrowserModel = { harness: string; profile: string; model: string; effort: string | null }

export function BrowserChat({ userId, onClose, onOpenSettings }: { userId: number; onClose: () => void; onOpenSettings?: () => void }) {
  const qc = useQueryClient()
  const key = ['browser-chat', userId]
  const state = useQuery({ queryKey: key, queryFn: () => unwrap(chat.$get()), retry: false,
    refetchInterval: (q) => q.state.data?.busy ? 1000 : 10_000, staleTime: 0 })
  const [draft, setDraft] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const bottom = useRef<HTMLDivElement>(null)
  const send = useMutation({
    mutationFn: () => unwrap(chat.$post({ json: { message: draft.trim(), requestId: requestId.current } })),
    onSuccess: async () => {
      requestId.current = crypto.randomUUID()
      setDraft('')
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const clear = useMutation({
    mutationFn: () => unwrap(chat.$delete()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const stop = useMutation({
    mutationFn: () => unwrap(chat.cancel.$post()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const turns = state.data?.turns
  const last = turns?.at(-1)
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [last?.id, last?.reply])
  const active = state.data?.model
  const activeLabel = active
    ? `${HARNESS[harnessOf({ harness: active.harness })].label}${active.model && !isDefaultModel(active.model) ? ` · ${active.model}` : ''}${active.effort ? ` (${effortLabel(active.effort)})` : ''}`
    : null
  return (
    <aside aria-label="Browser chat" className="flex min-h-0 flex-1 flex-col gap-3 rounded-2xl border bg-background p-3 md:max-w-sm md:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Browser chat</h2>
          {activeLabel && <p className="mt-0.5 truncate text-xs text-muted-foreground">{activeLabel}</p>}
          <p className="mt-1 text-xs text-muted-foreground">Can open sites, click, type, press keys, and scroll. Actions are visible to everyone watching.</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="icon-sm" variant="ghost" aria-label="Clear browser chat" title="Clear browser chat"
            disabled={!turns?.length || clear.isPending || !!state.data?.busy}
            onClick={async () => {
              if (await confirmAction({ title: 'Clear browser chat?', description: 'Removes your Browser chat messages. The shared browser and settings stay.', action: 'Clear' })) clear.mutate()
            }}><Eraser /></Button>
          {onOpenSettings && <Button size="icon-sm" variant="ghost" aria-label="Browser agent settings" title="Browser agent settings" onClick={onOpenSettings}><SlidersHorizontal /></Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Close browser chat" onClick={onClose}><X /></Button>
        </div>
      </div>
      <div role="log" aria-label="Conversation" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
        {state.isPending && <Spinner />}
        <ErrorAlert error={state.error} />
        {!state.error && turns?.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-2">
            <p className="ml-6 self-end whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2">{turn.message}</p>
            <p className="mr-4 whitespace-pre-wrap break-words">{turn.reply ?? state.data?.status ?? 'Working…'}</p>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && !send.isPending && !state.data?.busy && !state.error) send.mutate() }}>
        <ErrorAlert error={send.error ?? clear.error ?? stop.error} />
        <Textarea aria-label="Message the browser assistant" placeholder="Open a site, search, click, type, or ask about the page…" maxLength={3000} rows={2}
          className="max-h-28 min-h-14" value={draft} disabled={send.isPending} onChange={(e) => { setDraft(e.target.value); requestId.current = crypto.randomUUID() }} />
        <div className="flex items-center justify-end gap-2">
          {state.data?.canStop && (
            <Button size="sm" type="button" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <Square className="size-3" />Stop
            </Button>
          )}
          <Button size="sm" type="submit" disabled={!draft.trim() || !state.data || !!state.error || send.isPending || state.data.busy}>
            {send.isPending || state.data?.busy ? <Spinner /> : <Send />}Send
          </Button>
        </div>
      </form>
    </aside>
  )
}

function BrowserAgentForm({ userId, saved }: { userId: number; saved: BrowserModel }) {
  const qc = useQueryClient()
  const [v, setV] = useState<BrowserModel>(saved)
  useEffect(() => setV(saved), [saved])

  const save = useMutation({
    mutationFn: (body: BrowserModel) => unwrap(chat.settings.$put({ json: body })),
    onSuccess: (r) => {
      qc.setQueryData(['browser-chat-settings', userId], r)
      void qc.invalidateQueries({ queryKey: ['browser-chat', userId] })
      toast.success('Browser agent saved.')
    },
  })

  const dirty = v.harness !== saved.harness || v.profile !== saved.profile || v.model !== saved.model || v.effort !== saved.effort

  const profiles = useQuery(profilesQuery)
  const agents = (profiles.data?.agents as { harness: string; installed: boolean; profiles: { name: string }[] }[] | undefined) ?? []
  const claudeProfiles = (profiles.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? []
  const installed = agents.filter((a) => a.installed).map((a) => a.harness)
  const availableAgents: Harness[] = (['claude' as const, ...installed.filter((h) => h !== 'claude')]).filter(
    (h, i, arr) => agentCapabilities(h).completions && arr.indexOf(h) === i,
  ) as Harness[]

  const agentProfiles = v.harness === 'claude'
    ? claudeProfiles.map((p) => p.name)
    : (agents.find((a) => a.harness === v.harness)?.profiles ?? []).map((p) => p.name)

  const harness = harnessOf(v)
  const t3 = harness === 't3code'
  const offered = useOfferedModels(v.profile, harness, v.model, agentProfiles.includes(v.profile), t3)
  const modelList: ModelInfo[] = t3 ? (offered ?? [])
    : offered?.length ? offered : harness === 'claude' ? FALLBACK_MODELS : [{ value: '', displayName: 'Default' }]
  const picked = modelList.find((m) => m.value === v.model)
  const levels = t3 ? effortLevels(modelList, v.model) : []
  const validT3 = !!picked?.supportsSupervisor && (!v.effort || levels.includes(v.effort))

  const changeAgent = (h: string) => setV({ harness: h, profile: 'default', model: h === 'claude' ? 'sonnet' : '', effort: null })

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (dirty && !save.isPending && (!t3 || validT3)) save.mutate(v) }}>
      <div>
        <h3 className="text-sm font-semibold">Model</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Runs only for Browser chat, separate from your Autopilot supervisor.</p>
      </div>
      <FieldGroup>
        <ErrorAlert error={save.error} />
        <Field>
          <FieldLabel htmlFor="bc-agent">Agent</FieldLabel>
          <NativeSelect id="bc-agent" value={v.harness} onChange={(e) => changeAgent(e.target.value)}>
            {!availableAgents.includes(harness) && <option value={v.harness} disabled>{HARNESS[harness].label} (unavailable)</option>}
            {availableAgents.map((h) => <option key={h} value={h}>{HARNESS[h].label}</option>)}
          </NativeSelect>
          <FieldDescription>Only tool-free agents installed on this server.</FieldDescription>
        </Field>
        {agentProfiles.length > 1 && (
          <Field>
            <FieldLabel htmlFor="bc-profile">Account</FieldLabel>
            <NativeSelect id="bc-profile" value={v.profile} onChange={(e) => setV({ ...v, profile: e.target.value, model: v.harness === 'claude' ? 'sonnet' : '', effort: null })}>
              {agentProfiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect>
            <FieldDescription>Which of your profiles pays for Browser chat calls.</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="bc-model">Model</FieldLabel>
          <NativeSelect id="bc-model" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value, effort: null })}>
            {t3 && !picked && <option value={v.model}>{v.model ? `${v.model} (unavailable)` : offered && !modelList.length ? 'No tool-free models available' : 'Choose a model'}</option>}
            {modelList.map((m) => (
              <option key={m.value} value={m.value} disabled={t3 && !m.supportsSupervisor}>
                {isDefaultModel(m.value) ? modelLabel(modelList, m.value, HARNESS[harness].label) : m.displayName}
                {t3 && !m.supportsSupervisor ? ' (chat only)' : ''}
              </option>
            ))}
          </NativeSelect>
          <FieldDescription>{t3 ? 'Choose a T3 Code model that can run with tools disabled.' : 'The model used to read the shared browser screen and run browser actions.'}</FieldDescription>
        </Field>
        {t3 && (levels.length > 0 || !!v.effort) && (
          <Field>
            <FieldLabel htmlFor="bc-effort">Thinking level</FieldLabel>
            <NativeSelect id="bc-effort" value={v.effort ?? ''} onChange={(e) => setV({ ...v, effort: e.target.value || null })}>
              <option value="">Default</option>
              {v.effort && !levels.includes(v.effort) && <option value={v.effort}>{effortLabel(v.effort)} (unavailable)</option>}
              {levels.map((e) => <option key={e} value={e}>{effortLabel(e)}</option>)}
            </NativeSelect>
          </Field>
        )}
        <div>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending || (t3 && !validT3)}>
            {save.isPending && <Spinner />}Save model
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

export function BrowserChatSettings({ onClose, userId }: { onClose: () => void; userId: number }) {
  const qc = useQueryClient()
  const settingsKey = ['browser-chat-settings', userId]
  const accessKey = ['browser-chat-access', userId]
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => unwrap(chat.settings.$get()), staleTime: 0 })
  const list = useQuery({ queryKey: accessKey, queryFn: () => unwrap(chat.access.$get()), staleTime: 0 })
  const saveAccess = useMutation({
    mutationFn: ({ id, allowed }: { id: number; allowed: boolean }) => unwrap(chat.access[':id'].$put({ param: { id: String(id) }, json: { allowed } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: accessKey }),
  })
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()} title="Browser agent"
      description="Configure a dedicated model for Shared Browser chat and choose which members can use it.">
      <div className="flex flex-col gap-6 pb-2">
        <ErrorAlert error={settings.error} />
        {settings.isPending && <Spinner />}
        {settings.data && <BrowserAgentForm userId={userId} saved={settings.data.model} />}
        <div className="flex flex-col gap-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Member access</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Admins always have access. Grant a member access to use your Browser agent in the shared browser.</p>
          </div>
          <ErrorAlert error={list.error ?? saveAccess.error} />
          {list.isPending && <Spinner />}
          {list.data?.members.length === 0 && <p className="text-sm text-muted-foreground">There are no other members to grant access to.</p>}
          {list.data?.members.map((m) => (
            <label key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2.5">
              <span className="min-w-0 text-sm"><span className="block truncate font-medium">{m.name}</span><span className="text-xs text-muted-foreground">@{m.username}</span></span>
              <Switch aria-label={'Browser chat for ' + m.username} checked={m.allowed} disabled={saveAccess.isPending}
                onCheckedChange={(allowed) => saveAccess.mutate({ id: m.id, allowed })} />
            </label>
          ))}
        </div>
      </div>
    </ResponsiveDialog>
  )
}
