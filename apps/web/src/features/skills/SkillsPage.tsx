import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BookOpenCheck, ChevronRight, FileCode2, Plus } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { AddSkill } from './AddSkill'
import { skillsQuery, sourceLabel, type BuiltInSkill, type SkillSummary } from './data'

const rowClass = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'

/** More → Skills: the member's own skills (every session, every profile, the personal agent) and the built-in ones. */
export function SkillsPage() {
  const list = useQuery(skillsQuery)
  const [adding, setAdding] = useState(false)
  const mine = list.data?.skills ?? []
  const builtIn = list.data?.builtIn ?? []
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

        {builtIn.length > 0 && (
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.01em]">Built in</h2>
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">From DevDash and the plugins installed in your profiles. Managed there, shown here so you know they're in play.</p>
            </div>
            <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
              {builtIn.map((b) => <BuiltInRow key={`${b.kind}:${b.name}`} b={b} multi={profiles.length > 1} />)}
            </ul>
          </section>
        )}
      </PageBody>
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
          <span className={cn('truncate font-medium', off && 'text-muted-foreground')}>{s.name}</span>
          {off && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">Off</span>}
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
          {!b.enabled && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">Plugin off</span>}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{b.description ?? 'No description'}</span>
        <span className="line-clamp-1 text-xs text-muted-foreground/80">{b.from}{multi && b.profiles.length ? ` · ${b.profiles.join(', ')}` : ''}</span>
      </span>
    </li>
  )
}
