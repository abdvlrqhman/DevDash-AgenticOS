import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudUpload, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { ErrorAlert } from '../auth/LoginPage'
import { AddSkill } from './AddSkill'
import { projectSkillsQuery, pushProject } from './data'
import { SkillRow } from './SkillsPage'

/** Project → Skills: its .claude/skills, for every session in it. Each change is a commit of its own in the checkout. */
export function ProjectSkills({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const q = useQuery(projectSkillsQuery(slug))
  const [adding, setAdding] = useState(false)
  const skills = q.data?.skills ?? []
  const push = q.data?.push
  const send = useMutation({
    mutationFn: () => pushProject(slug),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['skills', 'project', slug] }); toast.success('Pushed to GitHub', { description: 'New worktree sessions get the skills now.' }) },
  })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Skills{skills.length ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{skills.length}</span> : null}</h2>
          <p className="mt-0.5 text-sm text-pretty text-muted-foreground">In <code className="font-mono text-foreground">.claude/skills</code>: every Claude Code and OpenCode session in this project gets them, for the whole team.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus />Add</Button>
      </div>
      <ErrorAlert error={q.error ?? send.error} />
      {q.isPending && <Skeleton className="h-14 rounded-2xl" />}
      {q.isSuccess && !skills.length && (
        <p className="rounded-2xl bg-surface px-4 py-5 text-sm text-pretty text-muted-foreground">
          No project skills yet. Add one for something everyone here repeats: how to deploy, the release checklist, the house style. It's committed on its own, as you.
        </p>
      )}
      {skills.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
          {skills.map((s) => <li key={s.name}><SkillRow s={s} to="/projects/$slug/skills/$name" params={{ slug, name: s.name }} /></li>)}
        </ul>
      )}
      {push && push.ahead > 0 && push.upstream && (
        <div className="flex flex-col gap-3 rounded-2xl bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm text-pretty">
            <span className="font-medium">{push.branch} has {push.ahead} {push.ahead === 1 ? 'commit' : 'commits'} not on GitHub.</span>{' '}
            <span className="text-muted-foreground">Sessions in new worktrees start from GitHub's copy, so they get new skills once it's pushed.</span>
          </p>
          <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate()} className="self-start sm:self-auto">
            {send.isPending ? <Spinner /> : <CloudUpload />}Push {push.branch}
          </Button>
        </div>
      )}
      <AddSkill open={adding} onOpenChange={setAdding} project={slug} />
    </div>
  )
}
