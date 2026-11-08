import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'
import { bytes } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { removeSkill, runnable, setEnabled, skillQuery } from './data'
import { FileList, SkillMarkdown, SourceLine } from './parts'

export function MySkillPage() {
  const { name } = useParams({ strict: false }) as { name: string }
  return <SkillView name={name} />
}
export function ProjectSkillPage() {
  const { slug, name } = useParams({ strict: false }) as { slug: string; name: string }
  return <SkillView name={name} project={slug} />
}

/** One skill: what it says, every file, where it came from; on/off and remove. */
function SkillView({ name, project }: { name: string; project?: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(skillQuery(name, project))
  const s = q.data?.skill
  const back = project ? `/projects/${project}` : '/skills'
  const done = () => void qc.invalidateQueries({ queryKey: ['skills'] })

  const toggle = useMutation({
    mutationFn: (on: boolean) => setEnabled(name, on),
    onSuccess: (_r, on) => { done(); toast.success(on ? `${name} is on` : `${name} is off`, { description: on ? 'New sessions can use it again.' : 'Moved out of the folders your agents read.' }) },
    onError: (err) => toast.error((err as Error).message),
  })
  const remove = useMutation({
    mutationFn: () => removeSkill(name, project),
    onSuccess: () => {
      done()
      toast.success(`${name} is removed`, project ? { description: 'Committed on its own.' } : undefined)
      void navigate({ to: back })
    },
    onError: (err) => toast.error((err as Error).message),
  })
  const askRemove = async () => {
    const ok = await confirmAction({
      title: `Remove ${name}?`,
      description: project ? 'Its folder is deleted from the project in a commit of its own. Everyone in the project stops getting it.' : s?.linked ? 'Only the link in your skills folder goes; the folder it points to stays.' : 'Its folder is deleted. Your sessions stop using it.',
      action: 'Remove', destructive: true,
    })
    if (ok) remove.mutate()
  }

  const runs = s ? runnable(s.files) : []
  return (
    <>
      <PageHeader title={name} description={project ? 'Project skill' : 'My skill'} back={back}
        actions={s && <Button variant="ghost" size="sm" className="text-destructive" disabled={remove.isPending} onClick={() => void askRemove()}><Trash2 />Remove</Button>} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error} />
        {q.isPending && <Skeleton className="h-40 rounded-2xl" />}
        {s && (
          <>
            <header className="flex flex-col gap-3">
              <p className="max-w-prose text-[15px] text-pretty">{s.description ?? <span className="text-muted-foreground">No description: agents won't know when to use it.</span>}</p>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">From</dt><dd className="min-w-0"><SourceLine source={s.source} /></dd>
                <dt className="text-muted-foreground">Folder</dt><dd className="min-w-0 truncate font-mono text-[13px]" title={s.path}>{s.path}</dd>
                <dt className="text-muted-foreground">Files</dt>
                <dd>{s.files.length} · {bytes(s.files.reduce((n, f) => n + f.size, 0))}{runs.length ? <span className="text-attention-foreground"> · {runs.length} can run</span> : null}</dd>
              </dl>
            </header>
            {!project && (
              <label className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">On</span>
                  <span className="block text-xs text-pretty text-muted-foreground">Off moves it out of the folders Claude Code and OpenCode read, so no session sees it.</span>
                </span>
                <Switch checked={s.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
              </label>
            )}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-[-0.01em]">SKILL.md</h2>
              <div className="rounded-2xl bg-surface p-4 md:p-5"><SkillMarkdown markdown={s.markdown} /></div>
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold tracking-[-0.01em]">Files</h2>
              <FileList files={s.files} />
            </section>
          </>
        )}
      </PageBody>
    </>
  )
}
