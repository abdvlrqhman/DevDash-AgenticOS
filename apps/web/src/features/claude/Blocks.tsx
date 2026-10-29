import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  BookOpen, Brain, CalendarClock, Check, ChevronRight, Circle, CircleAlert, Copy, FileText, Info, ListChecks, LoaderCircle, MessagesSquare, SquareSlash,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Prose } from './Prose'
import { ToolSteps, type StepBlock } from './ToolSteps'
import type { Block, EventTone } from './transcript'

export { Prose }

/** Tool calls and the thinking between them form one timeline; to-do lists and replies stand on their own. */
type Item = Block | { kind: 'steps'; key: string; steps: StepBlock[] }
function group(blocks: Block[]): Item[] {
  const out: Item[] = []
  for (const b of blocks) {
    const step = (b.kind === 'tool' && !(b.name === 'TodoWrite' && Array.isArray(b.input.todos))) || b.kind === 'thinking'
    const last = out.at(-1)
    if (step && last?.kind === 'steps') last.steps.push(b as StepBlock)
    else if (step) out.push({ kind: 'steps', key: b.key, steps: [b as StepBlock] })
    else out.push(b)
  }
  // A run of only thoughts isn't a timeline.
  return out.flatMap((i) => (i.kind === 'steps' && !i.steps.some((s) => s.kind === 'tool') ? i.steps : [i]))
}

/** What Claude said in each finished turn (its replies, not the tool steps), by the turn's result line: to copy it. */
function replies(blocks: Block[]) {
  const out = new Map<string, string>()
  let said: string[] = []
  for (const b of blocks) {
    if (b.kind === 'user') said = []
    else if (b.kind === 'text') said.push(b.text.trim())
    else if (b.kind === 'result') {
      if (said.length) out.set(b.key, said.join('\n\n'))
      said = []
    }
  }
  return out
}

/** Copies `text`; the icon turns into a tick for a moment. */
function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(text).then(() => {
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, () => toast.error("Couldn't copy"))
  return (
    <Button size="icon-xs" variant="ghost" aria-label={copied ? 'Copied' : label} title={label} className={cn('text-muted-foreground', className)} onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

/** `live`: the session is working, so tools without a result are still running (otherwise they were interrupted). */
export const Blocks = memo(function Blocks({ blocks, senders, nested, live = true }: { blocks: Block[]; senders?: Record<string, { name: string }>; nested?: boolean; live?: boolean }) {
  const children = (b: Block[]) => <Blocks blocks={b} senders={senders} nested live={live} />
  const said = useMemo(() => replies(blocks), [blocks])
  return (
    <div className={cn('flex flex-col', nested ? 'gap-2' : 'gap-4')}>
      {group(blocks).map((b) => {
        switch (b.kind) {
          case 'steps':
            return <ToolSteps key={b.key} steps={b.steps} live={live} renderChildren={children} />
          case 'user': {
            const who = b.uuid && senders?.[b.uuid]?.name
            const text = b.text.trim()
            return (
              <div key={b.key} className="group/msg flex max-w-[85%] min-w-0 flex-col items-end gap-1 self-end">
                {(who || b.at || text) && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {/* Shown on hover (or focus) with a mouse, always on touch screens. */}
                    {text && <CopyButton text={b.text} label="Copy message" className="opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />}
                    {(who || b.at) && (
                      <span>
                        {[who, b.at && <time key="t" dateTime={new Date(b.at).toISOString()} title={new Date(b.at).toLocaleString()}>{clock(b.at)}</time>].filter(Boolean).reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, ' · ', x] : [x]), [])}
                      </span>
                    )}
                  </div>
                )}
                {b.images.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {b.images.map((src, i) => <img key={i} src={src} alt="Attached image" className="max-h-40 rounded-lg border" />)}
                  </div>
                )}
                {b.files.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {b.files.map((name, i) => (
                      <span key={i} className="flex max-w-60 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs">
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {/* data-selectable: the app selects only what people copy (styles.css), and your own messages are that too. */}
                {/* overflow-wrap: anywhere, not break-word: a long link must narrow the bubble too, or it pushes it off the left. */}
                {text && <div data-selectable className="max-w-full rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] [overflow-wrap:anywhere] whitespace-pre-wrap text-primary-foreground md:text-sm">{b.text}</div>}
              </div>
            )
          }
          case 'text':
            return <Prose key={b.key} text={b.text} cwd={b.cwd} />
          case 'thinking':
            return <Thinking key={b.key} text={b.text} />
          case 'tool':
            return <Todos key={b.key} todos={b.input.todos as Todo[]} />
          case 'command':
            return (
              <div key={b.key} className="flex flex-col gap-1.5 text-sm">
                <span className="flex w-fit max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[12.5px]">
                  <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{b.name}{b.args ? <span className="text-muted-foreground"> {b.args}</span> : null}</span>
                </span>
                {b.output && <pre className="font-mono text-xs whitespace-pre-wrap text-muted-foreground">{b.output}</pre>}
              </div>
            )
          case 'result':
            return <ResultLine key={b.key} b={b} reply={said.get(b.key)} />

          case 'event':
            return <Event key={b.key} text={b.text} ok={b.ok} tone={b.tone} detail={b.detail} images={b.images} />
          case 'note':
            return <p key={b.key} className="border-y py-1.5 text-center text-xs text-muted-foreground">{b.text}</p>
        }
      })}
    </div>
  )
})

/** 11:15 today, "Mon 11:15" this week, "12 Oct 11:15" before. */
export function clock(ms: number) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const days = (new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000
  if (days < 1) return time
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}
const took = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/** Under each answer: when it finished, how long it took, the tokens it used and what that would cost on the API. */
function ResultLine({ b, reply }: { b: Extract<Block, { kind: 'result' }>; reply?: string }) {
  const t = b.tokens
  // Every model call reads the whole conversation (mostly from the cheap cache), so "in" grows with the context.
  const read = t ? t.input + t.cacheRead + t.cacheWrite : 0
  const detail = t ? [
    `Read ${read.toLocaleString()} tokens: ${t.cacheRead.toLocaleString()} from cache, ${t.input.toLocaleString()} new, ${t.cacheWrite.toLocaleString()} written to cache`,
    `Wrote ${t.output.toLocaleString()} tokens`,
    b.steps ? `${b.steps} model call${b.steps === 1 ? '' : 's'}${b.steps > 1 ? ', each reading the conversation again' : ''}` : '',
    b.model ? `Model: ${b.model}` : '',
    b.cost !== undefined ? `$${b.cost.toFixed(4)} at API prices (on a Claude plan it counts against the plan, not money)` : 'Cost unknown: this session began before DevDash saved costs',
  ].filter(Boolean).join('\n') : undefined
  const tone = b.stopped ? 'text-muted-foreground' : b.ok ? 'text-muted-foreground' : 'text-destructive'
  return (
    <p className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs tabular-nums', tone)} title={detail}>
      {b.ok || b.stopped ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      <span>{b.stopped ? 'Stopped' : b.ok ? 'Done' : 'Stopped with an error'}</span>
      {b.at && <><span aria-hidden>·</span><time dateTime={new Date(b.at).toISOString()}>{clock(b.at)}</time></>}
      <span aria-hidden>·</span><span>{took(b.seconds)}</span>
      {t && <><span aria-hidden>·</span><span>{kTokens(read)} in, {kTokens(t.output)} out</span></>}
      {b.cost !== undefined && <><span aria-hidden>·</span><span>${b.cost < 0.01 ? b.cost.toFixed(3) : b.cost.toFixed(2)}</span></>}
      {reply && <CopyButton text={reply} label="Copy reply" className="-my-1" />}
    </p>
  )
}

const TONE: Record<EventTone, LucideIcon> = { task: Check, skill: BookOpen, peer: MessagesSquare, schedule: CalendarClock, system: Info }

/** Something Claude Code put in the conversation itself: a quiet line, its raw text one tap away and any images shown. */
function Event({ text, ok, tone = 'task', detail, images }: { text: string; ok: boolean; tone?: EventTone; detail?: string; images?: string[] }) {
  const [open, setOpen] = useState(false)
  const Icon = ok ? TONE[tone] : CircleAlert
  const line = (
    <>
      <Icon className={cn('mt-px size-3.5 shrink-0', !ok ? 'text-destructive' : tone === 'task' ? 'text-live' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {detail && <ChevronRight className={cn('mt-px size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} />}
    </>
  )
  return (
    <div className="text-xs text-muted-foreground">
      {detail
        ? <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-muted/60 hover:text-foreground">{line}</button>
        : <p className="flex items-start gap-2">{line}</p>}
      {images && images.length > 0 && (
        <div className="mt-1 ml-5.5 flex flex-wrap gap-1.5">
          {images.map((src, i) => <img key={i} src={src} alt="Note image" className="max-h-40 rounded-lg border" />)}
        </div>
      )}
      {open && detail && <pre className="mt-1 ml-5.5 max-h-72 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 font-mono text-[11.5px] leading-5 break-words whitespace-pre-wrap">{detail}</pre>}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  return (
    <Collapsible className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-1.5 hover:text-foreground">
        <Brain className="size-4" />Thinking<ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 border-l-2 pl-3 whitespace-pre-wrap">{text}</CollapsibleContent>
    </Collapsible>
  )
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
function Todos({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks className="size-4 text-muted-foreground" /><span className="font-medium">To-dos</span>
        <span className="text-xs text-muted-foreground">{done} of {todos.length}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {todos.map((t, i) => (
          <li key={i} className={cn('flex items-start gap-2', t.status === 'completed' && 'text-muted-foreground line-through', t.status === 'in_progress' && 'font-medium')}>
            {t.status === 'completed' ? <Check className="mt-0.5 size-4 shrink-0 text-live" />
              : t.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-attention-foreground" />
              : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </li>
        ))}
      </ul>
    </div>
  )
}
