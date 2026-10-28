import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { DEFAULT_SCHEDULE, slotLabel, TEMPLATES, type Model } from './data'

type Draft = { name: string; summary: string; instructions: string; model: Model | null }
const EMPTY: Draft = { name: '', summary: '', instructions: '', model: null }

/** New role, or editing one: a name and a line, then Generate writes the instructions, which stay editable. */
export function RoleDialog({ open, onOpenChange, slug, role, onSaved }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  slug: string
  role?: { id: number; name: string; summary: string; instructions: string; model: string | null }
  onSaved?: (id: number) => void
}) {
  const qc = useQueryClient()
  const [d, setD] = useState<Draft>(EMPTY)
  useEffect(() => {
    if (open) setD(role ? { name: role.name, summary: role.summary, instructions: role.instructions, model: (role.model as Model | null) ?? null } : EMPTY)
  }, [open, role])
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  // A new role starts with its template's rhythm (or weekdays at 9); change it on the role's Schedule tab.
  const schedule = TEMPLATES.find((t) => t.name === d.name.trim())?.schedule ?? DEFAULT_SCHEDULE

  const generate = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].generate.$post({ param: { slug }, json: { name: d.name, summary: d.summary } })),
    onSuccess: (r) => set({ instructions: r.instructions }),
  })
  const save = useMutation({
    mutationFn: () => role
      ? unwrap(api.api.team.roles[':id'].$put({ param: { id: String(role.id) }, json: d }))
      : unwrap(api.api.team.projects[':slug'].roles.$post({ param: { slug }, json: { ...d, schedule } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['team'] })
      onOpenChange(false)
      onSaved?.(r.role.id)
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={role ? `Edit ${role.name}` : 'New role'}
      description={role ? 'Its chat uses the new instructions the next time it starts.' : 'Give it a name and say in one line what it should do. Generate writes the rest; change anything.'}>
      <form className="pb-2" onSubmit={(e) => { e.preventDefault(); if (d.name.trim()) save.mutate() }}>
        <FieldGroup>
          {!role && (
            <div className="flex flex-wrap gap-1.5" aria-label="Start from">
              {TEMPLATES.map((t) => (
                <button key={t.name} type="button" onClick={() => set({ name: t.name, summary: t.summary })}
                  className={cn('rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent', d.name === t.name && 'border-foreground bg-accent')}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="role-name">Name</FieldLabel>
            <Input id="role-name" className="h-10" value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Marketing – Social" autoFocus={!role} />
          </Field>
          <Field>
            <FieldLabel htmlFor="role-summary">What it should do, in one line</FieldLabel>
            <Input id="role-summary" className="h-10" value={d.summary} maxLength={300} onChange={(e) => set({ summary: e.target.value })}
              placeholder="Watches our socials and competitors, and says what to post and when." />
          </Field>
          <Field>
            <div className="flex items-end justify-between gap-2">
              <FieldLabel htmlFor="role-instructions">Instructions</FieldLabel>
              <Button type="button" size="sm" variant="outline" disabled={!d.name.trim() || generate.isPending} onClick={() => generate.mutate()}>
                {generate.isPending ? <Spinner /> : <Sparkles />}{d.instructions.trim() ? 'Generate again' : 'Generate'}
              </Button>
            </div>
            <Textarea id="role-instructions" rows={12} value={d.instructions} onChange={(e) => set({ instructions: e.target.value })}
              placeholder="Mission, what it watches, what it delivers, how it's measured, what it may do on its own and what it must ask first."
              className="max-h-[50vh] font-mono text-xs leading-5" />
            <FieldDescription>{generate.isPending ? 'Writing instructions for this project…' : 'Markdown. The role reads these every time it works.'}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="role-model">Model</FieldLabel>
            <NativeSelect id="role-model" value={d.model ?? ''} onChange={(e) => set({ model: (e.target.value || null) as Model | null })}>
              <option value="">Default</option>
              <option value="opus">Opus: best judgment, uses the most</option>
              <option value="sonnet">Sonnet: good balance</option>
              <option value="haiku">Haiku: quick checks, uses the least</option>
            </NativeSelect>
          </Field>
          {!role && (
            <p className="text-sm text-muted-foreground">
              It will work on its own <span className="text-foreground">{schedule.map(slotLabel).join(', ')}</span>. Change that, or pause it, on its Schedule tab.
            </p>
          )}
          <ErrorAlert error={generate.error ?? save.error} />
          <Button type="submit" className="h-10" disabled={!d.name.trim() || save.isPending}>{role ? 'Save' : 'Create role'}</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
