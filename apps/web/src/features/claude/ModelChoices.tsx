import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { groupModels, isDefaultModel, type ModelInfo } from './models'

/**
 * The model choices inside a dropdown: Default (naming the model it is), then each family; a family with more than
 * one version expands in place, and the one holding the current choice starts open. `null` means Default.
 */
export function ModelChoices({ models, value, onChange }: { models: ModelInfo[]; value: string | null; onChange: (v: string | null) => void }) {
  const { def, defName, families } = useMemo(() => groupModels(models), [models])
  const current = isDefaultModel(value) ? 'default' : value!
  const holder = families.find((f) => f.rows.some((r) => r.value === current))
  const [open, setOpen] = useState<string | null>(holder?.name ?? null)
  const custom = current !== 'default' && !holder

  return (
    <DropdownMenuRadioGroup value={current} onValueChange={(v) => onChange(v === 'default' ? null : v)}>
      <DropdownMenuRadioItem value="default" className="items-start">
        <span className="flex flex-col">
          <span>Default{defName && <span className="text-muted-foreground"> · {defName}</span>}</span>
          <span className="text-xs text-muted-foreground">{def?.description?.split('·')[1]?.trim() || 'What Claude Code recommends for your plan'}</span>
        </span>
      </DropdownMenuRadioItem>
      {families.map((f) => f.rows.length === 1 ? (
        <DropdownMenuRadioItem key={f.name} value={f.rows[0]!.value}>{f.rows[0]!.displayName}</DropdownMenuRadioItem>
      ) : (
        <Fragment key={f.name}>
          <DropdownMenuItem aria-expanded={open === f.name} onSelect={(e) => { e.preventDefault(); setOpen(open === f.name ? null : f.name) }}>
            <ChevronRight className={cn('text-muted-foreground transition-transform duration-150', open === f.name && 'rotate-90')} />
            <span className="flex-1">{f.name}</span>
            <span className="text-xs text-muted-foreground">
              {holder === f ? holder.rows.find((r) => r.value === current)!.displayName : `${f.rows.length} versions`}
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
