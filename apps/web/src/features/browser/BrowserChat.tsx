import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Eraser,
  FileText,
  ListChecks,
  Pause,
  Play,
  Send,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react'
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
  const state = useQuery({
    queryKey: key,
    queryFn: () => unwrap(chat.$get()),
    retry: false,
    refetchInterval: (q) => {
      const d = q.state.data
      if (d?.busy || d?.run?.status === 'running') return 1000
      if (d?.run?.status === 'waiting_user' || d?.run?.status === 'paused') return 4000
      return 10_000
    },
    staleTime: 0,
  })
  const [draft, setDraft] = useState('')
  const [runOpen, setRunOpen] = useState(true)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const requestId = useRef(crypto.randomUUID())
  const bottom = useRef<HTMLDivElement>(null)
  const lastRunStatus = useRef<string | undefined>(undefined)

  const invalidate = () => qc.invalidateQueries({ queryKey: key })

  const send = useMutation({
    mutationFn: () => unwrap(chat.$post({ json: { message: draft.trim(), requestId: requestId.current } })),
    onSuccess: async () => {
      requestId.current = crypto.randomUUID()
      setDraft('')
      setRunOpen(true)
      await invalidate()
    },
  })
  const steer = useMutation({
    mutationFn: ({ runId, message }: { runId: number; message: string }) =>
      unwrap(chat.runs[':id'].steer.$post({ param: { id: String(runId) }, json: { message } })),
    onSuccess: async () => {
      setDraft('')
      toast.success('Guidance queued for next step.')
      await invalidate()
    },
  })
  const pause = useMutation({
    mutationFn: (runId: number) => unwrap(chat.runs[':id'].pause.$post({ param: { id: String(runId) } })),
    onSuccess: invalidate,
  })
  const resume = useMutation({
    mutationFn: ({ runId, message }: { runId: number; message?: string }) =>
      unwrap(chat.runs[':id'].resume.$post({ param: { id: String(runId) }, json: message ? { message } : {} })),
    onSuccess: async () => {
      setDraft('')
      setRunOpen(true)
      await invalidate()
    },
  })
  const stopRun = useMutation({
    mutationFn: (runId?: number) =>
      runId !== undefined
        ? unwrap(chat.runs[':id'].stop.$post({ param: { id: String(runId) } }))
        : unwrap(chat.cancel.$post()),
    onSuccess: invalidate,
  })
  const clear = useMutation({
    mutationFn: () => unwrap(chat.$delete()),
    onSuccess: invalidate,
  })

  const turns = state.data?.turns
  const run = state.data?.run
  const last = turns?.at(-1)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [last?.id, last?.reply, run?.stepCount, run?.status])

  // Auto-expand run details when a run becomes active/waiting, collapse once finished to keep chat clean.
  useEffect(() => {
    const st = run?.status
    if (st && st !== lastRunStatus.current) {
      if (st === 'running' || st === 'waiting_user' || st === 'paused') setRunOpen(true)
      else if (lastRunStatus.current === 'running') setRunOpen(false)
      lastRunStatus.current = st
    }
  }, [run?.status])

  const active = state.data?.model
  const activeLabel = active
    ? `${HARNESS[harnessOf({ harness: active.harness })].label}${active.model && !isDefaultModel(active.model) ? ` · ${active.model}` : ''}${active.effort ? ` (${effortLabel(active.effort)})` : ''}`
    : null

  const isRunning = run?.status === 'running'
  const isWaiting = run?.status === 'waiting_user'
  const isPaused = run?.status === 'paused'
  const isSteerable = !!run?.canSteer
  const showRunCard = !!run && (isRunning || isWaiting || isPaused || run.plan.length > 0 || run.steps.length > 0 || !!run.scratchpad)
  const mutating = send.isPending || steer.isPending || pause.isPending || resume.isPending || stopRun.isPending

  const submit = () => {
    const text = draft.trim()
    if (!text || mutating || !state.data || state.error) return
    if (run && isRunning && run.canSteer) {
      steer.mutate({ runId: run.id, message: text })
      return
    }
    if (run && (isWaiting || isPaused) && run.canResume) {
      resume.mutate({ runId: run.id, message: text })
      return
    }
    if (!state.data.busy) send.mutate()
  }

  const runStatusLabel =
    isRunning ? (state.data?.status ?? 'Running…')
      : isWaiting ? 'Needs you'
      : isPaused ? 'Paused'
      : run?.status === 'completed' ? 'Done'
      : run?.status === 'failed' ? 'Failed'
      : run?.status === 'cancelled' ? 'Stopped'
      : null

  const placeholder =
    isRunning && isSteerable ? 'Steer the agent mid-run…'
      : (isWaiting || isPaused) && run?.canResume ? 'Optional guidance before continuing…'
      : 'Message browser agent…'

  return (
    <aside aria-label="Browser chat" className="flex min-h-0 flex-1 flex-col gap-2 rounded-2xl border bg-background px-3 py-2 md:max-w-sm md:p-3">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <div className="min-w-0">
          <h2 className="text-sm leading-tight font-semibold">Browser chat</h2>
          {activeLabel && <p className="truncate text-[11px] leading-tight text-muted-foreground">{activeLabel}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="icon-sm" variant="ghost" aria-label="Clear browser chat" title="Clear browser chat"
            disabled={!turns?.length || clear.isPending || !!state.data?.busy}
            onClick={async () => {
              if (await confirmAction({ title: 'Clear browser chat?', description: 'Removes your Browser chat messages and finished runs. The shared browser and settings stay.', action: 'Clear' })) clear.mutate()
            }}><Eraser /></Button>
          {onOpenSettings && <Button size="icon-sm" variant="ghost" aria-label="Browser agent settings" title="Browser agent settings" onClick={onOpenSettings}><SlidersHorizontal /></Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Close browser chat" onClick={onClose}><X /></Button>
        </div>
      </div>

      {state.data?.otherMemberBusy && (
        <div className="flex items-center justify-between gap-2 rounded-xl border bg-surface px-2.5 py-1.5 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">Another member’s browser run is active…</span>
          {state.data.canStop && (
            <Button size="xs" variant="outline" disabled={stopRun.isPending} onClick={() => stopRun.mutate(undefined)}>
              <Square className="size-3" />Stop
            </Button>
          )}
        </div>
      )}

      {run && isWaiting && (
        <div role="status" className="flex flex-col gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Action needed in the browser</p>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{run.pauseReason ?? 'Take over in the shared browser, then click Continue.'}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {run.canResume && (
              <Button size="xs" disabled={mutating} onClick={() => resume.mutate({ runId: run.id, message: draft.trim() || undefined })}>
                <Play className="size-3" />Continue
              </Button>
            )}
            {run.canStop && (
              <Button size="xs" variant="outline" disabled={mutating} onClick={() => stopRun.mutate(run.id)}>
                <Square className="size-3" />Stop
              </Button>
            )}
          </div>
        </div>
      )}

      {run && isPaused && (
        <div role="status" className="flex flex-col gap-1.5 rounded-xl border bg-surface px-2.5 py-2 text-xs">
          <p className="font-medium">Run paused (step {run.stepCount}/{run.maxSteps})</p>
          {run.pauseReason && <p className="whitespace-pre-wrap text-muted-foreground">{run.pauseReason}</p>}
          <div className="flex items-center gap-1.5">
            {run.canResume && (
              <Button size="xs" disabled={mutating} onClick={() => resume.mutate({ runId: run.id, message: draft.trim() || undefined })}>
                <Play className="size-3" />Resume
              </Button>
            )}
            {run.canStop && (
              <Button size="xs" variant="outline" disabled={mutating} onClick={() => stopRun.mutate(run.id)}>
                <Square className="size-3" />Stop
              </Button>
            )}
          </div>
        </div>
      )}

      {showRunCard && run && (
        <div className="rounded-xl border bg-surface/60 text-xs">
          <div className="flex items-center justify-between gap-1.5 px-2.5 py-1.5">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setRunOpen((v) => !v)}>
              {runOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              {isRunning && <Spinner className="size-3 shrink-0" />}
              <span className="truncate font-medium">{runStatusLabel}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">({run.stepCount}/{run.maxSteps})</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              {run.canPause && (
                <Button size="icon-xs" variant="ghost" aria-label="Pause run" title="Pause run" disabled={mutating} onClick={() => pause.mutate(run.id)}>
                  <Pause className="size-3" />
                </Button>
              )}
              {run.canResume && (
                <Button size="icon-xs" variant="ghost" aria-label="Resume run" title="Resume run" disabled={mutating} onClick={() => resume.mutate({ runId: run.id, message: draft.trim() || undefined })}>
                  <Play className="size-3" />
                </Button>
              )}
              {run.canStop && (
                <Button size="icon-xs" variant="ghost" aria-label="Stop run" title="Stop run" disabled={mutating} onClick={() => stopRun.mutate(run.id)}>
                  <Square className="size-3" />
                </Button>
              )}
            </div>
          </div>

          {runOpen && (
            <div className="space-y-2 border-t px-2.5 py-2">
              {run.plan.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <ListChecks className="size-3" />Plan
                  </div>
                  <ul className="space-y-0.5">
                    {run.plan.map((item) => (
                      <li key={item.id} className="flex items-start gap-1.5 leading-snug">
                        {item.status === 'done'
                          ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-500" />
                          : item.status === 'in_progress'
                          ? <CircleDot className="mt-0.5 size-3 shrink-0 text-primary" />
                          : <Circle className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
                        <span className={item.status === 'done' || item.status === 'skipped' ? 'text-muted-foreground line-through' : ''}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {run.pendingSteering.length > 0 && (
                <div className="space-y-0.5">
                  <p className="text-[11px] font-medium text-muted-foreground">Queued guidance</p>
                  {run.pendingSteering.map((msg, i) => (
                    <p key={i} className="rounded-lg bg-background px-2 py-1 text-[11px]">{msg}</p>
                  ))}
                </div>
              )}

              {run.steps.length > 0 && (
                <div>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setStepsOpen((v) => !v)}>
                    {stepsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    Steps ({run.steps.length})
                  </button>
                  {stepsOpen && (
                    <ol className="mt-1 max-h-36 space-y-1 overflow-y-auto pr-1 text-[11px]">
                      {run.steps.map((s) => (
                        <li key={s.id} className="rounded-md bg-background/80 px-2 py-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium">#{s.seq} {s.summary}</span>
                          </div>
                          {s.url && <p className="truncate text-[10px] text-muted-foreground">{s.url}</p>}
                          {s.error && <p className="text-[10px] text-destructive">{s.error}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {run.scratchpad && (
                <div>
                  <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setNotesOpen((v) => !v)}>
                    {notesOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    <FileText className="size-3" />Notes ({run.scratchpad.length} chars)
                  </button>
                  {notesOpen && (
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/80 p-2 font-sans text-[11px] text-muted-foreground">{run.scratchpad}</pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div role="log" aria-label="Conversation" aria-live="polite" className="min-h-0 flex-1 space-y-2.5 overflow-y-auto text-sm">
        {state.isPending && <Spinner />}
        <ErrorAlert error={state.error} />
        {!state.isPending && !state.error && !turns?.length && (
          <p className="py-2 text-xs text-muted-foreground">Ask the agent to browse, research across pages, fill forms, or monitor workflows. Actions are visible to everyone watching.</p>
        )}
        {!state.error && turns?.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-1.5">
            <p className="ml-6 self-end whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-1.5">{turn.message}</p>
            <p className="mr-4 whitespace-pre-wrap break-words">
              {turn.reply ?? (isWaiting ? 'Waiting for you in the browser…' : isPaused ? 'Paused.' : state.data?.status ?? 'Working…')}
            </p>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <ErrorAlert error={send.error ?? steer.error ?? pause.error ?? resume.error ?? clear.error ?? stopRun.error} />
        <div className="flex items-end gap-1.5">
          <Textarea aria-label="Message the browser assistant" placeholder={placeholder} maxLength={3000} rows={1}
            className="max-h-24 min-h-10 flex-1 py-2" value={draft} disabled={send.isPending || steer.isPending || resume.isPending}
            onChange={(e) => { setDraft(e.target.value); requestId.current = crypto.randomUUID() }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
          {state.data?.canStop && !draft.trim() ? (
            <Button size="icon" type="button" variant="outline" className="size-10 shrink-0" aria-label="Stop" title="Stop" disabled={stopRun.isPending} onClick={() => stopRun.mutate(run?.id)}>
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button size="icon" type="submit" className="size-10 shrink-0"
              aria-label={isSteerable ? 'Send guidance' : 'Send'}
              title={isSteerable ? 'Send guidance' : 'Send'}
              disabled={!draft.trim() || !state.data || !!state.error || mutating || (state.data.busy && !isSteerable)}>
              {send.isPending || steer.isPending || resume.isPending ? <Spinner /> : <Send />}
            </Button>
          )}
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
          <FieldDescription>{t3 ? 'Choose a T3 Code model that can run with tools disabled.' : 'The model used to read the shared browser and run browser actions.'}</FieldDescription>
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
