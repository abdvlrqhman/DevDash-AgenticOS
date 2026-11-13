import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { HARNESS, type Harness } from './harness'
import { groupModels, isDefaultModel, modelLabel, type ModelInfo } from './models'

/**
 * The model choices inside a dropdown: the agent's own default (naming the model it is), then each family; a family
 * with more than one version expands in place, and the one holding the current choice starts open. `null` means the
 * agent's default.
 */
export function ModelChoices({ models, harness, value, onChange }: { models: ModelInfo[]; harness: Harness; value: string | null; onChange: (v: string | null) => void }) {
  const { defName, families } = useMemo(() => groupModels(models), [models])
  const current = isDefaultModel(value) ? 'default' : value!
  const holder = families.find((f) => f.rows.some((r) => r.value === current))
  const [open, setOpen] = useState<string | null>(holder?.name ?? null)
  const custom = current !== 'default' && !holder

  return (
    <DropdownMenuRadioGroup value={current} onValueChange={(v) => onChange(v === 'default' ? null : v)}>
      <DropdownMenuRadioItem value="default" className="items-start">
        <span className="flex flex-col">
          <span>{HARNESS[harness].label}'s default{defName && <span className="text-muted-foreground"> · {defName}</span>}</span>
          <span className="text-xs text-muted-foreground">{HARNESS[harness].defaultModel}</span>
        </span>
      </DropdownMenuRadioItem>
      {families.map((f) => f.rows.length === 1 ? (
        <DropdownMenuRadioItem key={f.name} value={f.rows[0]!.value}>
          <span className="flex-1">{f.rows[0]!.displayName}</span>
          {/* Another agent's provider, which a lone model's name doesn't say (Claude's families are in their names). */}
          {f.rows[0]!.group && <span className="text-xs text-muted-foreground">{f.name}</span>}
        </DropdownMenuRadioItem>
      ) : (
        <Fragment key={f.name}>
          <DropdownMenuItem aria-expanded={open === f.name} onSelect={(e) => { e.preventDefault(); setOpen(open === f.name ? null : f.name) }}>
            <ChevronRight className={cn('text-muted-foreground transition-transform duration-150', open === f.name && 'rotate-90')} />
            <span className="flex-1">{f.name}</span>
            <span className="text-xs text-muted-foreground">
              {holder === f ? holder.rows.find((r) => r.value === current)!.displayName : `${f.rows.length} ${f.rows[0]!.group ? 'models' : 'versions'}`}
            </span>
          </DropdownMenuItem>
          {open === f.name && f.rows.map((r) => (
            <DropdownMenuRadioItem key={r.value} value={r.value} className="pl-12">
              <span className="flex-1">{r.displayName}</span>
              {r.newest && <span className="text-xs text-muted-foreground">always the newest</span>}
            </DropdownMenuRadioItem>
          ))}
        </Fragment>
      ))}
      {custom && <DropdownMenuRadioItem value={current} className="font-mono text-xs">{current}</DropdownMenuRadioItem>}
    </DropdownMenuRadioGroup>
  )
}

/**
 * A model field: the agent's models in a dropdown (every version, every provider), or another model's ID typed in. The
 * new-session dialog and the defaults for new sessions both use it. `value` '' is Default. `onChange` follows every
 * keystroke; `onCommit`, for forms that save as you go, gets the choice once it's made (a pick, or leaving the ID).
 */
export function ModelField({ id, harness, models, value, onChange, onCommit, custom, onCustom, note }: {
  id: string; harness: Harness; models: ModelInfo[]; value: string; onChange: (v: string) => void; onCommit?: (v: string) => void
  custom: boolean; onCustom: (custom: boolean) => void; note: string
}) {
  const picked = custom ? undefined : isDefaultModel(value) ? groupModels(models).def : models.find((m) => m.value === value)
  // A Claude alias ('opus') follows the family's newest model; a full ID or another agent's model stays put.
  const follows = !!picked?.value && !picked.group && !picked.value.startsWith('claude-') && !isDefaultModel(picked.value)
  const commit = () => onCommit?.(value.trim())
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={id} type="button" variant="outline" className="h-10 w-full justify-between font-normal">
            <span className="truncate">{custom ? 'Another model' : modelLabel(models, value, HARNESS[harness].label)}</span><ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-(--radix-dropdown-menu-trigger-width) max-w-none overflow-y-auto">
          <ModelChoices models={models} harness={harness} value={custom ? null : value || null} onChange={(v) => { onCustom(false); onChange(v ?? ''); onCommit?.(v ?? '') }} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { onCustom(true); onChange('') }}>Another model (enter its ID)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {custom && (
        <Input aria-label="Model ID" className="h-10 font-mono" placeholder={harness === 'claude' ? 'claude-opus-4-1' : 'anthropic/claude-sonnet-4-5'} value={value}
          onChange={(e) => onChange(e.target.value)} onBlur={onCommit && commit}
          onKeyDown={onCommit && ((e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } })}
          spellCheck={false} autoCapitalize="none" autoFocus />
      )}
      <FieldDescription>
        {custom ? HARNESS[harness].modelHint : isDefaultModel(value) ? HARNESS[harness].defaultModel : picked?.description ? `${picked.description}${follows ? '. Always its newest version.' : ''}` : note}
      </FieldDescription>
    </>
  )
}
