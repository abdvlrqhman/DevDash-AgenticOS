import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Archive, ArchiveRestore, Bot, Check, ChevronDown, Circle, Ellipsis, FileCode, Gauge, LoaderCircle, MessageSquare, Network, Pencil, Plus, Share2, SquareTerminal, Shield, ShieldOff, SlidersHorizontal, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, meQuery, unwrap } from '@/lib/api'
import { PinMenuItem } from '../pins/pins'
import { ErrorAlert } from '../auth/LoginPage'
import { FileViewerProvider } from '../files/FileViewer'
import { KeyBar } from '../terminal/KeyBar'
import { TerminalView, type Mods, type Status as TermStatus, type TerminalHandle } from '../terminal/TerminalView'
import { ModelChoices } from './ModelChoices'
import { effortLevels, modelLabel, type ModelInfo } from './models'
import { Blocks, Prose } from './Blocks'
import { Composer, type Doc, type Img, type Upload } from './Composer'
import { Comments, CommentsButton, commentsQuery, WatchOnly, Watchers, type Comment, type Person } from './Collab'
import { FAST_HINT, REMOTE_HINT, SessionChips } from './SessionChips'
import {
  EFFORTS, FALLBACK_MODELS, PERMISSION_MODES, commandsQuery, modeLabel, profilesQuery, sessionQuery, shortPath, STATUS_LABEL,
  type Effort, type PendingRequest, type PermissionMode, type Session, sessionPlace } from './data'
import { reconcilePending, type PendingChange } from './pending'
import { createLiveText, type LiveTextStore } from './live-text'
import { useArchiveSession } from './ArchiveSession'
import { ShareDialog, sharingLabel } from './ShareDialog'
import { Requests, requestSummary } from './Requests'
import { PlanUsage } from './Usage'
import { servicesQuery, stateOf } from '../services/data'
import { tailnetStatusQuery } from '../network/NetworkPage'
import { buildTranscript, mergePage, mergeRaw, sessionFacts, touchedFiles, type Raw } from './transcript'
import { SubagentCtx } from './ToolSteps'
import { useTopic } from '@/lib/live'
import { usePageTitle } from '@/lib/title'

const light = (s: Session['status']) => (s === 'working' ? 'live' : s === 'waiting' ? 'waiting' : s === 'error' ? 'error' : 'idle')
const termSize = () => ({ cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))) })

/** One view per session: switching sessions mounts a fresh one, so no messages or requests carry over. */
export function SessionPage() {
  const { id } = useParams({ from: '/app/claude/$id' })
  return <SessionView key={id} id={id} />
}

function SessionView({ id }: { id: string }) {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const info = useQuery(sessionQuery(id))
  // The transcript on disk is the truth: the CLI, other devices and other people add to it while this page isn't
  // looking. Re-read it whenever the page opens or comes back, and when the CLI hands back to Chat.
  // Only the latest turns come first (long sessions open fast); older ones load as you scroll up.
  const history = useQuery({
    queryKey: ['claude', 'history', id],
    queryFn: () => unwrap(api.api.claude.sessions[':id'].messages.$get({ param: { id }, query: {} })),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const [raw, setRaw] = useState<Raw[]>([])
  const [older, setOlder] = useState<Raw[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const keepPlace = useRef<{ height: number; top: number } | null>(null)
  const [liveText] = useState(createLiveText)
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [settings, setSettings] = useState(false)
  const [usage, setUsage] = useState(false)
  const [tailnet, setTailnet] = useState(false)
  const [share, setShare] = useState(false)
  const [viewers, setViewers] = useState<Person[]>([])
  const [commentCount, setCommentCount] = useState(0)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const commentsOpenRef = useRef(false)
  commentsOpenRef.current = commentsOpen
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // Live permission events own the pending cards; this shields a request a live event just added/removed from being
  // undone by a stale info snapshot, until info catches up. See reconcilePending.
  const recentlyChanged = useRef(new Map<string, PendingChange>())

  const s = info.data?.session
  usePageTitle(s?.title) // the browser tab shows the session name: "DevDash — <title>"
  const setSession = (session: Session) => qc.setQueryData(sessionQuery(id).queryKey, (old) => (old ? { ...old, session } : old))

  const letIn = (user: Person) =>
    unwrap(api.api.claude.sessions[':id'].writers[':userId'].$put({ param: { id, userId: String(user.id) }, json: { allowed: true } })).then(
      () => { toast.success(`${user.name} can send messages now.`); void info.refetch() },
      (err: Error) => toast.error(err.message),
    )

  useTopic(`session:${id}`, (e) => {
    if (e.type === 'session') setSession(e.session as Session)
    else if (e.type === 'viewers') setViewers(e.viewers as Person[])
    else if (e.type === 'access') void info.refetch()
    else if (e.type === 'join_request') {
      const user = e.user as Person
      toast(`${user.name} asks to join`, {
        description: 'They can watch. Let them send messages too?', duration: 60_000,
        action: { label: 'Let in', onClick: () => void letIn(user) },
      })
    } else if (e.type === 'comment') {
      const c = e.comment as Comment
      const cached = qc.getQueryData<{ comments: Comment[] }>(commentsQuery(id).queryKey)
      if (!cached?.comments.some((x) => x.id === c.id)) {
        setCommentCount((n) => n + 1)
        if (cached) qc.setQueryData(commentsQuery(id).queryKey, { comments: [...cached.comments, c] })
      }
      if (c.user.id !== me.id && !commentsOpenRef.current) {
        toast(`${c.user.name} commented`, { description: c.body.slice(0, 140), action: { label: 'Open', onClick: () => setCommentsOpen(true) } })
      }
    } else if (e.type === 'permission') {
      const r = e.request as PendingRequest
      stick.current = true // a question/permission arriving mid-read must scroll into view, not hide below the fold
      recentlyChanged.current.set(r.requestId, 'added')
      setPending((p) => [...p.filter((x) => x.requestId !== r.requestId), r]) // appears instantly, before info catches up
      void info.refetch() // pull the authoritative snapshot; the live add above wins until it lands
    } else if (e.type === 'permission_done') {
      const requestId = e.requestId as string
      recentlyChanged.current.set(requestId, 'removed')
      setPending((p) => p.filter((x) => x.requestId !== requestId)) // clears instantly, even if a stale info refetch is in flight
      void info.refetch()
    } else if (e.type === 'msg') {
      const m = e.msg as Raw & { event?: { type?: string; delta?: { type?: string; text?: string } } }
      if (m.type === 'stream_event') {
        if (m.parent_tool_use_id) return
        if (m.event?.type === 'message_start') liveText.reset()
        else if (m.event?.delta?.type === 'text_delta') liveText.append(m.event!.delta!.text ?? '')
        return
      }
      if (m.type === 'assistant' && !m.parent_tool_use_id) liveText.reset()
      // Live messages carry no time of their own: they happened now.
      setRaw((r) => mergeRaw(r, [m.timestamp ? m : { ...m, timestamp: new Date().toISOString() }]))
    }
  }, () => {
    void info.refetch()
    void history.refetch()
  })

  useEffect(() => {
    if (!history.data) return
    setRaw((have) => mergePage(have, history.data.messages as Raw[]))
    setHasOlder((had) => had || history.data.more)
  }, [history.data])
  const all = useMemo(() => (older.length ? mergeRaw(older, raw) : raw), [older, raw])
  const loadOlder = async () => {
    const first = all.find((m) => m.uuid && !m.uuid.startsWith('turn'))?.uuid
    if (loadingOlder || !hasOlder || !first) return
    setLoadingOlder(true)
    try {
      const page = await unwrap(api.api.claude.sessions[':id'].messages.$get({ param: { id }, query: { before: first } }))
      const el = scroller.current
      if (el) keepPlace.current = { height: el.scrollHeight, top: el.scrollTop }
      setOlder((o) => [...(page.messages as Raw[]), ...o])
      setHasOlder(page.more)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoadingOlder(false)
    }
  }
  // Older messages go in above what you're reading: keep it where it was on screen.
  useLayoutEffect(() => {
    const el = scroller.current
    const k = keepPlace.current
    if (!el || !k) return
    el.scrollTop = el.scrollHeight - k.height + k.top
    keepPlace.current = null
  }, [older])
  const mode = info.data?.session.mode
  const lastMode = useRef(mode)
  useEffect(() => {
    if (lastMode.current === 'cli' && mode === 'chat') void history.refetch()
    lastMode.current = mode
  }, [mode, history])
  useEffect(() => {
    if (!info.data) return
    // Info seeds the cards and is the fallback, but never clobbers a live permission event still settling.
    const fromInfo = info.data.pending as PendingRequest[]
    setPending((live) => reconcilePending(live, fromInfo, recentlyChanged.current))
    // Once info confirms a live change (lists an added one, or drops a removed one), stop shielding it.
    const present = new Set(fromInfo.map((r) => r.requestId))
    for (const [id, change] of recentlyChanged.current) {
      if (change === 'added' ? present.has(id) : !present.has(id)) recentlyChanged.current.delete(id)
    }
    setViewers(info.data.viewers)
    setCommentCount(info.data.comments)
  }, [info.data])
  const blocks = useMemo(() => buildTranscript(all), [all])
  const touched = useMemo(() => touchedFiles(blocks), [blocks])
  // So a Task step can fetch its subagent's activity and know, from the live task list, whether it is still running.
  const subagentCtx = useMemo(() => ({ sessionId: id, tasks: s?.tasks ?? [] }), [id, s?.tasks])
  const lastPromptAt = useMemo(() => blocks.findLast((b) => b.kind === 'user')?.at, [blocks]) as number | undefined
  const toBottom = () => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }
  useEffect(toBottom, [blocks, pending])

  const send = async (text: string, images: Img[], files: Doc[] = [], uploads: Upload[] = []) => {
    const { uuid } = await unwrap(api.api.claude.sessions[':id'].messages.$post({
      param: { id }, json: { text, images, files: files.map(({ name, mediaType, data }) => ({ name, mediaType, data })), uploads },
    }))
    stick.current = true
    // The server also broadcasts it (for other devices) and may get here first: merge by uuid, never append twice.
    setRaw((r) => mergeRaw(r, [{
      type: 'user', uuid, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...[...files, ...uploads].map((f) => ({ type: 'document', title: f.name })),
        ...(text ? [{ type: 'text', text }] : []),
      ] },
    }]))
  }
  const interrupt = useMutation({ mutationFn: () => unwrap(api.api.claude.sessions[':id'].interrupt.$post({ param: { id } })) })
  const switchMode = useMutation({
    mutationFn: (mode: 'chat' | 'cli') => unwrap(api.api.claude.sessions[':id'].mode.$post({ param: { id }, json: { mode, ...termSize() } })),
    onSuccess: (r) => setSession(r.session),
    onError: (e) => toast.error(e.message),
  })
  const update = useMutation({
    mutationFn: (json: Parameters<Updater>[0] & { title?: string }) =>
      unwrap(api.api.claude.sessions[':id'].$patch({ param: { id }, json })),
    onSuccess: (r) => setSession(r.session),
    onError: (e) => toast.error(e.message),
  })
  const defaults = useQuery(profilesQuery).data?.defaults
  const afterPlanApproved = () => unwrap(api.api.claude.sessions[':id'].$patch({
    param: { id }, json: { permissionMode: defaults && defaults.permission_mode !== 'plan' ? defaults.permission_mode as PermissionMode : 'acceptEdits' },
  }))

  if (info.error) {
    return (
      <>
        <PageHeader title="Session" back="/claude" />
        <div className="p-4"><ErrorAlert error={info.error} /></div>
      </>
    )
  }
  if (!s) return <><PageHeader title="Session" back="/claude" /><div className="flex flex-col gap-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div></>

  const canSend = info.data!.canSend
  const role = info.data!.role // a team role's session: shown as the role, not the account the team runs on
  const isOwner = info.data!.isOwner
  const working = s.status === 'working'
  const watching = viewers.filter((v) => v.id !== me.id).length
  const showComments = s.shared || commentCount > 0


  // File paths in the conversation open in the file viewer, relative ones from the session's folder.
  return (
    <FileViewerProvider cwd={s.cwd} username={s.owner.username} touched={touched}>
    <div className="flex h-full flex-col">
      <PageHeader back="/claude" backOnSmall
        title={s.title}
        description={
          <span className="flex items-center gap-1.5">
            <StatusLight state={light(s.status)} />
            {s.status === 'waiting' && pending[0]
              ? <span className="min-w-0 truncate font-medium text-attention-foreground">{requestSummary(pending[0])}</span>
              : STATUS_LABEL[s.status]}
            <span className="truncate" title={s.cwd}>{sessionPlace(s)}</span>
            {role
              ? <span className="flex shrink-0 items-center gap-1"><Bot className="size-3" />{role.name} · AI team</span>
              : <>
                  {s.owner.id !== me.id && <span className="shrink-0">, {s.owner.name}'s</span>}
                  {s.audience !== 'private' && s.owner.id === me.id && <span className="flex shrink-0 items-center gap-1">, <Share2 className="size-3" />{sharingLabel(s)}</span>}
                </>}
            {watching > 0 && <span className="shrink-0 sm:hidden">, {watching} watching</span>}
          </span>
        }
        actions={<>
          <div className="hidden sm:flex"><Watchers viewers={viewers} me={me.id} /></div>
          {showComments && <CommentsButton count={commentCount} onClick={() => setCommentsOpen(true)} />}
          <ModelMenu s={s} disabled={!canSend} isOwner={isOwner} onUpdate={(v) => update.mutate(v)} />
          <Tabs value={s.mode} onValueChange={(v) => v !== s.mode && switchMode.mutate(v as 'chat' | 'cli')}>
            <TabsList className="pointer-coarse:h-10!">
              <TabsTrigger value="chat" disabled={!canSend || switchMode.isPending}><MessageSquare /><span className="hidden sm:inline">Chat</span></TabsTrigger>
              <TabsTrigger value="cli" disabled={!canSend || switchMode.isPending}><SquareTerminal /><span className="hidden sm:inline">CLI</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <SessionMenu s={s} isOwner={isOwner} canSend={canSend} onUpdate={(v) => update.mutate(v)} onShare={() => setShare(true)} onRename={() => setSettings(true)} onUsage={() => setUsage(true)} onTailnet={() => setTailnet(true)} />
        </>} />


      {s.mode === 'cli' ? (
        <CliView id={id} onEnded={() => void info.refetch()} />
      ) : (
        <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {history.isPending && s.started && [0, 1].map((i) => <Skeleton key={i} className="h-20" />)}
              {hasOlder && <Earlier loading={loadingOlder} onLoad={() => void loadOlder()} root={scroller}
                // Only when you scrolled up (or everything fits): not in the moment the page opens at the top.
                auto={() => { const el = scroller.current; return !!el && (!stick.current || el.scrollHeight <= el.clientHeight + 8) }} />}
              <ErrorAlert error={history.error} />
              {!s.started && !raw.length && <p className="py-10 text-center text-muted-foreground">Tell Claude what to work on.</p>}
              <SubagentCtx.Provider value={subagentCtx}>
                <Blocks blocks={blocks} senders={history.data?.senders} live={working || s.status === 'waiting'} />
              </SubagentCtx.Provider>
              <LiveText store={liveText} working={working} since={lastPromptAt} onGrow={toBottom} />
              {s.status === 'error' && s.statusDetail && <ErrorAlert error={s.statusDetail} />}
              <Requests sessionId={id} requests={pending} canAnswer={canSend} waitingOn={canSend ? undefined : s.owner.name} afterPlanApproved={afterPlanApproved} />
            </div>
          </div>
          <div className="border-t bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6 md:pt-3 md:pb-3">
            <div className="mx-auto max-w-4xl">
              <Composer sessionId={id} profile={s.profile} working={working || s.status === 'waiting'} onSend={send} onStop={() => interrupt.mutate()}
                disabledReason={canSend ? undefined : <WatchOnly id={id} owner={s.owner.name} onComment={() => setCommentsOpen(true)} />}
                footer={<SessionChips s={s} isOwner={isOwner} canSend={canSend} working={working} onUpdate={(v) => update.mutate(v)}
                  onCompact={() => void send('/compact', []).catch((err: Error) => toast.error(err.message))} />} />
            </div>
          </div>
        </div>
        <SessionAside s={s} blocks={blocks} isOwner={isOwner} />
        </div>
      )}
      <Comments id={id} open={commentsOpen} onOpenChange={setCommentsOpen} me={me.id} />
      {isOwner && <RenameDialog open={settings} onOpenChange={setSettings} s={s} onSave={(title) => update.mutate({ title })} />}
      {isOwner && <TailnetDialog open={tailnet} onOpenChange={setTailnet} s={s} onUpdate={(v) => update.mutateAsync(v)} />}
      {isOwner && <ShareDialog open={share} onOpenChange={setShare} s={s} me={me.id} people={info.data!.people} writers={info.data!.writers} onSaved={() => void info.refetch()} />}
      {isOwner && (
        <ResponsiveDialog open={usage} onOpenChange={setUsage} title="Usage" description="This session's own cost and tokens, and your Claude plan's limits (the same as /usage in Claude Code).">
          <PlanUsage profile={s.profile} sessionId={s.id} className="pb-2 text-sm" />
        </ResponsiveDialog>
      )}
    </div>
    </FileViewerProvider>
  )
}

/** At the top of a long conversation: loads the turns before it, by itself as it scrolls into view (or on a tap). */
function Earlier({ loading, onLoad, root, auto }: { loading: boolean; onLoad: () => void; root: React.RefObject<HTMLDivElement | null>; auto: () => boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const load = useRef(onLoad)
  const can = useRef(auto)
  can.current = auto
  load.current = onLoad
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && can.current()) load.current() }, { root: root.current, rootMargin: '400px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [root])
  return (
    <button ref={ref} onClick={onLoad} disabled={loading} className="self-center rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      {loading ? 'Loading earlier messages…' : 'Earlier messages'}
    </button>
  )
}

/** Only this re-renders while Claude types, at most once per frame (see live-text.ts). */
const LiveText = memo(function LiveText({ store, working, since, onGrow }: { store: LiveTextStore; working: boolean; since?: number; onGrow: () => void }) {
  const text = useSyncExternalStore(store.subscribe, store.get)
  const grow = useRef(onGrow)
  grow.current = onGrow
  useLayoutEffect(() => grow.current(), [text])
  if (text) return <Prose text={text} />
  return working ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><StatusLight state="live" />Claude is working… <Elapsed since={since} /></p> : null
})

/** How long Claude has been on this answer, counting up. */
function Elapsed({ since }: { since?: number }) {
  const [mounted] = useState(Date.now)
  const start = since && Date.now() - since < 6 * 3_600_000 ? since : mounted
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((Date.now() - start) / 1000)
  return s < 3 ? null : <span className="tabular-nums">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`}</span>
}

/** Wide screens: what Claude is doing at a glance, beside the conversation. */
function SessionAside({ s, blocks, isOwner }: { s: Session; blocks: ReturnType<typeof buildTranscript>; isOwner: boolean }) {
  const { todos, files } = useMemo(() => sessionFacts(blocks), [blocks])
  const services = useQuery(servicesQuery).data?.services.filter((x) => x.session?.id === s.id) ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <aside aria-label="Session details" className="hidden w-72 shrink-0 flex-col gap-6 overflow-y-auto border-l p-4 text-sm xl:flex">
      {services.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Services</h2>
          <ul className="flex flex-col gap-1">
            {services.map((x) => (
              <li key={x.name}>
                <Link to="/services/$name" params={{ name: x.name }} className="flex items-center gap-2 rounded-md py-0.5 hover:underline">
                  <StatusLight state={stateOf(x).light} /><span className="font-mono">{x.name}</span><span className="ml-auto font-mono text-xs text-muted-foreground">:{x.port}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {todos.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-baseline justify-between font-medium">To-dos <span className="text-xs font-normal text-muted-foreground">{done} of {todos.length}</span></h2>
          <ul className="flex flex-col gap-1.5">
            {todos.map((t, i) => (
              <li key={i} className={t.status === 'completed' ? 'flex gap-2 text-muted-foreground line-through' : 'flex gap-2'}>
                {t.status === 'completed' ? <Check className="mt-0.5 size-3.5 shrink-0 text-live" />
                  : t.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                  : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                <span>{t.content}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Changed files</h2>
        {files.length ? (
          <ul className="flex flex-col gap-1">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2" title={f.path}>
                <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path.split('/').pop()}</span>
                <span className="shrink-0 font-mono text-xs"><span className="text-live">+{f.added}</span> <span className="text-destructive">-{f.removed}</span></span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">Nothing yet.</p>}
      </section>
      {isOwner && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Usage</h2>
          <PlanUsage profile={s.profile} sessionId={s.id} />
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Details</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Folder</dt><dd className="truncate font-mono" title={s.cwd}>{shortPath(s.cwd, s.owner.username)}</dd>
          <dt className="text-muted-foreground">Profile</dt><dd>{s.profile}</dd>
          <dt className="text-muted-foreground">Model</dt><dd>{s.model ?? 'Default'}</dd>
          <dt className="text-muted-foreground">Permissions</dt><dd>{modeLabel(s.permissionMode)}</dd>
          <dt className="text-muted-foreground">Owner</dt><dd>{s.owner.name}</dd>
          <dt className="text-muted-foreground">Started</dt><dd>{new Date(s.createdAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        </dl>
      </section>
    </aside>
  )
}

function CliView({ id, onEnded }: { id: string; onEnded: () => void }) {
  const [status, setStatus] = useState<TermStatus>('connecting')
  const [mods, setMods] = useState<Mods>({ ctrl: false, alt: false })
  const term = useRef<TerminalHandle>(null)
  useEffect(() => { if (status === 'ended') onEnded() }, [status, onEnded])
  return (
    <>
      <div className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-term-bg p-2 md:m-4">
        <TerminalView ref={term} path={`/api/claude/sessions/${id}/cli`} onStatus={setStatus} onMods={setMods} />
        {status === 'ended' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-term-bg/95 px-6 text-center text-term-fg">
            <SquareTerminal className="size-5" />
            <p>Claude CLI exited. The conversation continues in Chat.</p>
          </div>
        )}
      </div>
      <KeyBar term={term} mods={mods} />
    </>
  )
}

type Updater = (v: {
  model?: string | null; effort?: Effort | null; permissionMode?: PermissionMode; shared?: boolean; sharedCanSend?: boolean; archived?: boolean
  fastMode?: boolean; remoteControl?: boolean; reachTailnet?: boolean; tailnetMcps?: { name: string; url: string }[] | null
}) => void

/** Model, effort and permissions, changed in place from the chip row. */
function ModelMenu({ s, disabled, isOwner, onUpdate }: { s: Session; disabled: boolean; isOwner: boolean; onUpdate: Updater }) {
  const models = useQuery({ ...commandsQuery(s.profile), enabled: !disabled }).data?.models as ModelInfo[] | undefined
  const list: ModelInfo[] = models?.length ? models : FALLBACK_MODELS
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" size="sm" className="shrink-0 max-sm:size-9 max-sm:px-0" aria-label="Model, effort and permissions">
          <SlidersHorizontal className="sm:hidden" />
          <span className="hidden sm:inline">{modelLabel(list, s.model)}</span>
          <span className="hidden items-center gap-1 border-l pl-2 text-foreground/80 sm:flex">
            {s.permissionMode === 'bypassPermissions' ? <ShieldOff /> : <Shield />}{modeLabel(s.permissionMode)}{s.effort ? `, ${s.effort}` : ''}
            {s.fastMode && <Zap aria-label="Fast mode" />}
          </span>
          <ChevronDown className="hidden sm:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <ModelChoices models={list} value={s.model} onChange={(v) => onUpdate({ model: v })} />
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Permissions: {modeLabel(s.permissionMode)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <DropdownMenuRadioGroup value={s.permissionMode} onValueChange={(v) => onUpdate({ permissionMode: v as PermissionMode })}>
              {PERMISSION_MODES.map((p) => (
                <DropdownMenuRadioItem key={p.value} value={p.value} className="items-start">
                  <span className="flex flex-col"><span>{p.label}</span><span className="text-xs text-muted-foreground">{p.hint}</span></span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Effort: {s.effort ?? 'auto'}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={s.effort ?? ''} onValueChange={(v) => onUpdate({ effort: (v || null) as Effort | null })}>
              <DropdownMenuRadioItem value="">Auto</DropdownMenuRadioItem>
              {effortLevels(list, s.model, EFFORTS).map((e) => <DropdownMenuRadioItem key={e} value={e} className="capitalize">{e}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{s.mode === 'cli' ? 'In the CLI it applies when the CLI next opens; use /effort to change it right away.' : 'Applies right away, even mid-answer.'}</p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <SwitchRow label="Fast mode" checked={s.fastMode} onChange={(v) => onUpdate({ fastMode: v })}
          hint={`${FAST_HINT}${s.mode === 'cli' ? ' In the CLI it applies when the CLI next opens; /fast switches it now.' : ''}`} />
        {isOwner && (
          <SwitchRow label="Remote Control" checked={s.remoteControl} onChange={(v) => onUpdate({ remoteControl: v })}
            hint={`${REMOTE_HINT}${s.mode === 'cli' ? ' In the CLI it applies when the CLI next opens; /remote-control switches it now.' : ''}`} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A setting with a switch and a line about what it does, inside a menu (it stays open). */
function SwitchRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
      <span className="flex flex-col"><span>{label}</span><span className="text-xs text-muted-foreground">{hint}</span></span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  )
}

function SessionMenu({ s, isOwner, canSend, onUpdate, onShare, onRename, onUsage, onTailnet }: {
  s: Session; isOwner: boolean; canSend: boolean; onUpdate: Updater; onShare: () => void; onRename: () => void; onUsage: () => void; onTailnet: () => void
}) {
  const navigate = useNavigate()
  const archive = useArchiveSession(() => void navigate({ to: '/claude' }))
  return (
    <>
    {archive.dialog}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Session options"><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {isOwner ? (
          <>
            <DropdownMenuItem onSelect={onRename}><Pencil />Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={onUsage}><Gauge />Usage</DropdownMenuItem>
            <DropdownMenuItem onSelect={onTailnet}><Network />Reach my tailnet{s.reachTailnet ? ' · on' : ''}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onShare}>
              <Share2 />Share…<span className="ml-auto truncate text-xs text-muted-foreground">{sharingLabel(s) || 'only you'}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {s.archived
              ? <DropdownMenuItem onSelect={() => onUpdate({ archived: false })}><ArchiveRestore />Restore from archive</DropdownMenuItem>
              : <DropdownMenuItem variant="destructive" onSelect={() => archive.ask(s)}><Archive />Archive…</DropdownMenuItem>}
          </>
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {s.owner.name} shared this session. Claude runs as {s.owner.name}{canSend ? '; you can send messages.' : '.'}
          </p>
        )}
        <DropdownMenuSeparator />
        <PinMenuItem kind="session" id={s.id} />
        <DropdownMenuItem asChild><Link to="/claude/setup">Claude setup</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  )
}

function RenameDialog({ open, onOpenChange, s, onSave }: { open: boolean; onOpenChange: (v: boolean) => void; s: Session; onSave: (t: string) => void }) {
  const [title, setTitle] = useState(s.title)
  useEffect(() => setTitle(s.title), [s.title, open])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Rename session">
      <form onSubmit={(e) => { e.preventDefault(); onSave(title); onOpenChange(false) }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="title">Title</FieldLabel>
            <Input id="title" className="h-10" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <FieldDescription>Shown in the session list and on Home.</FieldDescription>
          </Field>
          <Button type="submit" className="h-10" disabled={!title.trim() || title.trim() === s.title}>Save title</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}

/**
 * Owner-only: route this session's shell tools (ssh/curl/frida) and an optional tailnet MCP through the owner's
 * private Tailscale node. Only available while they have a connected node; Claude's own API traffic is never proxied.
 */
function TailnetDialog({ open, onOpenChange, s, onUpdate }: {
  open: boolean; onOpenChange: (v: boolean) => void; s: Session
  onUpdate: (v: { reachTailnet?: boolean; tailnetMcps?: { name: string; url: string }[] | null }) => Promise<unknown>
}) {
  const status = useQuery({ ...tailnetStatusQuery, enabled: open })
  const connected = !!status.data?.connected && !!status.data?.running
  const [reach, setReach] = useState(s.reachTailnet)
  const [mcps, setMcps] = useState<{ name: string; url: string }[]>(s.tailnetMcps ?? [])
  const [error, setError] = useState<Error | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) { setReach(s.reachTailnet); setMcps(s.tailnetMcps ?? []); setError(null) } }, [open, s.reachTailnet, s.tailnetMcps])
  const setRow = (i: number, k: 'name' | 'url', v: string) => setMcps((m) => m.map((e, j) => (j === i ? { ...e, [k]: v } : e)))
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const clean = reach ? mcps.filter((m) => m.url.trim()).map((m) => ({ name: m.name.trim(), url: m.url.trim() })) : []
      await onUpdate({ reachTailnet: reach, tailnetMcps: clean })
      onOpenChange(false)
    } catch (err) {
      setError(err as Error)
    } finally {
      setSaving(false)
    }
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Reach my tailnet"
      description="Let this session reach your private Tailscale devices by their 100.x addresses. Your own Claude/Anthropic traffic is never routed through it.">
      <form onSubmit={save}>
        <FieldGroup>
          {!connected && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              No connected tailnet node. <Link to="/network" className="underline underline-offset-4" onClick={() => onOpenChange(false)}>Connect it on the Network page</Link> first.
            </p>
          )}
          <label className="flex cursor-pointer items-start justify-between gap-3 text-sm">
            <span className="flex flex-col">
              <span className="font-medium">Route this session through my tailnet</span>
              <span className="text-xs text-muted-foreground">ssh (via the <code>tailnet-connect</code> ProxyCommand helper), curl and frida reach your 100.x devices; net_devices lists them.</span>
            </span>
            <Switch checked={reach} disabled={!connected} onCheckedChange={setReach} className="mt-0.5" />
          </label>
          {reach && (
            <Field>
              <FieldLabel>Tailnet MCP servers (optional)</FieldLabel>
              {mcps.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="h-10 w-28 font-mono" placeholder="name" value={m.name} onChange={(e) => setRow(i, 'name', e.target.value)} />
                  <Input className="h-10 flex-1 font-mono" placeholder="http://100.x.x.x:13337/mcp" value={m.url} onChange={(e) => setRow(i, 'url', e.target.value)} />
                  <Button type="button" size="icon" variant="ghost" className="size-10 shrink-0" aria-label="Remove" onClick={() => setMcps((v) => v.filter((_, j) => j !== i))}><X /></Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" className="self-start" disabled={mcps.length >= 8} onClick={() => setMcps((v) => [...v, { name: '', url: '' }])}><Plus />Add MCP</Button>
              <FieldDescription>MCP servers on your tailnet (e.g. IDA Pro), each exposed to this session over the proxy and named for Claude. Hosts must be tailnet addresses (100.x or a *.ts.net name). Up to 8.</FieldDescription>
            </Field>
          )}
          <ErrorAlert error={error} />
          <p className="text-xs text-muted-foreground">Takes effect when Claude next starts this session.</p>
          <Button type="submit" className="h-10" disabled={saving || (reach && !connected)}>{saving ? 'Saving…' : 'Save'}</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
