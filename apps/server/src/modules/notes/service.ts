import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { User } from '../auth/repo.ts'
import type { SearchService } from '../search/service.ts'
import type { Actor } from '../tasks/service.ts'

export const NOTE_STATUS = ['draft', 'confirmed', 'superseded'] as const
export type NoteStatus = (typeof NOTE_STATUS)[number]
/** A role's recurring summary note (e.g. "Weekly summary, week of 10-12"): a new one supersedes the role's previous one. */
const WEEKLY_RE = /weekly summary/i
type Row = {
  id: number; project_id: number | null; title: string; body: string; pinned: number; private: number; via_claude: number; via_role: string | null
  status: NoteStatus; superseded_by: number | null
  created_by: number; updated_by: number; created_at: number; updated_at: number
  slug: string | null; project_name: string | null; author_name: string; editor_name: string
}
const SELECT = `select n.*, p.slug, p.name as project_name, a.name as author_name, e.name as editor_name
  from notes n left join projects p on p.id = n.project_id join users a on a.id = n.created_by join users e on e.id = n.updated_by`

/** Markdown notes: team-visible by default, optionally private, optionally pinned to a project. */
export function notesService({ db, hub, activity, search }: { db: Db; hub: Hub; activity: ActivityService; search: SearchService }) {
  const q = {
    list: db.prepare(`${SELECT} where (n.private = 0 or n.created_by = ?1) and (?2 is null or p.slug = ?2)
      order by n.pinned desc, n.updated_at desc limit 500`),
    byId: db.prepare(`${SELECT} where n.id = ?`),
    project: db.prepare('select id from projects where slug = ?'),
    insert: db.prepare(`insert into notes (project_id, title, body, pinned, private, created_by, updated_by, via_claude, via_role, status)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`),
    update: db.prepare('update notes set project_id = ?, title = ?, body = ?, pinned = ?, private = ?, updated_by = ?, via_claude = ?, status = ?, updated_at = unixepoch() where id = ?'),
    remove: db.prepare('delete from notes where id = ?'),
    // A role's earlier weekly summaries in the same project, still current: marked superseded by the new one.
    priorWeekly: db.prepare(`select id from notes where project_id = ?1 and via_role = ?2 and id != ?3 and status != 'superseded' and lower(title) like '%weekly summary%'`),
    supersede: db.prepare(`update notes set status = 'superseded', superseded_by = ?, updated_at = unixepoch() where id = ?`),
  }
  const visible = (n: Row, userId: number) => !n.private || n.created_by === userId
  const dto = (n: Row) => ({
    id: n.id, title: n.title, body: n.body, pinned: n.pinned === 1, private: n.private === 1, viaClaude: n.via_claude === 1,
    status: n.status, supersededBy: n.superseded_by,
    project: n.slug ? { slug: n.slug, name: n.project_name! } : null,
    author: { id: n.created_by, name: n.author_name }, authorRole: n.via_role, editor: n.editor_name, createdAt: n.created_at, updatedAt: n.updated_at,
  })
  const changed = () => hub.publish('notes', { type: 'changed' })
  function find(user: Pick<User, 'id'>, id: number) {
    const n = q.byId.get(id) as Row | undefined
    if (!n || !visible(n, user.id)) throw new AppError(404, 'not_found', 'That note does not exist or is private.')
    return n
  }
  function projectId(slug: string | null | undefined) {
    if (!slug) return null
    const p = q.project.get(slug) as { id: number } | undefined
    if (!p) throw new AppError(404, 'not_found', `There is no project ${slug}.`)
    return p.id
  }
  function after(a: Actor, n: Row, verb: string) {
    search.put('note', n.id, n.title, n.body)
    if (!n.private) activity.record({ projectId: n.project_id, userId: a.user.id, viaClaude: a.viaClaude, role: a.role, kind: 'note.saved', summary: `${verb} note ${n.title}`, url: `/notes/${n.id}` })
    changed()
  }

  return {
    list: (user: Pick<User, 'id'>, project?: string) => (q.list.all(user.id, project ?? null) as Row[]).map(dto),
    get: (user: Pick<User, 'id'>, id: number) => dto(find(user, id)),
    /** For search results: only notes this member may see. */
    visibleIds(user: Pick<User, 'id'>, ids: number[]) {
      return ids.map((id) => q.byId.get(id) as Row | undefined).filter((n): n is Row => !!n && visible(n, user.id)).map(dto)
    },

    create(a: Actor, input: { title: string; body?: string; project?: string | null; pinned?: boolean; private?: boolean; status?: NoteStatus }) {
      const status = input.status && NOTE_STATUS.includes(input.status) ? input.status : 'confirmed'
      const { id } = q.insert.get(projectId(input.project), input.title.trim(), input.body ?? '', input.pinned ? 1 : 0, input.private ? 1 : 0, a.user.id, a.user.id, a.viaClaude ? 1 : 0, a.role ?? null, status) as { id: number }
      const n = q.byId.get(id) as Row
      // A role's new weekly summary supersedes its previous ones, so stale summaries don't look current.
      if (a.role && n.project_id && WEEKLY_RE.test(n.title)) {
        for (const prev of q.priorWeekly.all(n.project_id, a.role, id) as { id: number }[]) q.supersede.run(id, prev.id)
      }
      after(a, n, 'wrote')
      return dto(n)
    },

    update(a: Actor, id: number, patch: { title?: string; body?: string; project?: string | null; pinned?: boolean; private?: boolean; status?: NoteStatus }) {
      const n = find(a.user, id)
      if (patch.private !== undefined && n.created_by !== a.user.id) throw new AppError(403, 'forbidden', 'Only the author can change who sees a note.')
      // Marking it current again clears the "superseded by" link; otherwise the status follows the patch.
      const status = patch.status && NOTE_STATUS.includes(patch.status) ? patch.status : n.status
      q.update.run(patch.project === undefined ? n.project_id : projectId(patch.project), patch.title?.trim() || n.title, patch.body ?? n.body,
        patch.pinned === undefined ? n.pinned : patch.pinned ? 1 : 0, patch.private === undefined ? n.private : patch.private ? 1 : 0,
        a.user.id, a.viaClaude ? 1 : 0, status, id)
      if (patch.status && patch.status !== 'superseded' && n.superseded_by) db.prepare('update notes set superseded_by = null where id = ?').run(id)
      const updated = q.byId.get(id) as Row
      after(a, updated, 'updated')
      return dto(updated)
    },

    remove(user: Pick<User, 'id' | 'role'>, id: number) {
      const n = find(user, id)
      if (n.created_by !== user.id && user.role !== 'admin') throw new AppError(403, 'forbidden', 'Only the author or an admin can delete a note.')
      q.remove.run(id)
      search.remove('note', id)
      changed()
    },
  }
}

export type NotesService = ReturnType<typeof notesService>
