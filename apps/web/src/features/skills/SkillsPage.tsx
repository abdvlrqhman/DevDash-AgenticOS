import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BookOpenCheck, ChevronDown, ChevronRight, FileCode2, MapPin, Plus, Puzzle } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { AddSkill } from './AddSkill'
import { setPluginFolders, skillsQuery, sourceLabel, type BuiltInSkill, type SkillSummary } from './data'
import { onlyIn, placeName, Where } from './Where'

const rowClass = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'

/** More → Skills: the member's own skills (every session, every profile, the personal agent) and the built-in ones. */
export function SkillsPage() {
  const list = useQuery(skillsQuery)
  const [adding, setAdding] = useState(false)
  const mine = list.data?.skills ?? []
  const builtIn = list.data?.builtIn ?? []
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const provider = useQuery({ queryKey: ['provider-skill', selected], enabled: !!selected,
    queryFn: () => unwrap(api.api.skills.provider[':id'].$get({ param: { id: selected } })) })
  const providerRows = list.data?.discovered?.filter((s) => [s.name, ...s.sources].join(' ').toLowerCase().includes(search.toLowerCase().trim())) ?? []
  const profiles = list.data?.profiles ?? []
  return (
    <>
      <PageHeader title="Skills" description="What your agents know how to do" back="/more" backOnSmall
        actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />Add</Button>} />
      <PageBody className="gap-10 py-6 md:py-8">
        <ErrorAlert error={list.error} />
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.01em]">My skills{mine.length ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{mine.length}</span> : null}</h2>
            <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
              Used in all your Claude Code and OpenCode sessions{profiles.length > 1 ? `, on all ${profiles.length} of your Claude profiles,` : ''} and by your personal agent.
            </p>
          </div>
          {list.isPending && <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">{[0, 1].map((i) => <Skeleton key={i} className="h-13 rounded-xl bg-surface-2" />)}</div>}
          {list.isSuccess && !mine.length && (
            <div className="flex flex-col items-start gap-4 rounded-2xl bg-surface p-6">
              <div className="flex max-w-prose flex-col gap-1.5">
                <h3 className="font-semibold">Teach your agents something once</h3>
                <p className="text-sm text-pretty text-muted-foreground">
                  A skill is a folder with instructions (and sometimes scripts) your agent reads when a task calls for it. Write one, upload a .zip, or paste a GitHub link.
                </p>
              </div>
              <Button onClick={() => setAdding(true)}><Plus />Add a skill</Button>
            </div>
          )}
          {mine.length > 0 && (
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {mine.map((s) => <li key={s.name}><SkillRow s={s} to="/skills/$name" params={{ name: s.name }} /></li>)}
            </ul>
          )}
          {list.data?.shadowed?.length ? (
            <p className="text-sm text-muted-foreground">
              {list.data.shadowed.map((x) => `${x.name} (profile ${x.profile})`).join(', ')}: that profile has its own skill with this name, which it uses instead.
            </p>
          ) : null}
        </section>

        <Link to="/mcps" className="text-sm underline">Manage MCP servers</Link>
        {!!list.data?.discovered?.length && <section className="grid gap-2">
          <h2 className="font-semibold">Provider skills <span className="text-muted-foreground">{list.data.discovered.length}</span></h2>
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a provider skill" aria-label="Find a provider skill" />
          {providerRows.length === 0 && <p className="text-sm text-muted-foreground">No matching skills.</p>}
          <ul className="rounded-2xl bg-surface p-2">{providerRows.map((s) => <li key={s.id}>
            <button type="button" onClick={() => setSelected(s.id)} className={rowClass + ' w-full text-left'}>
              <span className="min-w-0 flex-1"><span className="block font-medium">{s.name}</span><span className="block text-xs text-muted-foreground">{s.sources.join(' · ')}</span></span><ChevronRight className="size-4"/>
            </button></li>)}</ul>
        </section>}
        {builtIn.length > 0 && (
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.01em]">Built in</h2>
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">From DevDash and the Claude Code plugins installed in your profiles. Plugins load in Claude Code only; to use one's skills in OpenCode too, add it with its <code className="font-mono text-foreground">/plugin install</code> command.</p>
            </div>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {builtIn.filter((b) => !b.plugin).map((b) => <BuiltInRow key={`${b.kind}:${b.name}`} b={b} multi={profiles.length > 1} />)}
              {plugins(builtIn).map(([id, rows]) => <PluginGroup key={id} id={id} rows={rows} multi={profiles.length > 1} />)}
            </ul>
          </section>
        )}
      </PageBody>
      <ResponsiveDialog open={!!selected} onOpenChange={(v) => { if (!v) setSelected('') }} title={list.data?.discovered?.find((s) => s.id === selected)?.name ?? 'Provider skill'}>
        <ErrorAlert error={provider.error} /><pre className="whitespace-pre-wrap break-words text-sm">{provider.data?.markdown ?? (provider.isLoading ? 'Loading…' : '')}</pre>
      </ResponsiveDialog>
      <AddSkill open={adding} onOpenChange={setAdding} />
    </>
  )
}

export function SkillRow({ s, to, params }: { s: SkillSummary; to: string; params: Record<string, string> }) {
  const off = s.enabled === false
  return (
    <Link to={to} params={params} className={rowClass}>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><BookOpenCheck className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('max-w-[60%] shrink-0 truncate font-medium', off && 'text-muted-foreground')}>{s.name}</span>
          {off && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">Off</span>}
          {!off && s.folders && <span className="min-w-0 truncate rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground" title={s.folders.join('\n')}>{onlyIn(s.folders)}</span>}
          {s.runs && <FileCode2 className="size-3.5 shrink-0 text-attention" aria-label="Has scripts" />}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">{s.description ?? 'No description'}</span>
        <span className="line-clamp-1 text-xs text-muted-foreground/80">{sourceLabel(s.source)}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function BuiltInRow({ b, multi }: { b: BuiltInSkill; multi: boolean }) {
  return (
    <li className="flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm">
      <span className="flex size-5 shrink-0 items-center justify-center pt-0.5 text-muted-foreground"><BookOpenCheck className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('truncate font-mono text-[13px] font-medium', !b.enabled && 'text-muted-foreground')}>{b.name}</span>
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{b.description ?? 'No description'}</span>
        <span className="line-clamp-1 text-xs text-muted-foreground/80">{b.from}{multi && b.profiles.length ? ` · ${b.profiles.join(', ')}` : ''}</span>
      </span>
    </li>
  )
}

/** Plugins' skills, by plugin, in the order they came. */
const plugins = (rows: BuiltInSkill[]) => [...rows.reduce((m, b) => (b.plugin ? m.set(b.plugin, [...(m.get(b.plugin) ?? []), b]) : m), new Map<string, BuiltInSkill[]>())]

/** One plugin: folded to a line (some have hundreds of skills), with where it's used. */
function PluginGroup({ id, rows, multi }: { id: string; rows: BuiltInSkill[]; multi: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const first = rows[0]!
  const name = id.split('@')[0]
  const folders = first.folders ?? null
  const save = useMutation({
    mutationFn: (f: string[] | null) => setPluginFolders(id, f),
    onSuccess: (_r, f) => { void qc.invalidateQueries({ queryKey: ['skills'] }); setEditing(false); toast.success(f ? `${name}: ${onlyIn(f).toLowerCase()}` : `${name} is back to your Claude Code setting`) },
    onError: (err) => toast.error((err as Error).message),
  })
  const status = folders ? onlyIn(folders)
    : first.onlyIn ? `Only in ${placeName(first.onlyIn)}`
    : first.enabled ? null : 'Off'
  const many = rows.length > 1
  const head = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><Puzzle className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('max-w-[60%] shrink-0 truncate font-medium', status === 'Off' && 'text-muted-foreground')}>{name}</span>
          {status && <span className="min-w-0 truncate rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground" title={folders ? folders.join('\n') : first.onlyIn ? `Claude Code keeps it to ${first.onlyIn}` : undefined}>{status}</span>}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">
          {many ? `${rows.length} skills` : first.description ?? 'No description'}{multi && first.profiles.length ? ` · ${first.profiles.join(', ')}` : ''}
        </span>
      </span>
    </>
  )
  const where = <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Where ${name} is used`}><MapPin /><span className="max-sm:hidden">Where</span></Button>
  return (
    <li>
      {many ? (
        <Collapsible>
          <div className="flex items-center gap-1 rounded-xl pe-1.5 hover:bg-surface-2">
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-start text-sm">
              {head}
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            {where}
          </div>
          <CollapsibleContent>
            {/* Its skills as a plain list, under the plugin: names without the plugin: prefix, one line each. */}
            <ul className="ms-11 me-3 mb-2 flex flex-col border-s ps-3">
              {rows.map((b) => (
                <li key={b.name} className="min-w-0 py-1.5">
                  <span className="block truncate font-mono text-[13px]">{b.name.slice(b.name.indexOf(':') + 1)}</span>
                  <span className="line-clamp-1 text-xs text-muted-foreground" title={b.description ?? undefined}>{b.description ?? 'No description'}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="flex items-center gap-1 rounded-xl pe-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-sm">{head}</div>
          {where}
        </div>
      )}
      <ResponsiveDialog open={editing} onOpenChange={setEditing} title={`Where ${name} is used`} description="The whole plugin, in Claude Code sessions. Plugins don't load in OpenCode.">
        <Where folders={folders} pending={save.isPending} onSave={(f) => save.mutate(f)} all="Wherever Claude Code has it on" note={first.onlyIn ? `Claude Code itself keeps it to ${first.onlyIn}. Picking folders here turns it on in those instead.` : 'A project includes its worktrees. New sessions follow it; running ones keep what they started with.'} />
      </ResponsiveDialog>
    </li>
  )
}
