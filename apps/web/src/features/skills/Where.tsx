import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { projectsQuery } from '../work/data'

const same = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n')
export const placeName = (f: string) => f.split('/').pop() || f
/** "Only in shop", "Only in 3 places": what a folder list means, in a few words. */
export const onlyIn = (folders: string[]) => `Only in ${folders.length === 1 ? placeName(folders[0]!) : `${folders.length} places`}`

/**
 * Where a skill (or a plugin) is used: every session, or only sessions in some projects or folders (a project includes
 * its worktrees). Applied when a session starts, in Claude Code and OpenCode alike.
 */
export function Where({ folders, onSave, pending, all = 'Every session', note }: {
  folders: string[] | null; onSave: (folders: string[] | null) => void; pending: boolean; all?: string; note?: string
}) {
  const projects = useQuery(projectsQuery).data?.projects ?? []
  const [only, setOnly] = useState(!!folders)
  const [picked, setPicked] = useState<string[]>(folders ?? [])
  const [typed, setTyped] = useState('')
  const saved = (folders ?? []).join('\n')
  useEffect(() => { setOnly(!!folders); setPicked(folders ?? []) }, [saved]) // eslint-disable-line react-hooks/exhaustive-deps -- reset when the saved list changes
  const known = projects.map((p) => ({ path: p.path, label: p.name }))
  const rows = [...known, ...picked.filter((f) => !known.some((k) => k.path === f)).map((f) => ({ path: f, label: f }))]
  const set = (f: string, on: boolean) => setPicked((v) => (on ? [...new Set([...v, f])] : v.filter((x) => x !== f)))
  const add = () => { if (typed.trim()) { set(typed.trim(), true); setTyped('') } }
  const changed = only !== !!folders || (only && !same(picked, folders ?? []))
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface px-4 py-3">
      <div>
        <span className="block text-sm font-medium">Where</span>
        <span className="block text-xs text-pretty text-muted-foreground">{note ?? 'Claude Code and OpenCode sessions alike. New sessions follow it; running ones keep what they started with.'}</span>
      </div>
      <RadioGroup value={only ? 'only' : 'all'} onValueChange={(v) => setOnly(v === 'only')} className="gap-2">
        <label className="flex items-center gap-2.5 text-sm"><RadioGroupItem value="all" />{all}</label>
        <label className="flex items-center gap-2.5 text-sm"><RadioGroupItem value="only" />Only in these projects or folders</label>
      </RadioGroup>
      {only && (
        <div className="flex flex-col gap-2 ps-6.5">
          {rows.map((r) => (
            <label key={r.path} className="flex min-w-0 items-center gap-2.5 text-sm" title={r.path}>
              <Checkbox checked={picked.includes(r.path)} onCheckedChange={(v) => set(r.path, v === true)} />
              <span className="truncate">{r.label}</span>
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Another folder, like ~/projects/app" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
            <Button type="button" variant="outline" disabled={!typed.trim()} onClick={add}>Add</Button>
          </div>
        </div>
      )}
      {changed && (
        <div className="flex justify-end">
          <Button size="sm" disabled={pending || (only && !picked.length)} onClick={() => onSave(only ? picked : null)}>Save</Button>
        </div>
      )}
    </section>
  )
}
