import { useMemo } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { describeCron, jsonToQuery, nextCronRuns, parseCron, queryToJson } from './lib'
import { HTTP_STATUS, statusCategory } from './http-status'
import { Output, ToolError, ToolField, TwoPane, tryRun, useToolState } from './ui'

/* ------------------------------------------------------------------- cron --- */

const EXAMPLES: [string, string][] = [
  ['*/15 * * * *', 'Every 15 minutes'], ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 0 1 * *', 'Monthly'], ['30 3 * * 0', 'Sundays at 03:30'],
]

export function CronTool() {
  const [expr, setExpr] = useToolState('cron.expr', '*/15 * * * *')
  const desc = expr.trim() ? tryRun(() => describeCron(expr)) : null
  const runs = useMemo(() => (expr.trim() ? tryRun(() => nextCronRuns(parseCron(expr), new Date(), 6)) : null), [expr])
  return (
    <div className="flex flex-col gap-4">
      <ToolField label="Cron expression" hint={<span className="ml-auto">minute hour day month weekday</span>}>
        <Input value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} placeholder="*/15 * * * *" className="h-10 font-mono text-base" />
      </ToolField>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map(([ex, label]) => (
          <button key={ex} type="button" onClick={() => setExpr(ex)} className="rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted" title={label}>{ex}</button>
        ))}
      </div>
      {desc && !desc.ok && <ToolError message={desc.error} />}
      {desc?.ok && (
        <div className="rounded-xl border bg-muted/30 px-4 py-3">
          <div className="text-xs font-medium text-muted-foreground">In plain English</div>
          <div className="mt-0.5 text-base font-medium">{desc.value}</div>
        </div>
      )}
      {runs?.ok && runs.value.length > 0 && (
        <ToolField label="Next runs">
          <ul className="divide-y rounded-xl border">
            {runs.value.map((d, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>{d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="font-mono text-xs text-muted-foreground">{relative(d)}</span>
              </li>
            ))}
          </ul>
        </ToolField>
      )}
    </div>
  )
}

function relative(d: Date): string {
  const mins = Math.round((d.getTime() - Date.now()) / 60000)
  if (mins < 60) return `in ${mins} min`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `in ${hrs} h`
  return `in ${Math.round(hrs / 24)} d`
}

/* ----------------------------------------------------------- HTTP statuses -- */

const CAT_STYLE: Record<string, string> = {
  Informational: 'text-sky-600 dark:text-sky-400', Success: 'text-emerald-600 dark:text-emerald-400',
  Redirection: 'text-amber-600 dark:text-amber-400', 'Client error': 'text-orange-600 dark:text-orange-400',
  'Server error': 'text-destructive',
}

export function HttpStatusTool() {
  const [q, setQ] = useToolState('http.q', '')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return HTTP_STATUS
    return HTTP_STATUS.filter((s) => String(s.code).includes(term) || s.text.toLowerCase().includes(term) || s.summary.toLowerCase().includes(term))
  }, [q])
  return (
    <div className="flex flex-col gap-4">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or name, e.g. 404, teapot, timeout" className="h-10" />
      {filtered.length === 0 ? (
        <div className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">No matching status codes.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {filtered.map((s) => {
            const cat = statusCategory(s.code)
            return (
              <li key={s.code} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                <span className={cn('mt-0.5 shrink-0 font-mono text-base font-semibold tabular-nums', CAT_STYLE[cat])}>{s.code}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.text}</span>
                    <Badge variant="outline" className={cn('text-[10px]', CAT_STYLE[cat])}>{cat}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{s.summary}</p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------ JSON <-> query ------ */

export function JsonQueryTool() {
  const [dir, setDir] = useToolState<'j2q' | 'q2j'>('jq.dir', 'q2j')
  const [input, setInput] = useToolState('jq.input', '')
  const res = input.trim()
    ? tryRun(() => (dir === 'q2j' ? JSON.stringify(queryToJson(input), null, 2) : jsonToQuery(input)))
    : null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={dir} onValueChange={(v) => v && setDir(v as 'j2q' | 'q2j')}>
          <ToggleGroupItem value="q2j">Query → JSON</ToggleGroupItem>
          <ToggleGroupItem value="j2q">JSON → Query</ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={!res?.ok} onClick={() => { if (res?.ok) { setInput(res.value); setDir(dir === 'q2j' ? 'j2q' : 'q2j') } }}><ArrowRightLeft />Swap</Button>
      </div>
      <TwoPane>
        <ToolField label={dir === 'q2j' ? 'Query string' : 'JSON object'}>
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false}
            placeholder={dir === 'q2j' ? '?name=John&tags=a&tags=b' : '{ "name": "John", "page": 2 }'} className="min-h-[12rem] font-mono text-[13px]" />
        </ToolField>
        <div className="flex flex-col gap-3">
          {res && !res.ok && <ToolError message={res.error} />}
          <Output value={res?.ok ? res.value : ''} label={dir === 'q2j' ? 'JSON' : 'Query string'} />
        </div>
      </TwoPane>
    </div>
  )
}
