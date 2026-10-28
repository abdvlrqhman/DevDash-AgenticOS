import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CircleHelp, Map, ShieldQuestion } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { Prose } from './Blocks'
import type { PendingRequest } from './data'

type Answer = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }

function useAnswer(sessionId: string, requestId: string, after?: () => Promise<unknown>) {
  return useMutation({
    mutationFn: async (result: Answer) => {
      await unwrap(api.api.claude.sessions[':id'].answer.$post({ param: { id: sessionId }, json: { requestId, result } }))
      await after?.()
    },
  })
}

/** Everything Claude is waiting on, in the order it asked. Read-only for viewers who may not send. */
export function Requests({ sessionId, requests, canAnswer, waitingOn, afterPlanApproved }: {
  sessionId: string; requests: PendingRequest[]; canAnswer: boolean; waitingOn?: string; afterPlanApproved: () => Promise<unknown>
}) {
  return (
    <div className="flex flex-col gap-3">
      {requests.map((r) =>
        r.toolName === 'AskUserQuestion' ? <QuestionCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} waitingOn={waitingOn} />
        : r.toolName === 'ExitPlanMode' ? <PlanCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} waitingOn={waitingOn} after={afterPlanApproved} />
        : <PermissionCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} waitingOn={waitingOn} />,
      )}
    </div>
  )
}

/** A one-line summary of what Claude is blocked on, for the session header and status. */
export function requestSummary(req: PendingRequest): string {
  if (req.toolName === 'AskUserQuestion') {
    const q = (req.input.questions as { question?: string }[] | undefined)?.[0]?.question
    return q || 'Claude has a question'
  }
  if (req.toolName === 'ExitPlanMode') return 'Plan ready to review'
  return `Allow ${req.toolName}?`
}

const waitingCard = 'gap-3 border-attention/50 bg-attention-soft py-4 shadow-none'

/** Read-only footer for viewers who can't answer: says who the request is waiting on. */
function WaitingOn({ who }: { who?: string }) {
  return (
    <CardFooter className="px-4">
      <p className="text-sm text-muted-foreground">Waiting on {who ?? 'someone who can send'} to answer.</p>
    </CardFooter>
  )
}

type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
const OTHER = '__other'

function QuestionCard({ sessionId, req, disabled, waitingOn }: { sessionId: string; req: PendingRequest; disabled: boolean; waitingOn?: string }) {
  const questions = (req.input.questions as Question[] | undefined) ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answer = useAnswer(sessionId, req.requestId)
  const value = (q: Question) => (picked[q.question]?.includes(OTHER) ? other[q.question]?.trim() : picked[q.question]?.join(', ')) ?? ''
  const ready = questions.every((q) => value(q))

  return (
    <Card className={waitingCard}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm"><StatusLight state="waiting" /><CircleHelp className="size-4" />Claude has a question</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-4">
        {questions.map((q, qi) => (
          <fieldset key={q.question} disabled={disabled} className="flex flex-col gap-2">
            <legend className="mb-2 flex flex-wrap items-center gap-2 text-[15px] font-medium md:text-sm">
              {q.header && <span className="rounded-full bg-attention/20 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-attention-foreground uppercase">{q.header}</span>}
              {q.question}
            </legend>
            {q.multiSelect ? (
              [...q.options, { label: OTHER }].map((o, oi) => {
                const id = `q${qi}-${oi}`
                const on = picked[q.question]?.includes(o.label) ?? false
                return (
                  <Label key={o.label} htmlFor={id} className={cn('flex items-start gap-3 rounded-lg border bg-background p-3 font-normal', on && 'border-foreground')}>
                    <Checkbox id={id} checked={on} className="mt-0.5" onCheckedChange={() => setPicked((p) => {
                      const cur = (p[q.question] ?? []).filter((x) => x !== OTHER || o.label === OTHER)
                      return { ...p, [q.question]: o.label === OTHER ? [OTHER] : cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label] }
                    })} />
                    <OptionText label={o.label} description={'description' in o ? o.description : undefined} />
                  </Label>
                )
              })
            ) : (
              <RadioGroup value={picked[q.question]?.[0] ?? ''} onValueChange={(v) => setPicked((p) => ({ ...p, [q.question]: [v] }))} className="gap-2">
                {[...q.options, { label: OTHER }].map((o, oi) => {
                  const id = `q${qi}-${oi}`
                  return (
                    <Label key={o.label} htmlFor={id} className={cn('flex items-start gap-3 rounded-lg border bg-background p-3 font-normal', picked[q.question]?.[0] === o.label && 'border-foreground')}>
                      <RadioGroupItem id={id} value={o.label} className="mt-0.5" />
                      <OptionText label={o.label} description={'description' in o ? o.description : undefined} />
                    </Label>
                  )
                })}
              </RadioGroup>
            )}
            {picked[q.question]?.includes(OTHER) && (
              <Input autoFocus placeholder="Type your answer" className="h-10 bg-background" value={other[q.question] ?? ''}
                onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />
            )}
          </fieldset>
        ))}
        <ErrorAlert error={answer.error} />
      </CardContent>
      {disabled ? <WaitingOn who={waitingOn} /> : (
        <CardFooter className="px-4">
          <Button className="h-11 w-full text-base md:h-10 md:text-sm" disabled={!ready || answer.isPending}
            onClick={() => answer.mutate({ behavior: 'allow', updatedInput: { ...req.input, answers: Object.fromEntries(questions.map((q) => [q.question, value(q)])) } })}>
            Send answer
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function OptionText({ label, description }: { label: string; description?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{label === OTHER ? 'Something else' : label}</span>
      {description && <span className="text-sm text-muted-foreground">{description}</span>}
    </span>
  )
}

function PlanCard({ sessionId, req, disabled, waitingOn, after }: { sessionId: string; req: PendingRequest; disabled: boolean; waitingOn?: string; after: () => Promise<unknown> }) {
  const [feedback, setFeedback] = useState('')
  const approve = useAnswer(sessionId, req.requestId, after)
  const keep = useAnswer(sessionId, req.requestId)
  return (
    <Card className={waitingCard}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm"><StatusLight state="waiting" /><Map className="size-4" />Plan ready for review</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="max-h-[50vh] overflow-auto rounded-lg border bg-background px-3.5 py-3"><Prose text={String(req.input.plan ?? '')} /></div>
        <ErrorAlert error={approve.error ?? keep.error} />
      </CardContent>
      {disabled ? <WaitingOn who={waitingOn} /> : (
        <CardFooter className="flex flex-col items-stretch gap-2 px-4">
          <Button className="h-11 text-base md:h-10 md:text-sm" disabled={approve.isPending} onClick={() => approve.mutate({ behavior: 'allow', updatedInput: req.input })}>Approve and build</Button>
          <div className="flex gap-2">
            <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What should change? (optional)" className="h-10 bg-background" />
            <Button variant="outline" className="h-10" disabled={keep.isPending}
              onClick={() => keep.mutate({ behavior: 'deny', message: feedback.trim() ? `Keep planning. Feedback: ${feedback.trim()}` : 'Keep planning.' })}>
              Keep planning
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  )
}

function describe(req: PendingRequest) {
  const i = req.input
  if (req.toolName === 'Bash') return String(i.command ?? '')
  if (typeof i.file_path === 'string') return i.file_path
  if (typeof i.url === 'string') return i.url
  return JSON.stringify(i, null, 2).slice(0, 600)
}

function PermissionCard({ sessionId, req, disabled, waitingOn }: { sessionId: string; req: PendingRequest; disabled: boolean; waitingOn?: string }) {
  const answer = useAnswer(sessionId, req.requestId)
  return (
    <Card className={waitingCard}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm"><StatusLight state="waiting" /><ShieldQuestion className="size-4" />Allow {req.toolName}?</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <pre className="max-h-60 overflow-auto rounded-md border bg-background px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">{describe(req)}</pre>
        <ErrorAlert error={answer.error} />
      </CardContent>
      {disabled ? <WaitingOn who={waitingOn} /> : (
        <CardFooter className="flex flex-wrap gap-2 px-4">
          <Button className="h-10 flex-1 sm:flex-none" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow', updatedInput: req.input })}>Allow</Button>
          {!!req.suggestions?.length && (
            <Button variant="outline" className="h-10 flex-1 sm:flex-none" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow', updatedInput: req.input, updatedPermissions: req.suggestions })}>Always allow</Button>
          )}
          <Button variant="destructive" className="h-10 flex-1 sm:flex-none" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'deny', message: 'The user denied this.' })}>Deny</Button>
        </CardFooter>
      )}
    </Card>
  )
}
