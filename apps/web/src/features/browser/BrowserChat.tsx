import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, X } from 'lucide-react'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'

const chat = api.api.browser.chat

export function BrowserChat({ userId, onClose }: { userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const key = ['browser-chat', userId]
  const state = useQuery({ queryKey: key, queryFn: () => unwrap(chat.$get()), retry: false,
    refetchInterval: (q) => q.state.data?.busy ? 1000 : 10_000, staleTime: 0 })
  const [draft, setDraft] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const bottom = useRef<HTMLDivElement>(null)
  const send = useMutation({
    mutationFn: () => unwrap(chat.$post({ json: { message: draft.trim(), requestId: requestId.current } })),
    onSuccess: async () => {
      requestId.current = crypto.randomUUID()
      setDraft('')
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const turns = state.data?.turns
  const last = turns?.at(-1)
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [last?.id, last?.reply])
  return (
    <aside aria-label="Browser chat" className="flex min-h-0 flex-1 flex-col gap-3 rounded-2xl border bg-background p-3 md:max-w-sm md:p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Browser chat</h2>
          <p className="mt-1 text-xs text-muted-foreground">The model reads visible text. Browser actions are visible to everyone watching.</p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close browser chat" onClick={onClose}><X /></Button>
      </div>
      <div role="log" aria-label="Conversation" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
        {state.isPending && <Spinner />}
        <ErrorAlert error={state.error} />
        {!state.error && turns?.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-2">
            <p className="ml-6 self-end whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2">{turn.message}</p>
            <p className="mr-4 whitespace-pre-wrap break-words">{turn.reply ?? 'Working…'}</p>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && !send.isPending && !state.data?.busy && !state.error) send.mutate() }}>
        <ErrorAlert error={send.error} />
        <Textarea aria-label="Message the browser assistant" placeholder="Ask about the page, open a URL, click a label, or scroll…" maxLength={3000} rows={2}
          className="max-h-28 min-h-14" value={draft} disabled={send.isPending} onChange={(e) => { setDraft(e.target.value); requestId.current = crypto.randomUUID() }} />
        <Button size="sm" type="submit" className="self-end" disabled={!draft.trim() || !state.data || !!state.error || send.isPending || state.data.busy}>
          {send.isPending || state.data?.busy ? <Spinner /> : <Send />}Send
        </Button>
      </form>
    </aside>
  )
}

export function ChatAccess({ onClose, userId }: { onClose: () => void; userId: number }) {
  const qc = useQueryClient()
  const key = ['browser-chat-access', userId]
  const list = useQuery({ queryKey: key, queryFn: () => unwrap(chat.access.$get()), staleTime: 0 })
  const save = useMutation({
    mutationFn: ({ id, allowed }: { id: number; allowed: boolean }) => unwrap(chat.access[':id'].$put({ param: { id: String(id) }, json: { allowed } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()} title="Browser chat access"
      description="Admins always have access. Grant a member access to use your Autopilot supervisor model in the shared browser.">
      <div className="flex flex-col gap-3 pb-2">
        <ErrorAlert error={list.error ?? save.error} />
        {list.isPending && <Spinner />}
        {list.data?.members.length === 0 && <p className="text-sm text-muted-foreground">There are no other members to grant access to.</p>}
        {list.data?.members.map((m) => (
          <label key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2.5">
            <span className="min-w-0 text-sm"><span className="block truncate font-medium">{m.name}</span><span className="text-xs text-muted-foreground">@{m.username}</span></span>
            <Switch aria-label={'Browser chat for ' + m.username} checked={m.allowed} disabled={save.isPending}
              onCheckedChange={(allowed) => save.mutate({ id: m.id, allowed })} />
          </label>
        ))}
      </div>
    </ResponsiveDialog>
  )
}
