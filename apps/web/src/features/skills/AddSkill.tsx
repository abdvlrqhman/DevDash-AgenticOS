import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FileArchive, GitBranch, PenLine, Upload } from 'lucide-react'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { confirmAction } from '@/components/app/confirm'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import { bytes } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { DESCRIPTION_MAX, descriptionProblem, nameProblem, reviewGithub, reviewUpload, writeSkill } from './data'

type Way = 'write' | 'upload' | 'github'
const segment = 'min-w-fit flex-1 rounded-full px-3 hover:bg-surface-2'
const MAX_UPLOAD = 10 * 1024 * 1024

/** Add a skill: write one, upload a .zip/.skill, or paste a GitHub link. Uploads and links go to a review first. */
export function AddSkill({ open, onOpenChange, project }: { open: boolean; onOpenChange: (v: boolean) => void; project?: string }) {
  const [way, setWay] = useState<Way>('github')
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={project ? 'Add a skill to this project' : 'Add a skill'}
      description={project ? 'Committed to the project, so every session in it gets the skill, for the whole team.' : 'For all your sessions and your personal agent.'}>
      <div className="flex flex-col gap-5">
        <ToggleGroup type="single" spacing={1} value={way} onValueChange={(v) => v && setWay(v as Way)} aria-label="How to add it" className="w-full rounded-full bg-surface p-1">
          <ToggleGroupItem value="github" className={segment}><GitBranch />GitHub</ToggleGroupItem>
          <ToggleGroupItem value="upload" className={segment}><Upload />Upload</ToggleGroupItem>
          <ToggleGroupItem value="write" className={segment}><PenLine />Write</ToggleGroupItem>
        </ToggleGroup>
        {way === 'github' && <FromGithub project={project} onDone={() => onOpenChange(false)} />}
        {way === 'upload' && <FromUpload project={project} onDone={() => onOpenChange(false)} />}
        {way === 'write' && <WriteOne project={project} onDone={() => onOpenChange(false)} />}
      </div>
    </ResponsiveDialog>
  )
}

function useToReview(project?: string) {
  const navigate = useNavigate()
  return (id: string) => void navigate({ to: '/skills/review/$id', params: { id }, search: project ? { project } : {} })
}

function FromGithub({ project, onDone }: { project?: string; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const toReview = useToReview(project)
  const fetchIt = useMutation({
    mutationFn: () => reviewGithub(url.trim(), project),
    onSuccess: (r) => { onDone(); toReview(r.id) },
  })
  return (
    <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (url.trim()) fetchIt.mutate() }}>
      <Field>
        <FieldLabel htmlFor="skill-url">GitHub link</FieldLabel>
        <Input id="skill-url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://github.com/owner/repo/tree/main/skills/name"
          value={url} onChange={(e) => setUrl(e.target.value)} />
        <FieldDescription>A repository, or one folder in it. DevDash downloads it with your GitHub access into an empty folder and shows you every file before anything is installed.</FieldDescription>
      </Field>
      <ErrorAlert error={fetchIt.error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={!url.trim() || fetchIt.isPending}>{fetchIt.isPending ? <><Spinner />Fetching</> : 'Review'}</Button>
      </div>
    </form>
  )
}

function FromUpload({ project, onDone }: { project?: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const toReview = useToReview(project)
  const send = useMutation({
    mutationFn: (f: File) => reviewUpload(f, project),
    onSuccess: (r) => { onDone(); toReview(r.id) },
  })
  const tooBig = !!file && file.size > MAX_UPLOAD
  return (
    <div className="flex flex-col gap-4">
      <input ref={input} type="file" accept=".zip,.skill,application/zip" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); send.reset() }} />
      <button type="button" onClick={() => input.current?.click()}
        className="flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed bg-surface px-4 py-5 text-center text-sm transition-colors hover:bg-surface-2">
        <FileArchive className="size-5 text-muted-foreground" />
        {file ? <><span className="max-w-full truncate font-medium">{file.name}</span><span className="text-xs text-muted-foreground">{bytes(file.size)} · tap to pick another</span></>
          : <><span className="font-medium">Choose a .zip or .skill file</span><span className="text-xs text-muted-foreground">Up to 10 MB</span></>}
      </button>
      <p className="text-sm text-pretty text-muted-foreground">It is unpacked into an empty folder and checked: no paths outside it, no links, size limits. You see every file before anything is installed.</p>
      {tooBig && <ErrorAlert error="That file is over 10 MB." />}
      <ErrorAlert error={send.error} />
      <div className="flex justify-end">
        <Button disabled={!file || tooBig || send.isPending} onClick={() => file && send.mutate(file)}>{send.isPending ? <><Spinner />Checking</> : 'Review'}</Button>
      </div>
    </div>
  )
}

function WriteOne({ project, onDone }: { project?: string; onDone: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const input = { name, description: description.trim(), body }
      try {
        return await writeSkill(input, project)
      } catch (err) {
        if (!(err instanceof ApiError) || !/already there/.test(err.message)) throw err
        const ok = await confirmAction({ title: `Replace ${name}?`, description: `There is already a skill called ${name}. Its files are replaced by this one.`, action: 'Replace', destructive: true })
        if (!ok) throw new Error('Not saved: pick another name, or replace it.')
        return writeSkill({ ...input, replace: true }, project)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success(project ? `${name} is in the project` : `${name} is ready`, { description: project ? 'Committed on its own.' : 'New sessions and your personal agent can use it now.' })
      onDone()
    },
  })
  const nameBad = nameProblem(name)
  const descBad = descriptionProblem(description)
  const ready = name && !nameBad && description.trim() && !descBad && body.trim()
  return (
    <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (ready) save.mutate() }}>
      <FieldGroup className="gap-4">
        <Field data-invalid={!!nameBad || undefined}>
          <FieldLabel htmlFor="skill-name">Name</FieldLabel>
          <Input id="skill-name" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="release-notes" maxLength={64}
            value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} aria-invalid={!!nameBad} />
          {nameBad ? <FieldError>{nameBad}</FieldError> : <FieldDescription>Lowercase letters, digits and hyphens. Also the folder name.</FieldDescription>}
        </Field>
        <Field data-invalid={!!descBad || undefined}>
          <FieldLabel htmlFor="skill-desc">Description</FieldLabel>
          <Textarea id="skill-desc" rows={3} placeholder="Writes release notes from the commits since the last tag. Use when asked for release notes or a changelog."
            value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!descBad} />
          {descBad ? <FieldError>{descBad}</FieldError>
            : <FieldDescription>What it does and when to use it: agents pick skills by this. <span className="tabular-nums">{description.length}/{DESCRIPTION_MAX}</span></FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="skill-body">Instructions</FieldLabel>
          <Textarea id="skill-body" rows={8} className="font-mono text-[13px]" placeholder={'# Release notes\n\n1. Find the last tag…'} value={body} onChange={(e) => setBody(e.target.value)} />
          <FieldDescription>Markdown. The agent reads this when it uses the skill.</FieldDescription>
        </Field>
      </FieldGroup>
      <ErrorAlert error={save.error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? <><Spinner />Saving</> : project ? 'Add and commit' : 'Add skill'}</Button>
      </div>
    </form>
  )
}
