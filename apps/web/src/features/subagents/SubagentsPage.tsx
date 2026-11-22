import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock,
  ExternalLink, History, Loader2, Pencil, Play, Plus, Sparkles,
  Square, Trash2, Bot, Zap, SlidersHorizontal, X,
} from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { FALLBACK_MODELS, modeLabel, profilesQuery, relativeTime, useOfferedModels, type PermissionMode } from '../claude/data'
import { agentCapabilities, HARNESS, HARNESSES, type Harness } from '../claude/harness'
import { ModelField, ThinkingLevelField } from '../claude/ModelChoices'
import { effortLevels, type ModelInfo } from '../claude/models'
import { Prose } from '../claude/Prose'
import { SessionView } from '../claude/SessionPage'
import { projectsQuery } from '../work/data'
import {
  CALLER_LABELS, COLOR_LIST, COLOR_STYLES, ICON_LIST, SCOPE_LABELS,
  SubagentIconGlyph, formatDuration, pickFastSmartModel, shortModelLabel, statusMeta, subagentRunQuery,
  subagentRunsQuery, subagentsOverviewQuery, useLiveSubagents, useStopSubagentRun,
  type CustomSubagent, type SubagentColor, type SubagentDefaults, type SubagentIcon, type SubagentRun,
  type SubagentRunStatus, type SubagentScope, type SubagentTemplate,
} from './data'

import type { SubagentsSearch } from './data'

function slugify(text: string) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

export function SubagentsPage() {
  useLiveSubagents()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as SubagentsSearch

  const overview = useQuery(subagentsOverviewQuery)
  const [tab, setTab] = useState<'agents' | 'history'>(search.tab ?? 'agents')
  const [filterSubagent, setFilterSubagent] = useState<number | undefined>(search.subagent)
  const [filterStatus, setFilterStatus] = useState<SubagentRunStatus | ''>('')
  const [selectedRunId, setSelectedRunId] = useState<number | null>(search.run ?? null)
  const [editorState, setEditorState] = useState<{ open: boolean; editing: CustomSubagent | null; template: SubagentTemplate | null }>({
    open: false, editing: null, template: null,
  })
  const [runModalSubagent, setRunModalSubagent] = useState<CustomSubagent | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)

  // Keep local state in sync when navigated from sidebar/Hamasa indicator links.
  useEffect(() => {
    if (search.tab) setTab(search.tab)
    if (search.run) setSelectedRunId(search.run)
    if (search.subagent !== undefined) setFilterSubagent(search.subagent)
  }, [search.tab, search.run, search.subagent])

  const openRun = (runId: number | null) => {
    setSelectedRunId(runId)
    void navigate({
      to: '/subagents',
      search: { tab, ...(filterSubagent ? { subagent: filterSubagent } : {}), ...(runId ? { run: runId } : {}) },
      replace: true,
    })
  }

  const runsQuery = useQuery({
    ...subagentRunsQuery({
      subagentId: filterSubagent,
      status: filterStatus || undefined,
      limit: 100,
    }),
    enabled: tab === 'history',
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      unwrap(api.api.subagents[':id'].$patch({ param: { id: String(id) }, json: { enabled } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['subagents'] }),
    onError: (e) => toast.error(e.message),
  })

  const removeSubagent = useMutation({
    mutationFn: (id: number) => unwrap(api.api.subagents[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => {
      toast.success('Subagent deleted')
      void qc.invalidateQueries({ queryKey: ['subagents'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const clearHistory = useMutation({
    mutationFn: (subagentId?: number) => unwrap(api.api.subagents.runs.$delete({
      query: subagentId ? { subagentId: String(subagentId) } : {},
    })),
    onSuccess: () => {
      toast.success('Finished runs cleared')
      void qc.invalidateQueries({ queryKey: ['subagents'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const stopRun = useStopSubagentRun()

  const data = overview.data
  const subagents = data?.subagents ?? []
  const activeRuns = data?.activeRuns ?? []
  const templates = data?.templates ?? []
  const subagentDefaults: SubagentDefaults | undefined = data?.defaults
  const historyRuns = tab === 'history' ? (runsQuery.data?.runs ?? data?.recentRuns ?? []) : (data?.recentRuns ?? [])

  // Tick elapsed timers once per second while any subagent is running.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!activeRuns.length) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [activeRuns.length])

  const existingSlugs = useMemo(() => new Set(subagents.map((s) => s.slug)), [subagents])

  return (
    <>
      <PageHeader
        title="Subagents"
        description="Custom specialist agents for Hamasa and your sessions, with live activity and run history"
        actions={
          <Button size="sm" onClick={() => setEditorState({ open: true, editing: null, template: null })}>
            <Plus />New subagent
          </Button>
        }
      />
      <PageBody>
        {overview.error && <ErrorAlert error={overview.error} />}

        {/* Live running / waiting subagents strip */}
        {activeRuns.length > 0 && (
          <section className="flex flex-col gap-2.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                Live activity ({activeRuns.length} active)
              </div>
              <span className="text-xs text-muted-foreground">Updates automatically</span>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {activeRuns.map((run) => {
                const color = COLOR_STYLES[run.subagentColor as SubagentColor] ?? COLOR_STYLES.blue
                const meta = statusMeta(run.status)
                return (
                  <div
                    key={run.id}
                    className="flex flex-col gap-2 rounded-xl border bg-background/90 p-3 shadow-xs transition-colors hover:border-foreground/20"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border', color.badge)}>
                        <SubagentIconGlyph icon={run.subagentIcon} className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{run.subagentName}</span>
                          <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', meta.badge)}>
                            <meta.icon className={cn('size-2.5', meta.spin && 'animate-spin')} />
                            {meta.label}
                          </Badge>
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                            {CALLER_LABELS[run.callerKind] ?? run.callerKind}
                          </Badge>
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{run.task}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-xs">
                      <Activity className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span className="min-w-0 flex-1 truncate font-medium">{run.activity || 'Working…'}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'} · {formatDuration(run.startedAt, run.finishedAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button variant="outline" size="xs" onClick={() => openRun(run.id)}>
                        Inspect progress
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={stopRun.isPending}
                        onClick={() => stopRun.mutate(run.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Square className="size-3" />Stop
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'agents' | 'history')} className="gap-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="agents">
                <Bot className="size-3.5" />
                My subagents
                <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{subagents.length}</span>
              </TabsTrigger>
              <TabsTrigger value="history">
                <History className="size-3.5" />
                Run history
                {activeRuns.length > 0 && (
                  <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 text-[11px] text-emerald-600 tabular-nums dark:text-emerald-400">
                    {activeRuns.length} live
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {tab === 'agents' && subagents.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setShowTemplates((v) => !v)}>
                <Sparkles className="size-3.5" />
                {showTemplates ? 'Hide templates' : 'Starter templates'}
              </Button>
            )}
          </div>

          <TabsContent value="agents" className="flex flex-col gap-6">
            <SubagentDefaultModelCard defaults={subagentDefaults} />
            {overview.isLoading ? (
              <div className="grid gap-3 md:grid-cols-2">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
              </div>
            ) : (
              <>
                {subagents.length === 0 ? (
                  <Card className="flex flex-col items-center gap-3 rounded-2xl border-dashed p-8 text-center">
                    <div className="flex size-12 items-center justify-center rounded-2xl bg-surface text-muted-foreground">
                      <Bot className="size-6" />
                    </div>
                    <div className="max-w-md">
                      <h2 className="text-base font-semibold">Create your custom subagents</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Build specialized agents for web search, codebase search, deep research, code review, or your own custom workflows.
                        Both Hamasa and your normal coding sessions can delegate to them automatically — or you can run them right here.
                      </p>
                    </div>
                    <Button onClick={() => setEditorState({ open: true, editing: null, template: null })}>
                      <Plus />Create custom subagent
                    </Button>
                  </Card>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {subagents.map((sa) => {
                      const color = COLOR_STYLES[sa.color as SubagentColor] ?? COLOR_STYLES.blue
                      const live = activeRuns.find((r) => r.subagentId === sa.id)
                      const lastMeta = sa.lastRunStatus ? statusMeta(sa.lastRunStatus) : null
                      return (
                        <Card
                          key={sa.id}
                          className={cn(
                            'flex flex-col gap-3 rounded-2xl p-4 transition-colors',
                            !sa.enabled && 'opacity-70',
                            live && 'border-emerald-500/35 bg-emerald-500/[0.02]',
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl border', color.badge)}>
                              <SubagentIconGlyph icon={sa.icon} className="size-5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="truncate text-sm font-semibold">{sa.name}</h3>
                                <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                  @{sa.slug}
                                </code>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                                  {SCOPE_LABELS[sa.scope]}
                                </Badge>
                                {(sa.harness || subagentDefaults?.harness) && (
                                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                                    {HARNESS[(sa.harness ?? subagentDefaults?.harness) as Harness]?.label ?? (sa.harness ?? subagentDefaults?.harness)}
                                  </Badge>
                                )}
                                {(() => {
                                  const effModel = sa.model ?? (!sa.harness ? subagentDefaults?.model : null)
                                  const effEffort = sa.model ? sa.effort : (!sa.harness ? subagentDefaults?.effort : null)
                                  const label = shortModelLabel(effModel, effEffort)
                                  if (!label) return null
                                  return (
                                    <Badge variant="outline" className="h-5 max-w-48 truncate px-1.5 text-[10px]" title={sa.model ? 'Custom model override' : 'Default subagent model'}>
                                      {label}
                                    </Badge>
                                  )
                                })()}
                              </div>
                            </div>
                            <Switch
                              aria-label={`Enable ${sa.name}`}
                              checked={sa.enabled}
                              disabled={toggleEnabled.isPending}
                              onCheckedChange={(checked) => toggleEnabled.mutate({ id: sa.id, enabled: checked })}
                            />
                          </div>

                          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {sa.description || sa.instructions}
                          </p>

                          {live ? (
                            <button
                              type="button"
                              onClick={() => openRun(live.id)}
                              className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-emerald-500/10"
                            >
                              <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-600 dark:text-emerald-400" />
                              <span className="min-w-0 flex-1 truncate font-medium text-emerald-700 dark:text-emerald-400">
                                {live.activity || 'Running…'}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">View</span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {lastMeta ? (
                                <>
                                  <span className={cn('size-1.5 rounded-full', lastMeta.dot)} />
                                  <span>Last run {lastMeta.label.toLowerCase()}</span>
                                  {sa.lastRunAt && <span>· {relativeTime(sa.lastRunAt)}</span>}
                                </>
                              ) : (
                                <span>No runs yet</span>
                              )}
                              <span className="ml-auto tabular-nums">{sa.totalRuns} {sa.totalRuns === 1 ? 'run' : 'runs'}</span>
                            </div>
                          )}

                          <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t pt-3">
                            <Button size="xs" variant="default" onClick={() => setRunModalSubagent(sa)}>
                              <Play className="size-3" />Run
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                setFilterSubagent(sa.id)
                                setTab('history')
                              }}
                            >
                              <History className="size-3" />History
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="ml-auto"
                              onClick={() => setEditorState({ open: true, editing: sa, template: null })}
                            >
                              <Pencil className="size-3" />Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={`Delete ${sa.name}`}
                              onClick={async () => {
                                if (await confirmAction({
                                  title: `Delete "${sa.name}"?`,
                                  description: 'Existing run history will be kept for reference, but Hamasa and sessions will no longer use this subagent.',
                                  action: 'Delete',
                                  destructive: true,
                                })) {
                                  removeSubagent.mutate(sa.id)
                                }
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        </Card>
                      )
                    })}
                  </div>
                )}

                {/* Starter templates */}
                {(subagents.length === 0 || showTemplates) && templates.length > 0 && (
                  <section className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold">Starter templates</h2>
                        <p className="text-xs text-muted-foreground">Pick a ready-made specialist and customize its instructions if you like.</p>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {templates.map((tpl) => {
                        const color = COLOR_STYLES[tpl.color as SubagentColor] ?? COLOR_STYLES.blue
                        const installed = existingSlugs.has(tpl.slug)
                        return (
                          <Card key={tpl.slug} className="flex flex-col gap-2.5 rounded-2xl p-3.5">
                            <div className="flex items-center gap-2.5">
                              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border', color.badge)}>
                                <SubagentIconGlyph icon={tpl.icon} className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold">{tpl.name}</div>
                                <div className="truncate font-mono text-[10px] text-muted-foreground">@{tpl.slug}</div>
                              </div>
                            </div>
                            <p className="line-clamp-2 text-xs text-muted-foreground">{tpl.description}</p>
                            <Button
                              size="xs"
                              variant={installed ? 'outline' : 'secondary'}
                              className="mt-auto w-full"
                              onClick={() => setEditorState({ open: true, editing: null, template: tpl })}
                            >
                              <Plus className="size-3" />{installed ? 'Add another copy' : 'Use template'}
                            </Button>
                          </Card>
                        )
                      })}
                    </div>
                  </section>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="history" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-48">
                <NativeSelect
                  aria-label="Filter by subagent"
                  value={filterSubagent ? String(filterSubagent) : ''}
                  onChange={(e) => setFilterSubagent(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">All subagents</option>
                  {subagents.map((s) => (
                    <option key={s.id} value={String(s.id)}>{s.name} (@{s.slug})</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="w-40">
                <NativeSelect
                  aria-label="Filter by status"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as SubagentRunStatus | '')}
                >
                  <option value="">All statuses</option>
                  <option value="running">Running</option>
                  <option value="waiting">Needs input</option>
                  <option value="completed">Done</option>
                  <option value="failed">Failed</option>
                  <option value="stopped">Stopped</option>
                </NativeSelect>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={clearHistory.isPending || historyRuns.every((r) => r.status === 'running' || r.status === 'waiting')}
                onClick={async () => {
                  if (await confirmAction({
                    title: filterSubagent ? 'Clear finished runs for this subagent?' : 'Clear finished run history?',
                    description: 'Currently active runs stay untouched.',
                    action: 'Clear finished',
                    destructive: true,
                  })) {
                    clearHistory.mutate(filterSubagent)
                  }
                }}
              >
                <Trash2 className="size-3.5" />Clear finished
              </Button>
            </div>

            {runsQuery.isLoading ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
              </div>
            ) : historyRuns.length === 0 ? (
              <Card className="flex flex-col items-center gap-2 rounded-2xl border-dashed p-8 text-center">
                <History className="size-6 text-muted-foreground" />
                <div className="text-sm font-medium">No subagent runs yet</div>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Run a subagent directly from the My subagents tab, or ask Hamasa or any coding session to delegate a task to one of your specialists.
                </p>
              </Card>
            ) : (
              <div className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
                {historyRuns.map((run) => {
                  const color = COLOR_STYLES[run.subagentColor as SubagentColor] ?? COLOR_STYLES.blue
                  const meta = statusMeta(run.status)
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => openRun(run.id)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface"
                    >
                      <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border', color.badge)}>
                        <SubagentIconGlyph icon={run.subagentIcon} className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold">{run.subagentName}</span>
                          <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', meta.badge)}>
                            <meta.icon className={cn('size-2.5', meta.spin && 'animate-spin')} />
                            {meta.label}
                          </Badge>
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                            {CALLER_LABELS[run.callerKind] ?? run.callerKind}
                          </Badge>
                          {run.projectSlug && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{run.projectSlug}</Badge>
                          )}
                          {shortModelLabel(run.model, run.effort) && (
                            <Badge variant="outline" className="h-5 max-w-44 truncate px-1.5 text-[10px] text-muted-foreground">
                              {shortModelLabel(run.model, run.effort)}
                            </Badge>
                          )}
                          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                            <Clock className="size-3" />
                            {formatDuration(run.startedAt, run.finishedAt)}
                            <span>·</span>
                            {relativeTime(run.startedAt)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-1 text-sm text-foreground">{run.task}</p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{run.error || run.activity || 'Completed'}</span>
                          <span className="ml-auto shrink-0 text-[11px] tabular-nums">
                            {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>

      {/* Create / Edit Subagent Modal */}
      <SubagentEditorDialog
        open={editorState.open}
        editing={editorState.editing}
        template={editorState.template}
        subagentDefaults={subagentDefaults}
        onOpenChange={(open) => setEditorState((s) => ({ ...s, open }))}
      />

      {/* Run Now Modal */}
      <RunSubagentDialog
        subagent={runModalSubagent}
        onOpenChange={(open) => { if (!open) setRunModalSubagent(null) }}
        onStarted={(runId) => {
          setRunModalSubagent(null)
          openRun(runId)
        }}
      />

      {/* Run Detail Live Drawer */}
      <RunDetailSheet
        runId={selectedRunId}
        onClose={() => openRun(null)}
      />
    </>
  )
}

function SubagentEditorDialog({
  open,
  editing,
  template,
  subagentDefaults,
  onOpenChange,
}: {
  open: boolean
  editing: CustomSubagent | null
  template: SubagentTemplate | null
  subagentDefaults: SubagentDefaults | undefined
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const profiles = useQuery({ ...profilesQuery, enabled: open }).data
  const projects = useQuery({ ...projectsQuery, enabled: open }).data?.projects ?? []

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [icon, setIcon] = useState<SubagentIcon>('bot')
  const [color, setColor] = useState<SubagentColor>('blue')
  const [scope, setScope] = useState<SubagentScope>('both')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [harness, setHarness] = useState<Harness | ''>('')
  const [profile, setProfile] = useState('default')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('')
  const [defaultProject, setDefaultProject] = useState('')

  useEffect(() => {
    if (!open) return
    if (editing) {
      setName(editing.name)
      setSlug(editing.slug)
      setSlugTouched(true)
      setDescription(editing.description)
      setInstructions(editing.instructions)
      setIcon(editing.icon)
      setColor(editing.color)
      setScope(editing.scope)
      setHarness((editing.harness as Harness | null) ?? '')
      setProfile(editing.profile || 'default')
      setModel(editing.model ?? '')
      setEffort(editing.effort ?? '')
      setPermissionMode((editing.permissionMode as PermissionMode | null) ?? '')
      setDefaultProject(editing.defaultProject ?? '')
      setShowAdvanced(Boolean(editing.harness || editing.model || editing.effort || editing.permissionMode || editing.defaultProject))
    } else if (template) {
      setName(template.name)
      setSlug(template.slug)
      setSlugTouched(false)
      setDescription(template.description)
      setInstructions(template.instructions)
      setIcon(template.icon)
      setColor(template.color)
      setScope(template.scope)
      setHarness('')
      setProfile('default')
      setModel('')
      setEffort('')
      setPermissionMode('')
      setDefaultProject('')
      setShowAdvanced(false)
    } else {
      setName('')
      setSlug('')
      setSlugTouched(false)
      setDescription('')
      setInstructions('')
      setIcon('bot')
      setColor('blue')
      setScope('both')
      setHarness('')
      setProfile('default')
      setModel('')
      setEffort('')
      setPermissionMode('')
      setDefaultProject('')
      setShowAdvanced(false)
    }
  }, [open, editing, template])

  const [customModel, setCustomModel] = useState(false)
  const effectiveHarness: Harness = harness || 'claude'
  const offeredModels = useOfferedModels(profile, effectiveHarness, model || null, open && showAdvanced && !!harness)
  const modelsList: ModelInfo[] = offeredModels?.length
    ? offeredModels
    : effectiveHarness === 'claude'
      ? FALLBACK_MODELS
      : [{ value: '', displayName: 'Default', description: HARNESS[effectiveHarness].defaultModel }]
  const caps = harness ? agentCapabilities(harness) : null
  const agentEntry = profiles?.agents.find((a) => a.harness === harness)
  const inheritedLabel = subagentDefaults?.harness
    ? `${HARNESS[subagentDefaults.harness as Harness]?.label ?? subagentDefaults.harness}${shortModelLabel(subagentDefaults.model, subagentDefaults.effort) ? ` · ${shortModelLabel(subagentDefaults.model, subagentDefaults.effort)}` : ''}`
    : 'your main session default'

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        instructions: instructions.trim(),
        icon,
        color,
        scope,
        harness: harness || null,
        profile: profile || 'default',
        model: model.trim() || null,
        effort: effort.trim() || null,
        permissionMode: permissionMode || null,
        defaultProject: defaultProject || null,
      }
      if (editing) {
        return unwrap(api.api.subagents[':id'].$patch({ param: { id: String(editing.id) }, json: payload }))
      }
      return unwrap(api.api.subagents.$post({ json: payload }))
    },
    onSuccess: () => {
      toast.success(editing ? 'Subagent updated' : 'Subagent created')
      void qc.invalidateQueries({ queryKey: ['subagents'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : 'New custom subagent'}
      description="Define a specialist that Hamasa, your normal sessions, and you can invoke anytime."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="sa-name">Name</FieldLabel>
            <Input
              id="sa-name"
              required
              maxLength={80}
              placeholder="Web Search"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!slugTouched) setSlug(slugify(e.target.value))
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sa-slug">Slug</FieldLabel>
            <Input
              id="sa-slug"
              maxLength={64}
              placeholder="web-search"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="sa-desc">Short description</FieldLabel>
          <Input
            id="sa-desc"
            maxLength={240}
            placeholder="When should Hamasa or a session pick this subagent?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <FieldDescription>Shown to Hamasa and sessions so they know when to delegate to this subagent.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="sa-scope">Available to</FieldLabel>
          <NativeSelect id="sa-scope" value={scope} onChange={(e) => setScope(e.target.value as SubagentScope)}>
            <option value="both">Both Hamasa &amp; normal sessions</option>
            <option value="hamasa">Hamasa only</option>
            <option value="sessions">Normal sessions only</option>
          </NativeSelect>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>Icon</FieldLabel>
            <div className="grid grid-cols-7 gap-1">
              {ICON_LIST.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  title={item.label}
                  onClick={() => setIcon(item.value)}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg border transition-colors',
                    icon === item.value
                      ? COLOR_STYLES[color].badge
                      : 'border-transparent bg-surface text-muted-foreground hover:text-foreground',
                  )}
                >
                  <SubagentIconGlyph icon={item.value} className="size-4" />
                </button>
              ))}
            </div>
          </Field>
          <Field>
            <FieldLabel>Accent color</FieldLabel>
            <div className="flex flex-wrap gap-2 pt-1">
              {COLOR_LIST.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={COLOR_STYLES[c].label}
                  onClick={() => setColor(c)}
                  className={cn(
                    'size-7 rounded-full border-2 transition-transform',
                    COLOR_STYLES[c].dot,
                    color === c ? 'scale-110 border-foreground' : 'border-transparent opacity-75 hover:opacity-100',
                  )}
                />
              ))}
            </div>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="sa-instructions">Instructions</FieldLabel>
          <Textarea
            id="sa-instructions"
            required
            rows={6}
            placeholder="Describe this subagent's exact workflow, tools to prefer, and how it should format its answer..."
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>

        <div className="rounded-xl border bg-surface/50">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span>Model &amp; runtime override (default: {inheritedLabel})</span>
            {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-3 border-t p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="sa-harness">Agent engine</FieldLabel>
                  <NativeSelect
                    id="sa-harness"
                    value={harness}
                    onChange={(e) => {
                      const next = e.target.value as Harness | ''
                      setHarness(next)
                      setCustomModel(false)
                      setModel('')
                      setEffort('')
                      setPermissionMode('')
                    }}
                  >
                    <option value="">Use subagent default ({inheritedLabel})</option>
                    {HARNESSES.map((h) => (
                      <option key={h} value={h}>{HARNESS[h].label}</option>
                    ))}
                  </NativeSelect>
                </Field>
                {harness && agentEntry && agentEntry.profiles.length > 1 && (
                  <Field>
                    <FieldLabel htmlFor="sa-profile">Profile</FieldLabel>
                    <NativeSelect id="sa-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
                      {agentEntry.profiles.map((p) => (
                        <option key={p.name} value={p.name}>{p.name}</option>
                      ))}
                    </NativeSelect>
                  </Field>
                )}
              </div>

              {harness && (
                <>
                  <Field>
                    <FieldLabel htmlFor="sa-model">Model</FieldLabel>
                    <ModelField
                      id="sa-model"
                      harness={harness}
                      models={modelsList}
                      value={model}
                      custom={customModel}
                      onCustom={setCustomModel}
                      onChange={(v) => {
                        setModel(v)
                        if (v !== model) setEffort('')
                      }}
                      note="Pick a lightweight, fast model for file/web searching."
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {harness === 't3code' && (
                      <ThinkingLevelField
                        id="sa-effort"
                        levels={effortLevels(modelsList, model || null)}
                        value={effort || null}
                        onChange={(v) => setEffort(v ?? '')}
                      />
                    )}
                    {caps && caps.sessionModes.length > 1 && (
                      <Field>
                        <FieldLabel htmlFor="sa-perm">Permissions</FieldLabel>
                        <NativeSelect
                          id="sa-perm"
                          value={permissionMode}
                          onChange={(e) => setPermissionMode(e.target.value as PermissionMode | '')}
                        >
                          <option value="">Inherit default</option>
                          {caps.sessionModes.map((m) => (
                            <option key={m} value={m}>{modeLabel(m)}</option>
                          ))}
                        </NativeSelect>
                      </Field>
                    )}
                  </div>
                </>
              )}

              <Field>
                <FieldLabel htmlFor="sa-project">Default project (optional)</FieldLabel>
                <NativeSelect id="sa-project" value={defaultProject} onChange={(e) => setDefaultProject(e.target.value)}>
                  <option value="">Use caller&apos;s project or home folder</option>
                  {projects.filter((p) => !p.archived).map((p) => (
                    <option key={p.slug} value={p.slug}>{p.name} ({p.slug})</option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={save.isPending || !name.trim() || !instructions.trim()}>
            {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create subagent'}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  )
}

function RunSubagentDialog({
  subagent,
  onOpenChange,
  onStarted,
}: {
  subagent: CustomSubagent | null
  onOpenChange: (open: boolean) => void
  onStarted: (runId: number) => void
}) {
  const qc = useQueryClient()
  const projects = useQuery({ ...projectsQuery, enabled: !!subagent }).data?.projects ?? []
  const [task, setTask] = useState('')
  const [project, setProject] = useState('')

  useEffect(() => {
    if (subagent) {
      setTask('')
      setProject(subagent.defaultProject ?? '')
    }
  }, [subagent])

  const start = useMutation({
    mutationFn: () => unwrap(api.api.subagents[':id'].run.$post({
      param: { id: String(subagent!.id) },
      json: { task: task.trim(), ...(project ? { project } : {}) },
    })),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['subagents'] })
      onStarted(res.run.id)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <ResponsiveDialog
      open={!!subagent}
      onOpenChange={onOpenChange}
      title={subagent ? `Run ${subagent.name}` : 'Run subagent'}
      description={subagent?.description || 'Give this subagent a clear, self-contained task to run in the background.'}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!task.trim()) return
          start.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="run-task">Task</FieldLabel>
          <Textarea
            id="run-task"
            required
            rows={4}
            autoFocus
            placeholder="What should this subagent investigate, search, or do?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="run-project">Project context (optional)</FieldLabel>
          <NativeSelect id="run-project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">No specific project (home folder)</option>
            {projects.filter((p) => !p.archived).map((p) => (
              <option key={p.slug} value={p.slug}>{p.name} ({p.slug})</option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={start.isPending || !task.trim()}>
            {start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run now
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  )
}

function RunDetailSheet({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    ...subagentRunQuery(runId ?? 0),
    enabled: !!runId,
  })
  const stop = useStopSubagentRun()
  const [stepsExpanded, setStepsExpanded] = useState(false)

  const remove = useMutation({
    mutationFn: () => unwrap(api.api.subagents.runs[':runId'].$delete({ param: { runId: String(runId!) } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subagents'] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  const run: SubagentRun | undefined = q.data?.run
  const isActive = run?.status === 'running' || run?.status === 'waiting'
  const color = COLOR_STYLES[(run?.subagentColor as SubagentColor) ?? 'blue'] ?? COLOR_STYLES.blue
  const meta = run ? statusMeta(run.status) : null
  const modelText = shortModelLabel(run?.model, run?.effort)

  const headerBar = (
    <SheetHeader className="shrink-0 gap-0 border-b bg-background/95 px-3 pt-[calc(env(safe-area-inset-top)+0.625rem)] pb-2.5 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        {run && meta ? (
          <>
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-xl border', color.badge)}>
              <SubagentIconGlyph icon={run.subagentIcon} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="truncate">{run.subagentName}</span>
                <Badge variant="outline" className={cn('h-5 shrink-0 px-1.5 text-[10px]', meta.badge)}>
                  <meta.icon className={cn('size-2.5', meta.spin && 'animate-spin')} />
                  {meta.label}
                </Badge>
              </SheetTitle>
              <SheetDescription className="mt-0.5 flex items-center gap-1 truncate text-[11px]">
                <span className="shrink-0">{CALLER_LABELS[run.callerKind] ?? run.callerKind}</span>
                {modelText && (
                  <><span>·</span><span className="truncate font-mono text-[10px]">{modelText}</span></>
                )}
                <span>·</span>
                <span className="shrink-0 tabular-nums">{formatDuration(run.startedAt, run.finishedAt)}</span>
                {run.costUsd !== null && run.costUsd > 0 && (
                  <><span>·</span><span className="shrink-0 tabular-nums">${run.costUsd.toFixed(4)}</span></>
                )}
              </SheetDescription>
            </div>
          </>
        ) : (
          <SheetTitle className="flex-1 text-sm font-semibold">Subagent chat</SheetTitle>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          {run?.sessionId && (
            <Button variant="ghost" size="icon-sm" asChild title="Open full session" aria-label="Open full session">
              <Link to="/sessions/$id" params={{ id: run.sessionId }} onClick={onClose}>
                <ExternalLink className="size-4" />
              </Link>
            </Button>
          )}
          {run && isActive && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:text-destructive"
              title="Stop run"
              aria-label="Stop run"
              disabled={stop.isPending}
              onClick={() => stop.mutate(run.id)}
            >
              <Square className="size-3.5" />
            </Button>
          )}
          {run && !isActive && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              title="Remove from history"
              aria-label="Remove from history"
              disabled={remove.isPending}
              onClick={async () => {
                if (await confirmAction({
                  title: 'Remove this run from history?',
                  description: 'This removes the run entry from your Subagents history.',
                  action: 'Remove',
                  destructive: true,
                })) {
                  remove.mutate()
                }
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </SheetHeader>
  )

  return (
    <Sheet open={!!runId} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-dvh w-full flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-2xl data-[side=right]:sm:border-l"
      >
        {q.isLoading ? (
          <>
            {headerBar}
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
            </div>
          </>
        ) : q.error ? (
          <>
            {headerBar}
            <div className="p-4"><ErrorAlert error={q.error} /></div>
          </>
        ) : run?.sessionId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <SessionView
              key={run.sessionId}
              id={run.sessionId}
              embedded={{ header: headerBar, name: run.subagentName }}
            />
          </div>
        ) : run ? (
          <>
            {headerBar}
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <section className="rounded-xl border bg-surface/60 p-3">
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Task</div>
                <p className="text-sm whitespace-pre-wrap">{run.task}</p>
              </section>
              {run.steps.length > 0 && (
                <section className="rounded-xl border">
                  <button
                    type="button"
                    onClick={() => setStepsExpanded((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
                  >
                    <span className="flex items-center gap-1.5">
                      <Activity className="size-3.5" />
                      Activity ({run.steps.length})
                    </span>
                    {stepsExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  {stepsExpanded && (
                    <div className="max-h-56 overflow-y-auto border-t px-3 py-2">
                      <ol className="flex flex-col gap-1.5">
                        {run.steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <span className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                            <div className="min-w-0 flex-1">
                              <span className="font-medium text-foreground">{step.label}</span>
                              {step.detail && !step.label.includes(step.detail) && (
                                <span className="ml-1.5 text-muted-foreground">{step.detail}</span>
                              )}
                            </div>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                              {new Date(step.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </section>
              )}
              {run.error && (
                <section className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <div className="font-semibold">Error</div>
                  <p className="mt-0.5 text-xs whitespace-pre-wrap">{run.error}</p>
                </section>
              )}
              {run.result && (
                <section className="rounded-xl border bg-background p-3.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                    Output
                  </div>
                  <Prose text={run.result} />
                </section>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SubagentDefaultModelCard({ defaults }: { defaults: SubagentDefaults | undefined }) {
  const qc = useQueryClient()
  const profilesQ = useQuery(profilesQuery)
  const [editing, setEditing] = useState(false)
  const [harness, setHarness] = useState<Harness | ''>('')
  const [profile, setProfile] = useState('default')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [customModel, setCustomModel] = useState(false)

  useEffect(() => {
    setHarness((defaults?.harness as Harness | null) ?? '')
    setProfile(defaults?.profile || 'default')
    setModel(defaults?.model ?? '')
    setEffort(defaults?.effort ?? '')
    setCustomModel(false)
  }, [defaults?.harness, defaults?.profile, defaults?.model, defaults?.effort, editing])

  const agents = (profilesQ.data?.agents ?? []) as Array<{ harness: string; installed: boolean; error?: string; profiles: { name: string; providers: string[] }[] }>
  const claudeProfiles = (profilesQ.data?.profiles ?? []) as Array<{ name: string; loggedIn: boolean }>
  const mainDefaults = profilesQ.data?.defaults
  const t3Agent = agents.find((a) => a.harness === 't3code')
  const t3Connected = !!t3Agent?.installed && !t3Agent.error
  const ocAgent = agents.find((a) => a.harness === 'opencode')
  const ocInstalled = !!ocAgent?.installed
  const claudeLoggedIn = claudeProfiles.some((p) => p.loggedIn)

  const t3Models = useOfferedModels('default', 't3code', defaults?.harness === 't3code' ? defaults.model : null, t3Connected)
  const ocModels = useOfferedModels('default', 'opencode', defaults?.harness === 'opencode' ? defaults.model : null, ocInstalled && !t3Connected)

  const recommended = useMemo(
    () => pickFastSmartModel({ t3Connected, t3Models, claudeLoggedIn, opencodeInstalled: ocInstalled, opencodeModels: ocModels }),
    [t3Connected, t3Models, claudeLoggedIn, ocInstalled, ocModels],
  )

  const activeHarness: Harness = harness || 't3code'
  const offeredForForm = useOfferedModels(profile, activeHarness, model || null, editing && !!harness)
  const formModels: ModelInfo[] = offeredForForm?.length
    ? offeredForForm
    : activeHarness === 'claude'
      ? FALLBACK_MODELS
      : [{ value: '', displayName: 'Default', description: HARNESS[activeHarness].defaultModel }]
  const formAgent = agents.find((a) => a.harness === harness)

  const save = useMutation({
    mutationFn: (payload: { harness: Harness | null; profile?: string; model: string | null; effort: string | null }) =>
      unwrap(api.api.subagents.defaults.$put({ json: payload })),
    onSuccess: (res) => {
      const label = res.defaults.harness
        ? `${HARNESS[res.defaults.harness as Harness]?.label ?? res.defaults.harness}${shortModelLabel(res.defaults.model, res.defaults.effort) ? ` · ${shortModelLabel(res.defaults.model, res.defaults.effort)}` : ''}`
        : 'main session default'
      toast.success(`Subagents default set to ${label}`)
      setEditing(false)
      void qc.invalidateQueries({ queryKey: ['subagents'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const configured = !!defaults?.harness
  const configuredLabel = configured
    ? `${HARNESS[defaults.harness as Harness]?.label ?? defaults.harness}${shortModelLabel(defaults.model, defaults.effort) ? ` · ${shortModelLabel(defaults.model, defaults.effort)}` : ' · Default'}`
    : null
  const mainLabel = mainDefaults?.model
    ? `${HARNESS[(mainDefaults.harness as Harness) || 'claude']?.label ?? mainDefaults.harness} · ${shortModelLabel(mainDefaults.model, mainDefaults.effort)}`
    : (mainDefaults?.harness ? HARNESS[mainDefaults.harness as Harness]?.label : 'your main session default')
  const alreadyRecommended = !!recommended && defaults?.harness === recommended.harness && defaults?.model === recommended.model

  return (
    <Card className={cn(
      'flex flex-col gap-3 rounded-2xl p-4',
      configured ? 'border-border bg-card' : 'border-amber-500/30 bg-amber-500/[0.03]',
    )}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={cn(
            'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border',
            configured
              ? 'border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
              : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
          )}>
            <Zap className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">Default subagent model</span>
              {configured ? (
                <Badge variant="outline" className="h-5 border-cyan-500/30 bg-cyan-500/10 px-2 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
                  {configuredLabel}
                </Badge>
              ) : (
                <Badge variant="outline" className="h-5 border-amber-500/30 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                  Inheriting main model ({mainLabel})
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {configured
                ? 'All subagents without a custom override run on this model so heavy file and web searches stay fast and cheap.'
                : 'Subagents search lots of files — set a fast, smart model here so they don’t burn your frontier model’s usage.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
          {recommended && !alreadyRecommended && (
            <Button
              size="xs"
              variant={configured ? 'outline' : 'default'}
              disabled={save.isPending}
              onClick={() => save.mutate({ harness: recommended.harness, profile: 'default', model: recommended.model, effort: recommended.effort })}
            >
              {save.isPending ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
              Use {recommended.label}{recommended.effort ? ` (${recommended.effort})` : ''}
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => setEditing((v) => !v)}>
            <SlidersHorizontal className="size-3" />
            {editing ? 'Close' : configured ? 'Change' : 'Choose model'}
          </Button>
        </div>
      </div>

      {editing && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="sd-harness">Agent engine</FieldLabel>
              <NativeSelect
                id="sd-harness"
                value={harness}
                onChange={(e) => {
                  const next = e.target.value as Harness | ''
                  setHarness(next)
                  setProfile('default')
                  setCustomModel(false)
                  setModel('')
                  setEffort('')
                }}
              >
                <option value="">Inherit main session default ({mainLabel})</option>
                {HARNESSES.map((h) => (
                  <option key={h} value={h}>{HARNESS[h].label}</option>
                ))}
              </NativeSelect>
            </Field>
            {harness && formAgent && formAgent.profiles.length > 1 && (
              <Field>
                <FieldLabel htmlFor="sd-profile">Profile</FieldLabel>
                <NativeSelect id="sd-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
                  {formAgent.profiles.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>

          {harness && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sd-model">Model</FieldLabel>
                <ModelField
                  id="sd-model"
                  harness={harness}
                  models={formModels}
                  value={model}
                  custom={customModel}
                  onCustom={setCustomModel}
                  onChange={(v) => {
                    setModel(v)
                    if (v !== model) setEffort('')
                  }}
                  note="Used by all custom subagents (and Claude Code built-in subagents when set to a Claude model)."
                />
              </Field>
              {harness === 't3code' && (
                <ThinkingLevelField
                  id="sd-effort"
                  levels={effortLevels(formModels, model || null)}
                  value={effort || null}
                  onChange={(v) => setEffort(v ?? '')}
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {configured && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate({ harness: null, model: null, effort: null })}
              >
                Reset to session default
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              disabled={save.isPending}
              onClick={() => save.mutate({
                harness: harness || null,
                profile: profile || 'default',
                model: harness ? (model.trim() || null) : null,
                effort: harness ? (effort.trim() || null) : null,
              })}
            >
              {save.isPending && <Loader2 className="size-3 animate-spin" />}
              Save default
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
