import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { AlertTriangle, Check, ChevronDown } from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import { bytes, cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { discardReview, installReviewed, nameProblem, reviewQuery, runnable, type Review, type ReviewSkill } from './data'
import { FileList, RunWarning, SkillMarkdown, SourceLine } from './parts'

/** What an existing skill with the same name means, depending on where this one goes. */
function collisionNotes(collisions: string[], project?: string) {
  const notes: { text: string; replaces: boolean }[] = []
  for (const c of collisions) {
    if (c === 'devdash') notes.push({ text: "DevDash's own skill has this name. Pick another so agents don't mix them up.", replaces: false })
    else if (project && c === 'project') notes.push({ text: 'This project already has a skill with this name. Installing replaces it.', replaces: true })
    else if (project && c === 'personal') notes.push({ text: 'You have a skill of your own with this name; in your sessions yours is used instead.', replaces: false })
    else if (!project && c === 'personal') notes.push({ text: 'You already have a skill with this name. Installing replaces it.', replaces: true })
    else if (!project && c === 'personal-off') notes.push({ text: 'You have a turned-off skill with this name. Installing replaces it.', replaces: true })
  }
  return notes
}

/** Uploads and GitHub links land here: every file, SKILL.md rendered, scripts marked. Installs only on confirm. */
export function ReviewPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { project } = useSearch({ strict: false }) as { project?: string }
  const navigate = useNavigate()
  const q = useQuery(reviewQuery(id, project))
  const r = q.data?.review
  const back = project ? `/projects/${project}` : '/skills'
  const discard = async () => {
    await discardReview(id)
    void navigate({ to: back })
  }
  const many = (r?.skills.length ?? 0) > 1
  return (
    <>
      <PageHeader title={many ? `Review ${r!.skills.length} skills` : 'Review skill'} description={project ? `For project ${project}` : 'For My skills'} back={back}
        actions={r && <Button variant="ghost" size="sm" onClick={() => void discard()}>Discard</Button>} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error} />
        {q.isPending && <Skeleton className="h-60 rounded-2xl" />}
        {r && (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">From</dt><dd className="min-w-0"><SourceLine source={r.source} /></dd>
              {r.source.kind === 'github' && <><dt className="text-muted-foreground">Commit</dt><dd className="font-mono text-[13px] break-all">{r.source.sha}</dd></>}
            </dl>
            {many && <p className="-mt-4 text-sm text-pretty text-muted-foreground">Open each one you want, read it, and install it on its own.</p>}
            {many
              ? <div className="flex flex-col gap-2">{r.skills.map((s) => <Collapsed key={s.path} review={r} s={s} project={project} />)}</div>
              : r.skills[0] && <SkillReview review={r} s={r.skills[0]} project={project} single onDone={() => void discardReview(id)} />}
          </>
        )}
      </PageBody>
    </>
  )
}

function Collapsed({ review, s, project }: { review: Review; s: ReviewSkill; project?: string }) {
  const [open, setOpen] = useState(false)
  const runs = runnable(s.files).length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-2xl bg-surface">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition-colors hover:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2"><span className="truncate font-medium">{s.suggested}</span>
            {s.problems.length > 0 && <span className="shrink-0 text-xs text-destructive">Can't install</span>}</span>
          <span className="line-clamp-1 text-xs text-muted-foreground">{s.description ?? 'No description'}</span>
          <span className="text-xs text-muted-foreground/80">{s.files.length} files · {bytes(s.size)}{runs ? <span className="text-attention-foreground"> · {runs} can run</span> : null}</span>
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pt-2 pb-4">
        <SkillReview review={review} s={s} project={project} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SkillReview({ review, s, project, single, onDone }: { review: Review; s: ReviewSkill; project?: string; single?: boolean; onDone?: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(s.suggested)
  const [installed, setInstalled] = useState(false)
  const runs = runnable(s.files)
  const bad = nameProblem(name) ?? (name ? null : 'Give it a name.')
  const notes = name === s.suggested ? collisionNotes(s.collisions, project) : []
  const replacing = notes.some((n) => n.replaces)

  const install = useMutation({
    mutationFn: async () => {
      const ok = await confirmAction({
        title: `Install ${name}?`,
        description: [
          runs.length ? `${runs.length === 1 ? 'One file' : `${runs.length} files`} in it can run as you, with your logins, when an agent uses it.` : 'It has no scripts, but its instructions steer your agents.',
          project ? 'It is committed to the project, so everyone working in it gets this skill.' : 'All your sessions and your personal agent get it.',
          replacing ? 'The skill with the same name is replaced.' : '',
        ].filter(Boolean).join(' '),
        action: 'Install',
        destructive: runs.length > 0,
      })
      if (!ok) return null
      const go = (replace: boolean) => installReviewed(review.id, { path: s.path, name, project, replace })
      try {
        return await go(replacing)
      } catch (err) {
        if (!(err instanceof ApiError) || !/already there/.test(err.message)) throw err
        if (!(await confirmAction({ title: `Replace ${name}?`, description: `There is already a skill called ${name}. Its files are replaced by this one.`, action: 'Replace', destructive: true }))) return null
        return go(true)
      }
    },
    onSuccess: (r) => {
      if (!r) return
      setInstalled(true)
      void qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success(`${name} is installed`, { description: project ? 'Committed to the project on its own.' : 'New sessions and your personal agent can use it now.' })
      if (single) {
        onDone?.()
        void navigate(project ? { to: '/projects/$slug/skills/$name', params: { slug: project, name } } : { to: '/skills/$name', params: { name } })
      }
    },
  })

  return (
    <div className="flex flex-col gap-6">
      {s.problems.length > 0 && (
        <div className="flex gap-3 rounded-2xl bg-destructive/10 p-4 text-sm text-destructive dark:bg-destructive/15">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">{s.problems.map((p) => <p key={p}>{p}</p>)}</div>
        </div>
      )}
      {s.problems.length === 0 && <RunWarning count={runs.length} />}

      <div className="flex flex-col gap-1.5">
        <p className="text-[15px] text-pretty">{s.description ?? <span className="text-muted-foreground">No description.</span>}</p>
        <p className="font-mono text-xs text-muted-foreground break-all">{s.path || '(top folder)'} · {s.files.length} files · {bytes(s.size)}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Files</h3>
        <FileList files={s.files} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">SKILL.md</h3>
        <div className="max-h-[60dvh] overflow-y-auto rounded-2xl bg-surface p-4 ring-1 ring-border/60 md:p-5"><SkillMarkdown markdown={s.markdown} /></div>
      </section>

      {s.problems.length === 0 && (
        <div className="flex flex-col gap-4 border-t pt-5">
          <Field data-invalid={!!bad || undefined}>
            <FieldLabel htmlFor={`name-${s.path}`}>Install as</FieldLabel>
            <Input id={`name-${s.path}`} value={name} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64} disabled={installed}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} aria-invalid={!!bad} />
            {bad ? <FieldError>{bad}</FieldError>
              : notes.length ? <FieldDescription className="text-attention-foreground">{notes.map((n) => n.text).join(' ')}</FieldDescription>
              : <FieldDescription>The folder name, and how you call it (/{name}).</FieldDescription>}
          </Field>
          <ErrorAlert error={install.error} />
          <div className="flex justify-end">
            {installed
              ? <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><Check className="size-4" />Installed</span>
              : <Button disabled={!!bad || install.isPending} onClick={() => install.mutate()}>{install.isPending ? <><Spinner />Installing</> : project ? 'Install and commit' : 'Install'}</Button>}
          </div>
        </div>
      )}
    </div>
  )
}
