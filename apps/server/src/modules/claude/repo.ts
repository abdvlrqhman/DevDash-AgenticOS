import type { Db } from '../../core/db.ts'

export type SessionStatus = 'working' | 'waiting' | 'idle' | 'stopped' | 'error'
export type SessionRow = {
  id: string
  owner_id: number
  owner_username: string
  owner_name: string
  profile: string
  title: string
  title_custom: number
  cwd: string
  mode: 'chat' | 'cli'
  status: SessionStatus
  status_detail: string | null
  model: string | null
  effort: string | null
  permission_mode: string
  started: number
  shared: number
  shared_can_send: number
  archived: number
  created_at: number
  last_activity_at: number
  project_id: number | null
  worktree: string | null
  fast_mode: number
  remote_control: number
  context_json: string | null
  instructions: string | null
  tool_policy: string | null
  listed: number
  reach_tailnet: number
  tailnet_mcp: string | null
  tailnet_mcps: string | null
  /** What teammates' requests may use without asking the owner, comma-separated (GUEST_CAPS), when `guest_caps_custom`. */
  guest_caps: string
  /** 1: set in the session's Share dialog; 0: the owner's default for its project (`project_guest_caps`). */
  guest_caps_custom: number
  project_guest_caps: string | null
  origin_kind: 'proposal' | null
  origin_role: string | null
  /** How many members it's shared with by name (claude_session_viewers); 0 unless shared with chosen people. */
  people: number
  project_slug: string | null
  project_name: string | null
}
export type TurnRow = {
  session_id: string; result_uuid: string; after_uuid: string | null; prompt_uuid: string | null; ok: number
  duration_ms: number; cost_usd: number; turn_cost_usd: number | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number
  num_turns: number; model: string | null; created_at: number
}
export type Comment = { id: number; body: string; createdAt: number; user: { id: number; name: string } }
export type Defaults = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

const SELECT = `select s.*, u.username as owner_username, u.name as owner_name, p.slug as project_slug, p.name as project_name,
  (select count(*) from claude_session_viewers v where v.session_id = s.id) as people, pg.caps as project_guest_caps
  from claude_sessions s join users u on u.id = s.owner_id left join projects p on p.id = s.project_id
  left join project_guest_caps pg on pg.user_id = s.owner_id and pg.project_id = s.project_id`
/** The sessions member `who` may open: their own, ones shared with everyone, and ones shared with them by name. */
export const canSeeSql = (who: string) =>
  `(s.owner_id = ${who} or s.shared = 1 or s.id in (select session_id from claude_session_viewers where user_id = ${who}))`

// Columns a PATCH may touch; anything else is ignored.
const PATCHABLE = ['title', 'title_custom', 'shared', 'shared_can_send', 'archived', 'model', 'effort', 'permission_mode', 'mode', 'started', 'fast_mode', 'remote_control', 'context_json', 'instructions', 'tool_policy', 'listed', 'reach_tailnet', 'tailnet_mcp', 'tailnet_mcps', 'guest_caps', 'guest_caps_custom', 'origin_kind', 'origin_role'] as const
export type Patch = Partial<Pick<SessionRow, (typeof PATCHABLE)[number]>>

const toComment = (r: { id: number; body: string; created_at: number; user_id: number; name: string }): Comment => ({ id: r.id, body: r.body, createdAt: r.created_at, user: { id: r.user_id, name: r.name } })

export function claudeRepo(db: Db) {
  const s = {
    byId: db.prepare(`${SELECT} where s.id = ?`),
    visible: db.prepare(`${SELECT} where ${canSeeSql('?1')} and s.archived = ?2 and s.listed = 1 order by s.last_activity_at desc limit 200`),
    // Unlisted ones too (a team role's chat and shifts): a project's page shows everything in it the member may open.
    inProject: db.prepare(`${SELECT} where s.project_id = ?1 and s.archived = ?2 and ${canSeeSql('?3')}
      order by s.last_activity_at desc limit 500`),
    hiddenInProject: db.prepare(`select u.name, count(*) as n from claude_sessions s join users u on u.id = s.owner_id
      where s.project_id = ?1 and s.archived = ?2 and not ${canSeeSql('?3')} group by u.id order by n desc, u.name`),
    ownedActive: db.prepare(`${SELECT} where u.username = ? and s.archived = 0`),
    insert: db.prepare(`insert into claude_sessions (id, owner_id, profile, title, cwd, mode, model, effort, permission_mode)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    status: db.prepare(`update claude_sessions set status = ?, status_detail = ?, mode = ?, last_activity_at = unixepoch() where id = ?`),
    touch: db.prepare(`update claude_sessions set last_activity_at = unixepoch() where id = ?`),
    setProject: db.prepare(`update claude_sessions set project_id = ?, worktree = ? where id = ?`),
    addSender: db.prepare(`insert or ignore into claude_message_senders (session_id, message_uuid, user_id) values (?, ?, ?)`),
    senders: db.prepare(`select m.message_uuid, u.id, u.name from claude_message_senders m join users u on u.id = m.user_id where m.session_id = ?`),
    lastSender: db.prepare(`select u.id, u.name from claude_message_senders m join users u on u.id = m.user_id where m.session_id = ? order by m.rowid desc limit 1`),
    insertTurn: db.prepare(`insert or ignore into claude_turns (session_id, result_uuid, after_uuid, prompt_uuid, ok, duration_ms, cost_usd, turn_cost_usd,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, num_turns, model) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    lastTotal: db.prepare(`select cost_usd from claude_turns where session_id = ? order by id desc limit 1`),
    turns: db.prepare(`select * from claude_turns where session_id = ? order by id`),
    writer: db.prepare(`select full_access from claude_session_writers where session_id = ? and user_id = ?`),
    writers: db.prepare(`select u.id, u.name, w.full_access from claude_session_writers w join users u on u.id = w.user_id where w.session_id = ? order by u.name`),
    addWriter: db.prepare(`insert or ignore into claude_session_writers (session_id, user_id) values (?, ?)`),
    addFullWriter: db.prepare(`insert into claude_session_writers (session_id, user_id, full_access) values (?, ?, 1)
      on conflict (session_id, user_id) do update set full_access = 1`),
    removeWriter: db.prepare(`delete from claude_session_writers where session_id = ? and user_id = ?`),
    clearWriters: db.prepare(`delete from claude_session_writers where session_id = ?`),
    dropFull: db.prepare(`update claude_session_writers set full_access = 0 where session_id = ?`),
    projectCaps: db.prepare(`select caps from project_guest_caps where user_id = ? and project_id = ?`),
    setProjectCaps: db.prepare(`insert into project_guest_caps (user_id, project_id, caps) values (?, ?, ?)
      on conflict (user_id, project_id) do update set caps = excluded.caps`),
    followingProjectCaps: db.prepare(`select id from claude_sessions where owner_id = ? and project_id = ? and guest_caps_custom = 0 and archived = 0`),
    isViewer: db.prepare(`select 1 from claude_session_viewers where session_id = ? and user_id = ?`),
    people: db.prepare(`select u.id, u.name, w.user_id is not null as can_send, coalesce(w.full_access, 0) as full_access
      from claude_session_viewers v join users u on u.id = v.user_id
      left join claude_session_writers w on w.session_id = v.session_id and w.user_id = v.user_id
      where v.session_id = ? order by u.name`),
    addViewer: db.prepare(`insert or ignore into claude_session_viewers (session_id, user_id) values (?, ?)`),
    clearViewers: db.prepare(`delete from claude_session_viewers where session_id = ?`),
    comments: db.prepare(`select c.id, c.body, c.created_at, u.id as user_id, u.name from claude_session_comments c join users u on u.id = c.user_id
      where c.session_id = ? order by c.id`),
    addComment: db.prepare(`insert into claude_session_comments (session_id, user_id, body) values (?, ?, ?)`),
    commentCount: db.prepare(`select count(*) as n from claude_session_comments where session_id = ?`),
    defaults: db.prepare(`select profile, model, effort, permission_mode, open_in from claude_defaults where user_id = ?`),
    saveDefaults: db.prepare(`insert into claude_defaults (user_id, profile, model, effort, permission_mode, open_in) values (?1, ?2, ?3, ?4, ?5, ?6)
      on conflict(user_id) do update set profile = ?2, model = ?3, effort = ?4, permission_mode = ?5, open_in = ?6`),
  }
  return {
    byId: (id: string) => s.byId.get(id) as SessionRow | undefined,
    visible: (userId: number, archived: boolean) => s.visible.all(userId, archived ? 1 : 0) as SessionRow[],
    inProject: (projectId: number, userId: number, archived: boolean) => s.inProject.all(projectId, archived ? 1 : 0, userId) as SessionRow[],
    /** Other people's private sessions in a project: how many, by whom. */
    hiddenInProject: (projectId: number, userId: number, archived: boolean) =>
      (s.hiddenInProject.all(projectId, archived ? 1 : 0, userId) as { name: string; n: number }[]).map(({ name, n }) => ({ name, n })),
    ownedActive: (username: string) => s.ownedActive.all(username) as SessionRow[],
    insert: (r: Pick<SessionRow, 'id' | 'owner_id' | 'profile' | 'title' | 'cwd' | 'mode' | 'model' | 'effort' | 'permission_mode'>) =>
      void s.insert.run(r.id, r.owner_id, r.profile, r.title, r.cwd, r.mode, r.model, r.effort, r.permission_mode),
    setStatus: (id: string, status: SessionStatus, detail: string | null, mode: 'chat' | 'cli') => void s.status.run(status, detail, mode, id),
    touch: (id: string) => void s.touch.run(id),
    setProject: (id: string, projectId: number | null, worktree: string | null) => void s.setProject.run(projectId, worktree, id),
    patch(id: string, p: Patch) {
      const keys = PATCHABLE.filter((k) => p[k] !== undefined)
      if (!keys.length) return
      db.prepare(`update claude_sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`)
        .run(...keys.map((k) => p[k] as string | number | null), id)
    },
    addSender: (sessionId: string, uuid: string, userId: number) => void s.addSender.run(sessionId, uuid, userId),
    senders: (sessionId: string) =>
      Object.fromEntries((s.senders.all(sessionId) as { message_uuid: string; id: number; name: string }[]).map((r) => [r.message_uuid, { id: r.id, name: r.name }])),
    insertTurn: (t: Omit<TurnRow, 'created_at'>) => void s.insertTurn.run(
      t.session_id, t.result_uuid, t.after_uuid, t.prompt_uuid, t.ok, t.duration_ms, t.cost_usd, t.turn_cost_usd,
      t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.num_turns, t.model),
    turns: (sessionId: string) => (s.turns.all(sessionId) as TurnRow[]).map((r) => ({ ...r })),
    /** The session's running total cost as of its last saved answer, or null before the first. */
    lastTotal: (sessionId: string) => (s.lastTotal.get(sessionId) as { cost_usd: number } | undefined)?.cost_usd ?? null,
    /** Whether a member may send messages here, and with what: 'ask' (the owner approves what uses their access) or 'full'. */
    writerAccess: (sessionId: string, userId: number): 'full' | 'ask' | null => {
      const r = s.writer.get(sessionId, userId) as { full_access: number } | undefined
      return r ? (r.full_access === 1 ? 'full' : 'ask') : null
    },
    isWriter: (sessionId: string, userId: number) => !!s.writer.get(sessionId, userId),
    writers: (sessionId: string) =>
      (s.writers.all(sessionId) as { id: number; name: string; full_access: number }[]).map((r) => ({ id: r.id, name: r.name, full: r.full_access === 1 })),
    setWriter: (sessionId: string, userId: number, on: boolean) => void (on ? s.addWriter : s.removeWriter).run(sessionId, userId),
    isViewer: (sessionId: string, userId: number) => !!s.isViewer.get(sessionId, userId),
    /** The members it's shared with by name, whether each may send messages too, and whether with full access. */
    people: (sessionId: string) =>
      (s.people.all(sessionId) as { id: number; name: string; can_send: number; full_access: number }[])
        .map((r) => ({ id: r.id, name: r.name, canSend: r.can_send === 1, full: r.full_access === 1 })),
    /** Replaces who it's shared with by name (none: the owner only, or everyone while `shared` is on). Run in a transaction. */
    setPeople(sessionId: string, people: { id: number; canSend: boolean; full?: boolean }[]) {
      s.clearViewers.run(sessionId)
      s.clearWriters.run(sessionId)
      for (const p of people) {
        s.addViewer.run(sessionId, p.id)
        if (p.full) s.addFullWriter.run(sessionId, p.id)
        else if (p.canSend) s.addWriter.run(sessionId, p.id)
      }
    },
    /** A member's default, per project, for what teammates' requests may use of theirs in their sessions there. */
    projectCaps: (userId: number, projectId: number) => (s.projectCaps.get(userId, projectId) as { caps: string } | undefined)?.caps ?? '',
    setProjectCaps: (userId: number, projectId: number, caps: string) => void s.setProjectCaps.run(userId, projectId, caps),
    /** Their sessions in the project that follow that default (not set in their own Share dialog). */
    followingProjectCaps: (userId: number, projectId: number) => (s.followingProjectCaps.all(userId, projectId) as { id: string }[]).map((r) => r.id),
    /** Who sent the newest message: a server restart resumes the session on their behalf, not on the owner's. */
    lastSender: (sessionId: string) => (s.lastSender.get(sessionId) as { id: number; name: string } | undefined) ?? null,
    /**
     * Stops sharing by name. Full access goes with it: it's given to named people only, and the owner must see who has it.
     * Those let in to send keep sending, but as guests.
     */
    clearPeople(sessionId: string) {
      s.clearViewers.run(sessionId)
      s.dropFull.run(sessionId)
    },
    comments: (sessionId: string) => (s.comments.all(sessionId) as Parameters<typeof toComment>[0][]).map(toComment),
    addComment(sessionId: string, userId: number, body: string) {
      const id = Number(s.addComment.run(sessionId, userId, body).lastInsertRowid)
      return this.comments(sessionId).find((c) => c.id === id)!
    },
    commentCount: (sessionId: string) => (s.commentCount.get(sessionId) as { n: number }).n,
    defaults: (userId: number): Defaults =>
      (s.defaults.get(userId) as Defaults | undefined) ?? { profile: 'default', model: null, effort: null, permission_mode: 'bypassPermissions', open_in: 'chat' },
    saveDefaults: (userId: number, d: Defaults) => void s.saveDefaults.run(userId, d.profile, d.model, d.effort, d.permission_mode, d.open_in),
  }
}
