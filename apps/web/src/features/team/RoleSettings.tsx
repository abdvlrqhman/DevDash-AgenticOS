import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DAY_NAMES, nextLabel, TRIGGER_LABELS, type RoleDetail, type Slot } from './data'

type Settings = {
  autonomy: 'advisor' | 'operator'; autoApprove: ('code' | 'goal')[]; schedule: Slot[]; triggers: ('work' | 'task_done' | 'task_created')[]
  paused: boolean; dailyLimit: number; monthlyBudget: number | null; lead: boolean; selfClose: 'default' | 'always_ask' | 'allow'
}
const pick = (r: RoleDetail['role']): Settings => ({
  autonomy: r.autonomy, autoApprove: r.autoApprove as Settings['autoApprove'], schedule: r.schedule, triggers: r.triggers as Settings['triggers'],
  paused: r.paused, dailyLimit: r.dailyLimit, monthlyBudget: r.monthlyBudget, lead: r.lead, selfClose: r.selfClose,
})
const ORDER = [1, 2, 3, 4, 5, 6, 0] // the week starts on Monday here

/** When and how a role works on its own. Saved as a whole, so a half-edited schedule never runs. */
export function RoleSettings({ r, project }: { r: RoleDetail['role']; project: RoleDetail['project'] }) {
  const qc = useQueryClient()
  const [s, setS] = useState<Settings>(() => pick(r))
  useEffect(() => setS(pick(r)), [r])
  const dirty = JSON.stringify(s) !== JSON.stringify(pick(r))
  const set = (patch: Partial<Settings>) => setS((x) => ({ ...x, ...patch }))
  const save = useMutation({
    mutationFn: (next: Settings) => unwrap(api.api.team.roles[':id'].settings.$put({ param: { id: String(r.id) }, json: next })),
    onSuccess: () => { toast.success('Saved.'); void qc.invalidateQueries({ queryKey: ['team'] }) },
    onError: (e) => toast.error(e.message),
  })
  const slot = (i: number, patch: Partial<Slot>) => set({ schedule: s.schedule.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Row title="Works on its own" hint={s.paused ? 'Paused: no scheduled or triggered shifts. Chat and Run a shift still work.' : r.nextShiftAt ? `Next shift ${nextLabel(r.nextShiftAt)}.` : project.paused ? 'The whole team is paused.' : 'Add a time below, or a trigger.'}>
        <Switch checked={!s.paused} onCheckedChange={(v) => { const next = { ...s, paused: !v }; setS(next); save.mutate(next) }} aria-label="Works on its own" />
      </Row>

      <Row title="Team lead" hint={s.lead ? 'Gets every thread nobody owns, and its shift report goes to everyone\'s phone as the digest.' : 'The lead gets ownerless threads and sends the digest. One per team.'}>
        <Switch checked={s.lead} onCheckedChange={(v) => set({ lead: v })} aria-label="Team lead" />
      </Row>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Schedule <span className="font-normal text-muted-foreground">({project.tz.replace('_', ' ')} time)</span></h3>
        {s.schedule.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="multiple" variant="outline" size="sm" value={x.days.map(String)} aria-label="Days"
              onValueChange={(v) => slot(i, { days: v.map(Number) })}>
              {ORDER.map((d) => <ToggleGroupItem key={d} value={String(d)} className="w-11">{DAY_NAMES[d]}</ToggleGroupItem>)}
            </ToggleGroup>
            <Input type="time" className="h-8 w-28" value={x.at} onChange={(e) => slot(i, { at: e.target.value })} aria-label="Time" />
            <Button size="icon" variant="ghost" className="size-8" aria-label="Remove this time" onClick={() => set({ schedule: s.schedule.filter((_, j) => j !== i) })}><X /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" disabled={s.schedule.length >= 10}
          onClick={() => set({ schedule: [...s.schedule, { days: [1, 2, 3, 4, 5], at: '09:00' }] })}><Plus />Add a time</Button>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Also wake it</h3>
        {Object.entries(TRIGGER_LABELS).map(([k, t]) => (
          <label key={k} className="flex items-start gap-3 text-sm">
            <Checkbox className="mt-0.5" checked={s.triggers.includes(k as Settings['triggers'][number])} onCheckedChange={() => set({ triggers: toggle(s.triggers, k as Settings['triggers'][number]) })} />
            <span><span className="font-medium">{t.label}</span><br /><span className="text-muted-foreground">{t.hint} At most once an hour.</span></span>
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">What it may do</h3>
        <div role="radiogroup" aria-label="Autonomy" className="grid gap-2 sm:grid-cols-2">
          {([['advisor', 'Advisor', 'Only suggests. Even tasks come to you to approve.'], ['operator', 'Operator', 'Adds tasks and notes itself; asks for everything else.']] as const).map(([v, label, hint]) => (
            <button key={v} role="radio" aria-checked={s.autonomy === v} onClick={() => set({ autonomy: v })}
              className={cn('flex flex-col gap-0.5 rounded-xl border p-3 text-left text-sm transition-colors hover:bg-accent/40', s.autonomy === v && 'border-foreground bg-accent/40')}>
              <span className="font-medium">{label}</span><span className="text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">Without asking, it may also:</p>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox className="mt-0.5" checked={s.autoApprove.includes('code')} onCheckedChange={() => set({ autoApprove: toggle(s.autoApprove, 'code') })} />
          <span><span className="font-medium">Start coding jobs</span><br /><span className="text-muted-foreground">A Claude session does the work on its own branch; nothing reaches the main branch without review.</span></span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox className="mt-0.5" checked={s.autoApprove.includes('goal')} onCheckedChange={() => set({ autoApprove: toggle(s.autoApprove, 'goal') })} />
          <span><span className="font-medium">Set goals</span><br /><span className="text-muted-foreground">New goals appear on the Team tab without asking.</span></span>
        </label>
        <p className="text-xs text-muted-foreground">Publishing, posting, spending money and contacting people outside the team always come to you.</p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Closing tasks and threads</h3>
        <div role="radiogroup" aria-label="How it closes" className="grid gap-2 sm:grid-cols-3">
          {([
            ['default', 'Follow autonomy', 'An operator closes confidently (8+); an advisor always asks.'],
            ['allow', 'May close', 'Closes confidently even as an advisor.'],
            ['always_ask', 'Always ask', 'Never closes on its own — people get a one-tap Close?'],
          ] as const).map(([v, label, hint]) => (
            <button key={v} role="radio" aria-checked={s.selfClose === v} onClick={() => set({ selfClose: v })}
              className={cn('flex flex-col gap-0.5 rounded-xl border p-3 text-left text-sm transition-colors hover:bg-accent/40', s.selfClose === v && 'border-foreground bg-accent/40')}>
              <span className="font-medium">{label}</span><span className="text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Whatever this says, closing anything that spends money, touches production, or is a person's decision always asks you (set per project on the Team tab).</p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Limits for shifts it starts itself</h3>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span>Shifts a day</span>
            <Input type="number" min={0} max={48} className="h-9 w-28" value={s.dailyLimit} onChange={(e) => set({ dailyLimit: Math.max(0, Math.min(48, Number(e.target.value) || 0)) })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Usage a month (API value, $)</span>
            <Input type="number" min={0} step={1} className="h-9 w-36" placeholder="No limit" value={s.monthlyBudget ?? ''}
              onChange={(e) => set({ monthlyBudget: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          This month: ${r.usage.costMonth.toFixed(2)} in API value · today {r.usage.autoShiftsToday} of {r.dailyLimit} shifts. On a Claude plan this counts against your plan's limits, not money.
        </p>
      </section>

      <div className="sticky bottom-0 flex gap-2 border-t bg-background py-3">
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(s)}>Save</Button>
        {dirty && <Button variant="ghost" onClick={() => setS(pick(r))}>Undo changes</Button>}
      </div>
    </div>
  )
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
      <div className="text-sm"><div className="font-medium">{title}</div><div className="text-muted-foreground">{hint}</div></div>
      {children}
    </div>
  )
}
