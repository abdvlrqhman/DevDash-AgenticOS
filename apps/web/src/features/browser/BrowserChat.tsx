import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AppWindow,
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  CornerDownLeft,
  Eraser,
  FileSearch,
  FileText,
  Globe,
  Hand,
  Keyboard,
  ListChecks,
  ListFilter,
  LoaderCircle,
  MessageSquarePlus,
  MousePointerClick,
  Send,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon,
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
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { Prose } from '../claude/Prose'
import { FALLBACK_MODELS, profilesQuery, useOfferedModels } from '../claude/data'
import { HARNESS, agentCapabilities, harnessOf, type Harness } from '../claude/harness'
import { effortLabel, effortLevels, isDefaultModel, modelLabel, type ModelInfo } from '../claude/models'

const chat = api.api.browser.chat

type BrowserModel = { harness: string; profile: string; model: string; effort: string | null }
type ChatState = Awaited<ReturnType<typeof fetchState>>
type BrowserRun = NonNullable<ChatState['run']>
type BrowserStep = BrowserRun['steps'][number]

async function fetchState() {
  return unwrap(chat.$get())
}

/** Crisp filled glyphs that stay sharp at small sizes (unlike thin stroked Pause/Square icons). */
function PauseGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="3.5" y="2.5" width="3.25" height="11" rx="1" />
      <rect x="9.25" y="2.5" width="3.25" height="11" rx="1" />
    </svg>
  )
}

function PlayGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M4.25 2.8a.75.75 0 0 1 1.14-.64l8 5.2a.75.75 0 0 1 0 1.28l-8 5.2a.75.75 0 0 1-1.14-.64V2.8Z" />
    </svg>
  )
}

function StopGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="2" />
    </svg>
  )
}

function shortUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname && u.pathname !== '/' ? u.pathname.slice(0, 28) : ''
    return `${host}${path}${u.pathname.length > 28 ? '…' : ''}`
  } catch {
    return raw.slice(0, 40)
  }
}

function stepIcon(step: BrowserStep): LucideIcon {
  if (step.error) return AlertCircle
  const kind = typeof step.action?.kind === 'string' ? step.action.kind : ''
  switch (kind) {
    case 'navigate':
    case 'open':
      return Globe
    case 'click':
      return MousePointerClick
    case 'fill':
    case 'type':
      return Keyboard
    case 'select':
      return ListFilter
    case 'press':
      return CornerDownLeft
    case 'scroll':
      return ArrowUpDown
    case 'wait':
    case 'wait_for':
      return Clock
    case 'switch_tab':
    case 'close_tab':
      return AppWindow
    case 'extract_text':
      return FileSearch
    case 'ask_user':
      return Hand
    case 'user_steer':
      return MessageSquarePlus
    default:
      return Globe
  }
}

function stepThought(step: BrowserStep): string | null {
  return typeof step.action?.thought === 'string' && step.action.thought.trim() ? step.action.thought.trim() : null
}

function BrowserProcessCard({
  run,
  fallbackStatus,
  mutating,
  draft,
  onPause,
  onResume,
  onStop,
}: {
  run: BrowserRun
  fallbackStatus?: string | null
  mutating: boolean
  draft: string
  onPause: (runId: number) => void
  onResume: (runId: number, message?: string) => void
  onStop: (runId: number) => void
}) {
  const isRunning = run.status === 'running'
  const isWaiting = run.status === 'waiting_user'
  const isPaused = run.status === 'paused'
  const isActive = isRunning || isWaiting || isPaused
  const isFailed = run.status === 'failed'
  const isCancelled = run.status === 'cancelled'

  const [open, setOpen] = useState(isActive)
  const [showAllSteps, setShowAllSteps] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const prevStatus = useRef(run.status)

  // Auto-open while active/waiting/paused; smoothly fold to a compact summary bar once finished.
  useEffect(() => {
    if (run.status !== prevStatus.current) {
      if (run.status === 'running' || run.status === 'waiting_user' || run.status === 'paused') setOpen(true)
      else setOpen(false)
      prevStatus.current = run.status
    }
  }, [run.status])

  const donePlan = run.plan.filter((p) => p.status === 'done').length
  const activePlan = run.plan.find((p) => p.status === 'in_progress')
  const liveHost = shortUrl(run.liveUrl ?? run.steps.at(-1)?.url)
  const liveHeadline = isRunning
    ? (run.liveStatus ?? fallbackStatus ?? 'Working in browser…')
    : isWaiting
    ? 'Needs you in browser'
    : isPaused
    ? 'Browser run paused'
    : isFailed
    ? 'Browser run failed'
    : isCancelled
    ? 'Browser run stopped'
    : 'Browser process'

  const completedSummaryParts = [
    run.steps.length > 0 ? `${run.steps.length} ${run.steps.length === 1 ? 'action' : 'actions'}` : null,
    run.plan.length > 0 ? `${donePlan}/${run.plan.length} tasks` : null,
    run.scratchpad ? 'notes' : null,
  ].filter(Boolean)

  const visibleSteps = isActive && !showAllSteps && run.steps.length > 4 ? run.steps.slice(-4) : run.steps
  const hiddenStepCount = run.steps.length - visibleSteps.length

  const thinkingText = isRunning
    ? (run.liveThought || activePlan?.text || null)
    : null

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border text-xs transition-colors',
        isRunning && 'border-primary/30 bg-primary/[0.04]',
        isWaiting && 'border-amber-500/45 bg-amber-500/[0.07]',
        isPaused && 'border-border bg-surface/75',
        !isActive && !isFailed && !isCancelled && 'border-border/70 bg-surface/45',
        (isFailed || isCancelled) && 'border-destructive/25 bg-destructive/[0.04]',
      )}
    >
      {/* Header strip — distinct browser process bar */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={cn(
              'relative flex size-6 shrink-0 items-center justify-center rounded-lg border',
              isRunning && 'border-primary/30 bg-primary/10 text-primary',
              isWaiting && 'border-amber-500/40 bg-amber-500/15 text-amber-500',
              isPaused && 'border-border bg-background/80 text-muted-foreground',
              run.status === 'completed' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
              (isFailed || isCancelled) && 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            {isRunning ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : isWaiting ? (
              <Hand className="size-3.5" />
            ) : isPaused ? (
              <PauseGlyph className="size-2.5" />
            ) : run.status === 'completed' ? (
              <Check className="size-3.5" strokeWidth={2.5} />
            ) : (
              <AlertCircle className="size-3.5" />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={cn('truncate font-medium', !isActive && 'text-foreground/90')}>
                {liveHeadline}
              </span>
              {isActive && (
                <span className="shrink-0 rounded-md border border-border/60 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                  {run.stepCount}/{run.maxSteps}
                </span>
              )}
              {!isActive && completedSummaryParts.length > 0 && (
                <span className="truncate text-[11px] text-muted-foreground">
                  · {completedSummaryParts.join(' · ')}
                </span>
              )}
            </div>
            {isActive && liveHost && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Globe className="size-3 shrink-0 opacity-70" />
                <span className="truncate font-mono text-[10.5px]">{liveHost}</span>
              </div>
            )}
          </div>

          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
        </button>

        {(run.canPause || run.canResume || run.canStop) && (
          <div className="flex shrink-0 items-center gap-1.5 border-l border-border/60 pl-2">
            {run.canPause && (
              <button
                type="button"
                aria-label="Pause run"
                title="Pause run"
                disabled={mutating}
                onClick={() => onPause(run.id)}
                className="inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground/85 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <PauseGlyph className="size-3" />
              </button>
            )}
            {run.canResume && (
              <button
                type="button"
                aria-label="Resume run"
                title="Resume run"
                disabled={mutating}
                onClick={() => onResume(run.id, draft.trim() || undefined)}
                className="inline-flex size-6 items-center justify-center rounded-full border border-primary/40 bg-primary/15 text-primary transition-colors hover:bg-primary/25 disabled:pointer-events-none disabled:opacity-50"
              >
                <PlayGlyph className="size-3" />
              </button>
            )}
            {run.canStop && (
              <button
                type="button"
                aria-label="Stop run"
                title="Stop run"
                disabled={mutating}
                onClick={() => onStop(run.id)}
                className="inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground/85 transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
              >
                <StopGlyph className="size-2.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Expandable process details */}
      {open && (
        <div className="space-y-2.5 border-t border-border/60 px-2.5 py-2.5">
          {/* Live thinking callout */}
          {thinkingText && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-background/65 px-2.5 py-1.5">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-foreground/85">{thinkingText}</p>
            </div>
          )}

          {/* Plan checklist */}
          {run.plan.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                <span className="flex items-center gap-1"><ListChecks className="size-3" />Plan</span>
                <span className="font-mono">{donePlan}/{run.plan.length}</span>
              </div>
              <ul className="space-y-1">
                {run.plan.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 leading-snug">
                    {item.status === 'done' ? (
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                    ) : item.status === 'in_progress' ? (
                      <span className="relative mt-1 flex size-2.5 shrink-0 items-center justify-center">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50" />
                        <span className="relative inline-flex size-2 rounded-full bg-primary" />
                      </span>
                    ) : (
                      <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                    <span
                      className={cn(
                        'text-[11.5px]',
                        item.status === 'done' || item.status === 'skipped'
                          ? 'text-muted-foreground line-through'
                          : item.status === 'in_progress'
                          ? 'font-medium text-foreground'
                          : 'text-foreground/80',
                      )}
                    >
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Queued mid-run steering guidance */}
          {run.pendingSteering.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Queued guidance</p>
              {run.pendingSteering.map((msg, i) => (
                <div key={i} className="flex items-start gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2 py-1 text-[11px]">
                  <MessageSquarePlus className="mt-0.5 size-3 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">{msg}</span>
                </div>
              ))}
            </div>
          )}

          {/* Browser Action Timeline */}
          {run.steps.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                <span className="flex items-center gap-1"><Globe className="size-3" />Browser activity</span>
                {hiddenStepCount > 0 && (
                  <button
                    type="button"
                    className="normal-case text-[11px] font-normal text-primary hover:underline"
                    onClick={() => setShowAllSteps(true)}
                  >
                    Show all {run.steps.length}
                  </button>
                )}
              </div>
              <ol
                className={cn(
                  'relative space-y-1.5 before:absolute before:top-2.5 before:bottom-2.5 before:left-[9px] before:w-px before:bg-border/80',
                  !isActive && 'max-h-48 overflow-y-auto pr-1',
                )}
              >
                {visibleSteps.map((s) => {
                  const Icon = stepIcon(s)
                  const host = shortUrl(s.url)
                  const thought = stepThought(s)
                  return (
                    <li key={s.id} className="relative flex items-start gap-2">
                      <span
                        className={cn(
                          'relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background',
                          s.error ? 'border-destructive/50 text-destructive' : 'border-border/80 text-muted-foreground',
                        )}
                      >
                        <Icon className="size-2.5" />
                      </span>
                      <div className="min-w-0 flex-1 leading-snug">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11.5px] font-medium text-foreground/90">{s.summary}</span>
                          {host && (
                            <span className="shrink-0 max-w-28 truncate font-mono text-[10px] text-muted-foreground" title={s.url}>
                              {host}
                            </span>
                          )}
                        </div>
                        {thought && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{thought}</p>
                        )}
                        {s.error && (
                          <p className="mt-0.5 text-[10.5px] text-destructive">{s.error}</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}

          {/* Scratchpad / Working Notes */}
          {run.scratchpad && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setNotesOpen((v) => !v)}
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', notesOpen && 'rotate-90')} />
                <FileText className="size-3" />
                Working notes ({run.scratchpad.length} chars)
              </button>
              {notesOpen && (
                <pre className="mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/80 p-2 font-sans text-[11px] text-muted-foreground">
                  {run.scratchpad}
                </pre>
              )}
            </div>
          )}

          {/* Inline Human-in-the-loop / Paused takeover footer */}
          {(isWaiting || isPaused) && (
            <div
              role="status"
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-2.5',
                isWaiting ? 'border-amber-500/40 bg-amber-500/10' : 'border-border/80 bg-background/80',
              )}
            >
              <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/90">
                {run.pauseReason ?? (isWaiting ? 'Take over in the shared browser, then click Continue.' : 'Paused. Click Resume to continue.')}
              </p>
              <div className="flex items-center gap-1.5">
                {run.canResume && (
                  <Button size="xs" disabled={mutating} onClick={() => onResume(run.id, draft.trim() || undefined)}>
                    <PlayGlyph className="size-2.5" />
                    {isWaiting ? 'Continue' : 'Resume'}
                  </Button>
                )}
                {run.canStop && (
                  <Button size="xs" variant="outline" disabled={mutating} onClick={() => onStop(run.id)}>
                    <StopGlyph className="size-2.5" />
                    Stop
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BrowserStartingCard({ status }: { status?: string | null }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.04] px-2.5 py-2 text-xs">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
        <LoaderCircle className="size-3.5 animate-spin" />
      </span>
      <span className="truncate font-medium text-foreground/90">{status ?? 'Connecting to browser…'}</span>
    </div>
  )
}

export function BrowserChat({ userId, onClose, onOpenSettings }: { userId: number; onClose: () => void; onOpenSettings?: () => void }) {
  const qc = useQueryClient()
  const key = ['browser-chat', userId]
  const state = useQuery({
    queryKey: key,
    queryFn: fetchState,
    retry: false,
    refetchInterval: (q) => {
      const d = q.state.data
      if (d?.busy || d?.run?.status === 'running') return 1500
      if (d?.run?.status === 'waiting_user' || d?.run?.status === 'paused') return 5000
      return 20_000
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  })
  const [draft, setDraft] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const bottom = useRef<HTMLDivElement>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: key })

  const send = useMutation({
    mutationFn: () => unwrap(chat.$post({ json: { message: draft.trim(), requestId: requestId.current } })),
    onSuccess: async () => {
      requestId.current = crypto.randomUUID()
      setDraft('')
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
  const runsByTurn = useMemo(() => {
    const map = new Map<number, BrowserRun>()
    for (const r of state.data?.runs ?? (run ? [run] : [])) {
      if (r.turnId !== null && !map.has(r.turnId)) map.set(r.turnId, r)
    }
    return map
  }, [state.data?.runs, run])

  const last = turns?.at(-1)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [last?.id, last?.reply, run?.stepCount, run?.status])

  const active = state.data?.model
  const activeLabel = active
    ? `${HARNESS[harnessOf({ harness: active.harness })].label}${active.model && !isDefaultModel(active.model) ? ` · ${active.model}` : ''}${active.effort ? ` (${effortLabel(active.effort)})` : ''}`
    : null

  const isRunning = run?.status === 'running'
  const isWaiting = run?.status === 'waiting_user'
  const isPaused = run?.status === 'paused'
  const isSteerable = !!run?.canSteer
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
              <StopGlyph className="size-2.5" />Stop
            </Button>
          )}
        </div>
      )}

      <div role="log" aria-label="Conversation" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5 text-sm">
        {state.isPending && <Spinner />}
        <ErrorAlert error={state.error} />
        {!state.isPending && !state.error && !turns?.length && (
          <p className="py-2 text-xs text-muted-foreground">Ask the agent to browse, research across pages, fill forms, or monitor workflows. Actions are visible to everyone watching.</p>
        )}
        {!state.error && turns?.map((turn) => {
          const turnRun = runsByTurn.get(turn.id)
          const showProcess = !!turnRun && (
            turnRun.status === 'running' ||
            turnRun.status === 'waiting_user' ||
            turnRun.status === 'paused' ||
            turnRun.steps.length > 0 ||
            turnRun.plan.length > 0 ||
            !!turnRun.scratchpad ||
            turnRun.status === 'failed' ||
            turnRun.status === 'cancelled'
          )
          return (
            <div key={turn.id} className="flex flex-col gap-2">
              <p className="ml-6 self-end whitespace-pre-wrap break-words rounded-2xl bg-surface px-3 py-1.5 text-sm">{turn.message}</p>
              {showProcess && turnRun ? (
                <BrowserProcessCard
                  run={turnRun}
                  fallbackStatus={turnRun.id === run?.id ? state.data?.status : null}
                  mutating={mutating}
                  draft={draft}
                  onPause={(id) => pause.mutate(id)}
                  onResume={(id, message) => resume.mutate({ runId: id, message })}
                  onStop={(id) => stopRun.mutate(id)}
                />
              ) : !turn.reply ? (
                <BrowserStartingCard status={state.data?.status} />
              ) : null}
              {turn.reply && (
                <div className="min-w-0 pr-1">
                  <Prose text={turn.reply} />
                </div>
              )}
            </div>
          )
        })}
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
              <StopGlyph className="size-3.5" />
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
