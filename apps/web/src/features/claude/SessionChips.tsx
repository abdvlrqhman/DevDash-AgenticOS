import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BadgeCheck, Copy, ExternalLink, Network, Smartphone, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, unwrap } from '@/lib/api'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import type { Session } from './data'

// Why fast mode isn't serving, from Claude Code's fast_mode_disabled_reason.
const FAST_REASON: Record<string, string> = {
  free: 'Fast mode needs a paid Claude plan.',
  extra_usage_disabled: 'Fast mode is billed as extra usage. Turn on extra usage in your Claude account settings to use it.',
  preference: 'Your organization turned fast mode off.',
  model_not_allowed: "Your organization doesn't allow the model fast mode uses.",
  not_first_party: 'Fast mode works only with a Claude account or an Anthropic API key.',
  disabled_by_env: 'Fast mode is turned off on this server.',
  network_error: "Couldn't check whether fast mode is available. Claude Code tries again by itself.",
  pending: 'Checking whether fast mode is available…',
}
export const FAST_HINT = 'Faster answers on models that have it (Opus). Billed as extra usage on your Claude plan.'
export const REMOTE_HINT = 'Continue this session from the Claude app or claude.ai/code, signed in as you.'

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))

const Chip = ({ children, tone, label }: { children: ReactNode; tone?: 'attention' | 'destructive' | 'live'; label: string }) => (
  <PopoverTrigger asChild>
    <button aria-label={label} className={cn(
      'flex h-6 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
      tone === 'attention' && 'text-attention-foreground dark:text-attention',
      tone === 'destructive' && 'text-destructive',
      tone === 'live' && 'text-foreground',
    )}>{children}</button>
  </PopoverTrigger>
)

const TASK_KIND: Record<string, string> = { local_bash: 'Shell', bash: 'Shell', monitor: 'Monitor', local_agent: 'Subagent', workflow: 'Workflow' }

/** Shells, subagents and monitors Claude left running: how many, what each is doing, and Stop. */
function BackgroundTasks({ id, tasks, canStop }: { id: string; tasks: Session['tasks']; canStop: boolean }) {
  const stop = useMutation({
    mutationFn: (taskId: string) => unwrap(api.api.claude.sessions[':id'].tasks[':taskId'].stop.$post({ param: { id, taskId } })),
    onSuccess: () => toast.success('Stopped. Claude gets a note that it was stopped.'),
    onError: (e) => toast.error(e.message),
  })
  return (
    <Popover>
      <Chip label={`${tasks.length} running in the background`} tone="live"><StatusLight state="live" />{tasks.length} running</Chip>
      <PopoverContent align="start" className="w-80 text-sm">
        <p className="font-medium">Running in the background</p>
        <p className="mt-1 text-xs text-muted-foreground">Claude started these and picks up their results when they finish, even after it answered.</p>
        <ul className="mt-3 flex flex-col divide-y">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2">{t.description || 'A background task'}</div>
                <div className="text-xs text-muted-foreground">{TASK_KIND[t.type] ?? t.type}</div>
              </div>
              {canStop && (
                <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={stop.isPending && stop.variables === t.id} onClick={() => stop.mutate(t.id)}>Stop</Button>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** A ring that fills as the context window does. */
function Ring({ percent }: { percent: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2.5" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, percent) / 100)} />
    </svg>
  )
}

/** Under the message box: how full the context is, and fast mode and Remote Control while they're on. */
export function SessionChips({ s, isOwner, canSend, working, onUpdate, onCompact }: {
  s: Session
  isOwner: boolean
  canSend: boolean
  working: boolean
  onUpdate: (v: { fastMode?: boolean; remoteControl?: boolean }) => void
  onCompact: () => void
}) {
  const ctx = s.context
  const fastServing = s.fast?.state === 'on'
  const fastNote = s.fast?.state === 'cooldown'
    ? 'Fast mode hit a rate limit and is cooling down. Claude answers at standard speed until it is back.'
    : s.fast && s.fast.state !== 'on' ? (s.fast.reason && FAST_REASON[s.fast.reason]) ?? 'Fast mode is not available right now.' : null
  return (
    <>
      {s.origin?.kind === 'proposal' && (
        <Popover>
          <Chip label={`From ${s.origin.role}'s approval`}><BadgeCheck className="size-3.5" /><span className="max-sm:hidden">From {s.origin.role}'s approval</span><span className="sm:hidden">Approval</span></Chip>
          <PopoverContent align="start" className="w-72 text-sm">
            <p className="font-medium">From an approval</p>
            <p className="mt-1 text-xs text-muted-foreground">This session started from the {s.origin.role} role's code proposal when it was approved. It runs as the approver, on its own branch.</p>
          </PopoverContent>
        </Popover>
      )}
      {s.tasks.length > 0 && <BackgroundTasks id={s.id} tasks={s.tasks} canStop={canSend} />}
      {ctx && (
        <Popover>
          <Chip label={`Context ${ctx.percent}% used`} tone={ctx.percent >= 90 ? 'destructive' : ctx.percent >= 75 ? 'attention' : undefined}>
            <Ring percent={ctx.percent} />{ctx.percent}%<span className="max-sm:hidden">&nbsp;context</span>
          </Chip>
          <PopoverContent align="start" className="w-72 text-sm">
            <div className="flex items-baseline justify-between"><span className="font-medium">Context used</span><span className="tabular-nums">{ctx.percent}%</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full bg-foreground', ctx.percent >= 90 ? 'bg-destructive' : ctx.percent >= 75 && 'bg-attention')} style={{ width: `${Math.min(100, ctx.percent)}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{k(ctx.tokens)} of {k(ctx.max)} tokens, as of Claude's last answer. When it fills up, Claude compacts the conversation by itself.</p>
            {canSend && (
              <Button size="sm" variant="outline" className="mt-3 w-full" disabled={working} onClick={onCompact}>
                Compact now
              </Button>
            )}
          </PopoverContent>
        </Popover>
      )}

      {s.fastMode && (
        <Popover>
          <Chip label={fastNote ? 'Fast mode, unavailable right now' : 'Fast mode'} tone={fastNote ? 'attention' : 'live'}><Zap className={cn('size-3.5', fastServing && 'fill-current')} />Fast</Chip>
          <PopoverContent align="start" className="w-72 text-sm">
            <p className="font-medium">Fast mode is on</p>
            <p className="mt-1 text-xs text-muted-foreground">{FAST_HINT}</p>
            {fastNote && <p className="mt-2 text-xs text-attention-foreground dark:text-attention">{fastNote}</p>}
            {canSend && <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => onUpdate({ fastMode: false })}>Turn off fast mode</Button>}
          </PopoverContent>
        </Popover>
      )}

      {s.reachTailnet && (
        <Popover>
          <Chip label="Routed through your tailnet" tone="live"><Network className="size-3.5" /><span className="max-sm:hidden">Tailnet</span></Chip>
          <PopoverContent align="start" className="w-80 text-sm">
            <p className="font-medium">Reaching your tailnet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This session's ssh, curl and frida reach your private devices by their 100.x addresses. Claude's own Anthropic traffic is not proxied.
            </p>
            {s.tailnetMcps?.length ? <p className="mt-2 break-all text-xs text-muted-foreground">MCP: <span className="font-mono">{s.tailnetMcps.map((m) => m.name).join(', ')}</span></p> : null}
          </PopoverContent>
        </Popover>
      )}

      {s.remoteControl && (
        <Popover>
          <Chip label="Remote Control" tone={s.remoteError ? 'attention' : 'live'}>
            {s.remoteError ? <Smartphone className="size-3.5" /> : <StatusLight state={s.remoteUrl ? 'live' : 'idle'} />}<span className="sm:hidden">Remote</span><span className="max-sm:hidden">Remote Control</span>
          </Chip>
          <PopoverContent align="start" className="w-80 text-sm">
            <p className="font-medium">Remote Control</p>
            <p className="mt-1 text-xs text-muted-foreground">{REMOTE_HINT} In the app, it's under Code.</p>
            {s.remoteError ? (
              <p className="mt-2 text-xs text-destructive">{s.remoteError}</p>
            ) : s.remoteUrl ? (
              <div className="mt-3 flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => openExternal(s.remoteUrl!)}><ExternalLink />Open in Claude</Button>
                <Button size="sm" variant="outline" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(s.remoteUrl!).then(() => toast.success('Link copied'))}><Copy /></Button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{s.mode === 'cli' ? 'On in the CLI. The link shows in the terminal.' : 'Connects when Claude next starts in this session.'}</p>
            )}
            {isOwner && (
              <div className="mt-2 flex gap-2">
                {s.remoteError && <Button size="sm" variant="outline" className="flex-1" onClick={() => onUpdate({ remoteControl: true })}>Try again</Button>}
                <Button size="sm" variant="ghost" className="flex-1" onClick={() => onUpdate({ remoteControl: false })}>Turn off</Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}
