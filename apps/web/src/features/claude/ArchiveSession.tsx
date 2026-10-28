import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import type { Session } from './data'

const setArchived = (id: string, archived: boolean) => unwrap(api.api.claude.sessions[':id'].$patch({ param: { id }, json: { archived } }))

/** Archive with a confirmation step (and Undo). Returns `ask(session)` and the dialog to render. */
export function useArchiveSession(onArchived?: (s: Session) => void) {
  const [target, setTarget] = useState<Session | null>(null)
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['claude'] })
  const archive = useMutation({
    mutationFn: (s: Session) => setArchived(s.id, true),
    onSuccess: (_r, s) => {
      setTarget(null)
      refresh()
      onArchived?.(s)
      toast(`Archived “${s.title}”`, { action: { label: 'Undo', onClick: () => void setArchived(s.id, false).then(refresh) } })
    },
  })
  const dialog = (
    <ResponsiveDialog open={!!target} onOpenChange={(v) => { if (!v) { setTarget(null); archive.reset() } }} title={`Archive “${target?.title ?? ''}”?`}
      description={target?.status === 'working' || target?.status === 'waiting'
        ? 'Claude is still working on it: archiving stops it. The conversation stays under Archived, where you can open it again.'
        : 'It moves to Archived. Nothing is deleted, and you can open it again from there.'}>
      <div className="flex flex-col gap-3">
        <ErrorAlert error={archive.error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setTarget(null)}>Keep it</Button>
          <Button variant="destructive" disabled={archive.isPending} onClick={() => target && archive.mutate(target)}>Archive</Button>
        </div>
      </div>
    </ResponsiveDialog>
  )
  return { ask: setTarget, dialog, restore: (s: Session) => setArchived(s.id, false).then(refresh) }
}
