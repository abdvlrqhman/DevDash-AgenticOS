import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Archive, Ellipsis, MessageSquare, Pencil, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { confirmAction } from '@/components/app/confirm'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Prose } from '../claude/Prose'
import { nextLabel, roleQuery, useLiveTeam, type RoleDetail } from './data'
import { RoleDialog } from './RoleDialog'
import { RoleMark } from './TeamTab'
import { ProposalCard } from './Approvals'
import { RoleSettings } from './RoleSettings'

const TRIGGER: Record<string, string> = { manual: 'Started by hand' }
const minutes = (from: number, to: number | null) => {
  const m = Math.round(((to ?? Date.now() / 1000) - from) / 60)
  return m < 1 ? 'under a minute' : `${m} min`
}

export function RolePage() {
  const { slug, role } = useParams({ from: '/app/projects/$slug/team/$role' })
  return <RoleView key={role} slug={slug} id={Number(role)} />
}

function RoleView({ slug, id }: { slug: string; id: number }) {
  useLiveTeam()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const q = useQuery(roleQuery(id))
  const [editing, setEditing] = useState(false)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const shift = useMutation({
    mutationFn: () => unwrap(api.api.team.roles[':id'].shift.$post({ param: { id: String(id) } })),
    onSuccess: () => { toast.success('Shift started. It reports here when it\'s done.'); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const chat = useMutation({
    mutationFn: () => unwrap(api.api.team.roles[':id'].chat.$post({ param: { id: String(id) } })),
    onSuccess: (r) => void navigate({ to: '/claude/$id', params: { id: r.sessionId } }),
    onError: (e) => toast.error(e.message),
  })
  const archive = useMutation({
    mutationFn: () => unwrap(api.api.team.roles[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => { refresh(); void navigate({ to: '/projects/$slug', params: { slug } }) },
    onError: (e) => toast.error(e.message),
  })

  if (q.error) return <><PageHeader title="Role" back={`/projects/${slug}`} /><PageBody><ErrorAlert error={q.error} /></PageBody></>
  if (!q.data) return <><PageHeader title="Role" back={`/projects/${slug}`} /><PageBody><Skeleton className="h-64" /></PageBody></>
  const { role: r, project, shifts, notebook, proposals } = q.data

  return (
    <>
      <PageHeader back={`/projects/${slug}`}
        title={<span className="flex items-center gap-2.5"><RoleMark id={r.id} name={r.name} className="size-7 rounded-md text-[10px]" />{r.name}</span>}
        description={<span className="flex items-center gap-1.5">
          {r.working ? <><StatusLight state="live" />Working</> : r.paused ? <>Paused</> : r.nextShiftAt ? <>Next shift {nextLabel(r.nextShiftAt)}</> : <>Idle</>}
          <span className="truncate">· {project.name}{r.model ? ` · ${r.model[0]!.toUpperCase()}${r.model.slice(1)}` : ''}</span>
        </span>}
        actions={<>
          <Button size="sm" variant="outline" disabled={!!r.shift || shift.isPending} onClick={() => shift.mutate()}>
            {shift.isPending ? <Spinner /> : <Play />}<span className="hidden sm:inline">Run a shift</span>
          </Button>
          <Button size="sm" disabled={chat.isPending} onClick={() => chat.mutate()}>{chat.isPending ? <Spinner /> : <MessageSquare />}Chat</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="Role options"><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />Edit role</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void confirmAction({ title: `Remove ${r.name}?`, description: 'Its history stays in the database.', action: 'Remove role', destructive: true }).then((ok) => { if (ok) archive.mutate() })}><Archive />Remove role</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>} />
      <PageBody>
        {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}
        {proposals.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Waiting for your approval</h2>
            {proposals.map((x) => <ProposalCard key={x.id} x={x} showProject={false} />)}
          </section>
        )}
        {r.shift && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-live/40 p-4">
            <StatusLight state="live" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">On a shift</div>
              <div className="text-sm text-muted-foreground">Started {relativeTime(r.shift.startedAt)}. It writes a report here when it's done.</div>
            </div>
            {r.shift.sessionId && <Button size="sm" variant="outline" asChild><Link to="/claude/$id" params={{ id: r.shift.sessionId }}>Watch</Link></Button>}
          </div>
        )}
        <Tabs defaultValue="shifts" className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="shifts">Shifts{shifts.length > 0 && <TabCount>{shifts.length}</TabCount>}</TabsTrigger>
            <TabsTrigger value="notebook">Notebook{notebook.length > 0 && <TabCount>{notebook.length}</TabCount>}</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
          </TabsList>
          <TabsContent value="shifts"><Shifts shifts={shifts} onRun={() => shift.mutate()} canRun={!r.shift} /></TabsContent>
          <TabsContent value="notebook"><Notebook id={id} notes={notebook} /></TabsContent>
          <TabsContent value="schedule"><RoleSettings r={r} project={project} /></TabsContent>
          <TabsContent value="instructions">
            <div className="flex flex-col gap-3">
              <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil />Edit</Button></div>
              {r.instructions.trim()
                ? <div className="rounded-xl border p-4"><Prose text={r.instructions} /></div>
                : <p className="text-sm text-muted-foreground">No instructions yet. Edit the role and press Generate.</p>}
            </div>
          </TabsContent>
        </Tabs>
      </PageBody>
      <RoleDialog open={editing} onOpenChange={setEditing} slug={slug} role={r} />
    </>
  )
}

function Shifts({ shifts, onRun, canRun }: { shifts: RoleDetail['shifts']; onRun: () => void; canRun: boolean }) {
  if (!shifts.length) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
        <p className="font-medium">No shifts yet</p>
        <p className="max-w-md text-sm text-muted-foreground">On a shift the role reads what changed, looks at what matters for its job, does what it can on its own and writes a report.</p>
        <Button size="sm" className="mt-2" disabled={!canRun} onClick={onRun}><Play />Run the first shift</Button>
      </div>
    )
  }
  return (
    <ol className="flex flex-col gap-3">
      {shifts.map((s) => (
        <li key={s.id} className="flex flex-col gap-2 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-medium">{new Date(s.startedAt * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="text-muted-foreground">{TRIGGER[s.trigger] ?? `${s.trigger[0]!.toUpperCase()}${s.trigger.slice(1)}`}{s.costUsd > 0 ? ` · $${s.costUsd.toFixed(2)}` : ''}</span>
            <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
              {s.status === 'running' ? <><StatusLight state="live" />Running, {minutes(s.startedAt, null)}</>
                : s.status === 'error' ? <span className="text-destructive">Stopped with an error</span> : minutes(s.startedAt, s.endedAt)}
            </span>
          </div>
          {s.report ? <Prose text={s.report} /> : s.status === 'running' ? <p className="text-sm text-muted-foreground">Working…</p> : null}
          {s.sessionId && <Link to="/claude/$id" params={{ id: s.sessionId }} className="self-start text-xs text-muted-foreground hover:underline">See what it did →</Link>}
        </li>
      ))}
    </ol>
  )
}

function Notebook({ id, notes }: { id: number; notes: RoleDetail['notebook'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const add = useMutation({
    mutationFn: () => unwrap(api.api.team.roles[':id'].notebook.$post({ param: { id: String(id) }, json: { body } })),
    onSuccess: () => { setBody(''); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (note: number) => unwrap(api.api.team.roles[':id'].notebook[':note'].$delete({ param: { id: String(id), note: String(note) } })),
    onSuccess: refresh,
  })
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Its memory between shifts and chats: what it learned, what people told it, and what was rejected and why. It reads this every time it works.</p>
      <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate() }}>
        <Textarea rows={2} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="Tell it something to remember, e.g. never post on Fridays." className="min-h-10 flex-1" aria-label="New note" />
        <Button type="submit" disabled={!body.trim() || add.isPending}>Add note</Button>
      </form>
      {notes.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start gap-2 px-3.5 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{n.by ? `From ${n.by}` : 'It noted'}, {relativeTime(n.at)}</p>
              </div>
              <Button size="icon" variant="ghost" className="size-7 shrink-0 opacity-60 hover:opacity-100" aria-label="Forget this note" onClick={() => remove.mutate(n.id)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
