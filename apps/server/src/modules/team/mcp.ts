import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import { CLOSE_AS, KINDS, MESSAGE_KINDS, type CloseAs, type MessageInput, type ProposalInput, type TeamService } from './service.ts'
import { SOURCE_KINDS, type SourceConfig, type SourceKind } from './sources.ts'

type Ctx = { sessionId?: string | null; args?: Record<string, unknown> }

/**
 * The team tools in the DevDash Claude plugin (packages/claude-plugin/mcp/team.mjs). They work only in a role's own
 * sessions (its chat and its shifts), run as the member the team runs as.
 */
export function registerTeamMcp(agents: AgentsService, team: TeamService) {
  const role = (username: string, params: unknown) => {
    const c = (params ?? {}) as Ctx
    const found = team.roleOf(username, c.sessionId ?? null)
    if (!found) throw new AppError(403, 'not_a_role', 'These tools work only in a team role\'s own sessions.')
    return { ...found, args: c.args ?? {} }
  }
  const text = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new AppError(400, 'bad_args', `Give the ${what}.`)
    return v
  }

  // Asked when the plugin's tool server starts: role sessions get the team tools, other sessions in a project with Team
  // on get team_message (to raise something with a role), the rest see nothing.
  agents.onRpc('mcp.team_role', (username, params) => {
    const sessionId = ((params ?? {}) as Ctx).sessionId ?? null
    const found = team.roleOf(username, sessionId)
    if (found) return { role: found.r.name, project: found.p.slug }
    return team.sessionAuthor(username, sessionId) ? { session: true } : null
  })
  const messageInput = (a: Record<string, unknown>): MessageInput => {
    const kind = String(a.kind ?? (a.thread ? 'reply' : 'fyi'))
    if (!(MESSAGE_KINDS as readonly string[]).includes(kind)) throw new AppError(400, 'bad_args', `kind is one of: ${MESSAGE_KINDS.join(', ')}.`)
    return {
      kind: kind as MessageInput['kind'], body: text(a.body, 'message'),
      thread: Number.isInteger(a.thread) ? (a.thread as number) : undefined,
      to: typeof a.to === 'string' ? a.to : undefined, title: typeof a.title === 'string' ? a.title : undefined,
      cc: Array.isArray(a.cc) ? a.cc.filter((x): x is string => typeof x === 'string').slice(0, 6) : undefined,
      evidence: typeof a.evidence === 'string' ? a.evidence : undefined,
      ask: typeof a.ask === 'string' ? a.ask : undefined,
    }
  }
  const sent = (r: { thread: number; note: string }) => `Posted in thread #${r.thread}.${r.note}`
  agents.onRpc('mcp.team_message', (username, params) => {
    const c = (params ?? {}) as Ctx
    const input = messageInput(c.args ?? {})
    const found = team.roleOf(username, c.sessionId ?? null)
    return sent(found ? team.roleMessage(found.r.id, c.sessionId!, input) : team.sessionMessage(username, c.sessionId ?? '', input))
  })
  // Managing roles and data sources: a person's own sessions only. A role is a member of the team, not its manager.
  const personSession = (username: string, params: unknown) => {
    const c = (params ?? {}) as Ctx
    if (team.roleOf(username, c.sessionId ?? null)) throw new AppError(403, 'role', 'Roles can\'t change the team\'s setup (roles, data sources). Suggest it to people in your report.')
    return { sessionId: c.sessionId ?? '', args: c.args ?? {} }
  }
  agents.onRpc('mcp.team_roles', (username, params) => team.sessionRoles(username, personSession(username, params).sessionId))
  agents.onRpc('mcp.team_role_create', (username, params) => {
    const c = personSession(username, params)
    return team.sessionCreateRole(username, c.sessionId, {
      name: text(c.args.name, 'role name'), summary: typeof c.args.summary === 'string' ? c.args.summary : '',
      instructions: typeof c.args.instructions === 'string' ? c.args.instructions : undefined,
      model: typeof c.args.model === 'string' ? c.args.model : null, schedule: Array.isArray(c.args.schedule) ? c.args.schedule : undefined,
    })
  })
  agents.onRpc('mcp.team_role_update', (username, params) => {
    const c = personSession(username, params)
    const a = c.args
    if (a.role === undefined) throw new AppError(400, 'bad_args', 'Give the role (its name or #id).')
    return team.sessionUpdateRole(username, c.sessionId, {
      role: typeof a.role === 'number' ? a.role : String(a.role).replace(/^#/, ''),
      name: typeof a.name === 'string' ? a.name : undefined, summary: typeof a.summary === 'string' ? a.summary : undefined,
      instructions: typeof a.instructions === 'string' ? a.instructions : undefined,
      model: a.model === null ? null : typeof a.model === 'string' ? a.model : undefined,
      schedule: Array.isArray(a.schedule) ? a.schedule : undefined,
      triggers: Array.isArray(a.triggers) ? a.triggers.filter((x): x is string => typeof x === 'string') : undefined,
      autonomy: typeof a.autonomy === 'string' ? a.autonomy : undefined,
      paused: typeof a.paused === 'boolean' ? a.paused : undefined, lead: typeof a.lead === 'boolean' ? a.lead : undefined,
      project: typeof a.project === 'string' ? a.project : undefined,
      dailyLimit: Number.isInteger(a.daily_limit) ? (a.daily_limit as number) : undefined,
      monthlyBudget: a.monthly_budget === null ? null : typeof a.monthly_budget === 'number' ? a.monthly_budget : undefined,
      autoApprove: Array.isArray(a.auto_approve) ? a.auto_approve.filter((x): x is string => typeof x === 'string') : undefined,
      selfClose: a.self_close === 'default' || a.self_close === 'always_ask' || a.self_close === 'allow' ? a.self_close : undefined,
    })
  })
  // Data sources: a person's own sessions too ("connect our database for the team"). Keys are best pasted on the Team tab.
  const sourceRef = (a: Record<string, unknown>) => {
    if (typeof a.source === 'number' || (typeof a.source === 'string' && a.source.trim())) return a.source as string | number
    throw new AppError(400, 'bad_args', 'Give the source (its name or #id, see team_source_list).')
  }
  const opt = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const sourceConfig = (a: Record<string, unknown>): SourceConfig => ({
    path: opt(a.path), baseUrl: opt(a.base_url), url: opt(a.url), secretName: opt(a.key_name),
    secretIn: a.key_in === 'query' || a.key_in === 'header' ? a.key_in : undefined,
  })
  agents.onRpc('mcp.team_source_list', (username, params) => team.sessionSources(username, personSession(username, params).sessionId))
  agents.onRpc('mcp.team_source_add', (username, params) => {
    const c = personSession(username, params)
    const a = c.args
    if (!(SOURCE_KINDS as readonly string[]).includes(String(a.kind))) throw new AppError(400, 'bad_args', `kind is one of: ${SOURCE_KINDS.join(', ')}.`)
    return team.sessionAddSource(username, c.sessionId, {
      name: text(a.name, 'source name').trim().slice(0, 60), kind: a.kind as SourceKind, description: (opt(a.description) ?? '').slice(0, 500),
      config: sourceConfig(a), secret: opt(a.key) ?? null,
    })
  })
  agents.onRpc('mcp.team_source_update', (username, params) => {
    const c = personSession(username, params)
    const a = c.args
    return team.sessionUpdateSource(username, c.sessionId, sourceRef(a), {
      name: opt(a.name)?.slice(0, 60), description: opt(a.description)?.slice(0, 500), config: sourceConfig(a), secret: opt(a.key) || undefined,
    })
  })
  agents.onRpc('mcp.team_source_remove', (username, params) => {
    const c = personSession(username, params)
    return team.sessionRemoveSource(username, c.sessionId, sourceRef(c.args))
  })
  agents.onRpc('mcp.team_source_test', (username, params) => {
    const c = personSession(username, params)
    return team.sessionTestSource(username, c.sessionId, sourceRef(c.args))
  })
  // Full team management from a member's own session (same authority as the Team tab). `project` picks the project;
  // without it, the session's own. The service rejects a role's session and a project without Team on.
  const member = (params: unknown) => {
    const c = (params ?? {}) as Ctx
    return { sessionId: c.sessionId ?? '', args: c.args ?? {} }
  }
  const slugOf = (a: Record<string, unknown>) => (typeof a.project === 'string' && a.project.trim() ? a.project : undefined)
  const threadId = (a: Record<string, unknown>) => {
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the thread id.')
    return a.id as number
  }
  agents.onRpc('mcp.team_overview', (username, params) => {
    const c = member(params)
    return team.sessionOverview(username, c.sessionId, slugOf(c.args))
  })
  agents.onRpc('mcp.team_approvals', (username, params) => {
    const c = member(params)
    return team.sessionApprovals(username, c.sessionId, slugOf(c.args), c.args.status === 'decided' ? 'decided' : 'pending')
  })
  agents.onRpc('mcp.team_approval_decide', (username, params) => {
    const c = member(params)
    const a = c.args
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the proposal id (see team_approvals).')
    if (typeof a.approve !== 'boolean') throw new AppError(400, 'bad_args', 'Set approve: true to approve, false to reject.')
    return team.sessionDecide(username, c.sessionId, a.id as number, a.approve, typeof a.reply === 'string' ? a.reply : '')
  })
  agents.onRpc('mcp.team_threads', (username, params) => {
    const c = member(params)
    const s = String(c.args.status ?? 'all')
    const status = (['open', 'waiting', 'closed', 'all'] as const).includes(s as 'all') ? (s as 'open' | 'waiting' | 'closed' | 'all') : 'all'
    return team.sessionThreads(username, c.sessionId, slugOf(c.args), status)
  })
  agents.onRpc('mcp.team_thread_resolve', (username, params) => {
    const c = member(params)
    const a = c.args
    const as = String(a.as ?? 'done')
    if (!(CLOSE_AS as readonly string[]).includes(as)) throw new AppError(400, 'bad_args', `as is one of: ${CLOSE_AS.join(', ')}.`)
    return team.sessionResolveThread(username, c.sessionId, threadId(a), typeof a.resolution === 'string' ? a.resolution : '', as as CloseAs,
      Number.isInteger(a.duplicate_of) ? (a.duplicate_of as number) : undefined)
  })
  agents.onRpc('mcp.team_thread_reopen', (username, params) => {
    const c = member(params)
    return team.sessionReopenThread(username, c.sessionId, threadId(c.args))
  })
  agents.onRpc('mcp.team_thread_priority', (username, params) => {
    const c = member(params)
    const p = String(c.args.priority)
    if (p !== 'normal' && p !== 'blocker') throw new AppError(400, 'bad_args', 'priority is "normal" or "blocker".')
    return team.sessionThreadPriority(username, c.sessionId, threadId(c.args), p)
  })
  agents.onRpc('mcp.team_set_priorities', (username, params) => {
    const c = member(params)
    return team.sessionSetPriorities(username, c.sessionId, slugOf(c.args), text(c.args.body, 'priorities'))
  })
  agents.onRpc('mcp.team_set_brief', (username, params) => {
    const c = member(params)
    return team.sessionSetBrief(username, c.sessionId, slugOf(c.args), text(c.args.body, 'brief'))
  })
  agents.onRpc('mcp.team_role_archive', (username, params) => {
    const c = member(params)
    const a = c.args
    if (a.role === undefined) throw new AppError(400, 'bad_args', 'Give the role (its name or #id).')
    return team.sessionArchiveRole(username, c.sessionId, slugOf(a), typeof a.role === 'number' ? a.role : String(a.role).replace(/^#/, ''))
  })
  agents.onRpc('mcp.team_run_role', (username, params) => {
    const c = member(params)
    const a = c.args
    if (a.role === undefined) throw new AppError(400, 'bad_args', 'Give the role (its name or #id).')
    return team.sessionRunShift(username, c.sessionId, slugOf(a), typeof a.role === 'number' ? a.role : String(a.role).replace(/^#/, ''))
  })
  agents.onRpc('mcp.team_goal_add', (username, params) => {
    const c = member(params)
    const a = c.args
    return team.sessionGoalAdd(username, c.sessionId, slugOf(a), {
      title: text(a.title, 'goal title'), measure: typeof a.measure === 'string' ? a.measure : '',
      due: typeof a.due === 'string' ? a.due : null,
    })
  })
  // The member's full goal edit (title, measure, due, status, progress, note); the role-only team_goal_update stays separate.
  agents.onRpc('mcp.team_goal_edit', (username, params) => {
    const c = member(params)
    const a = c.args
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the goal id (see team_overview).')
    const status = typeof a.status === 'string' ? a.status : undefined
    if (status !== undefined && !['active', 'done', 'dropped'].includes(status)) throw new AppError(400, 'bad_args', 'status is one of: active, done, dropped.')
    return team.sessionGoalEdit(username, c.sessionId, {
      id: a.id as number, title: typeof a.title === 'string' ? a.title : undefined,
      measure: typeof a.measure === 'string' ? a.measure : undefined,
      due: typeof a.due === 'string' ? a.due : a.due === null ? null : undefined,
      status: status as 'active' | 'done' | 'dropped' | undefined,
      progress: typeof a.progress === 'number' ? a.progress : undefined,
      note: typeof a.note === 'string' ? a.note : undefined,
    })
  })
  // team_thread serves both a role's own session (its scoped read) and a member's session (the full web read).
  agents.onRpc('mcp.team_thread', (username, params) => {
    const c = (params ?? {}) as Ctx
    const a = c.args ?? {}
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the thread id.')
    const found = team.roleOf(username, c.sessionId ?? null)
    return found ? team.roleThread(found.r.id, a.id as number) : team.sessionThread(username, c.sessionId ?? '', a.id as number)
  })
  // One job per object: link a task to a thread (or unlink it). A role may link within a thread it's on; a member anywhere.
  agents.onRpc('mcp.team_thread_link_task', (username, params) => {
    const c = (params ?? {}) as Ctx
    const a = c.args ?? {}
    if (!Number.isInteger(a.thread)) throw new AppError(400, 'bad_args', 'Give the thread id.')
    if (!Number.isInteger(a.task)) throw new AppError(400, 'bad_args', 'Give the task number (e.g. 10 for shop#10).')
    const unlink = a.unlink === true
    const found = team.roleOf(username, c.sessionId ?? null)
    if (found) {
      const key = team.roleLinkTask(found.r.id, a.thread as number, a.task as number, unlink)
      return unlink ? `Unlinked ${key} from thread #${a.thread}.` : `Linked ${key} to thread #${a.thread}. It shows on both now.`
    }
    return team.sessionLinkTask(username, c.sessionId ?? '', a.thread as number, a.task as number, unlink)
  })
  agents.onRpc('mcp.team_resolve', (username, params) => {
    const c = role(username, params)
    if (!Number.isInteger(c.args.id)) throw new AppError(400, 'bad_args', 'Give the thread id.')
    // No `as`: done, as before (only the owner may). Any other role in the thread may decline it, with the reason.
    const as = String(c.args.as ?? 'done')
    if (!(CLOSE_AS as readonly string[]).includes(as)) throw new AppError(400, 'bad_args', `as is one of: ${CLOSE_AS.join(', ')}.`)
    team.roleResolve(c.r.id, c.args.id as number, typeof c.args.resolution === 'string' ? c.args.resolution : '', as as CloseAs,
      Number.isInteger(c.args.duplicate_of) ? (c.args.duplicate_of as number) : undefined)
    return as === 'done' ? `Thread #${c.args.id} resolved.` : `Thread #${c.args.id} closed (${as.replace('_', ' ')}). People see why and can reopen it.`
  })
  agents.onRpc('mcp.team_close', (username, params) => {
    const c = role(username, params)
    const a = c.args
    const task = Number.isInteger(a.task) ? (a.task as number) : undefined
    const thread = Number.isInteger(a.thread) ? (a.thread as number) : undefined
    if (task === undefined && thread === undefined) throw new AppError(400, 'bad_args', 'Give task (its number) or thread (its id) to close.')
    if (typeof a.confidence !== 'number') throw new AppError(400, 'bad_args', 'Give confidence, 1-10: how sure you are it should close.')
    return team.roleClose(c.r.id, { task, thread }, a.confidence, text(a.evidence, 'evidence'))
  })
  agents.onRpc('mcp.team_sources', (username, params) => team.roleSources(role(username, params).r.id))
  agents.onRpc('mcp.team_query', (username, params) => {
    const c = role(username, params)
    return team.roleRead(c.r.id, text(c.args.source, 'source name'), { sql: text(c.args.sql, 'SQL') })
  })
  agents.onRpc('mcp.team_fetch', (username, params) => {
    const c = role(username, params)
    return team.roleRead(c.r.id, text(c.args.source, 'source name'), { path: typeof c.args.path === 'string' ? c.args.path : '' })
  })
  agents.onRpc('mcp.team_context', (username, params) => team.context(role(username, params).r.id))
  agents.onRpc('mcp.team_note', (username, params) => {
    const c = role(username, params)
    team.roleNote(c.r.id, text(c.args.body, 'note'))
    return 'Saved to your notebook.'
  })
  agents.onRpc('mcp.team_decision', (username, params) => {
    const c = role(username, params)
    team.roleDecision(c.r.id, text(c.args.body, 'decision'))
    return 'Decision recorded for the whole team.'
  })
  agents.onRpc('mcp.team_propose', async (username, params) => {
    const c = role(username, params)
    const a = c.args
    const kind = String(a.kind)
    if (!(KINDS as readonly string[]).includes(kind)) throw new AppError(400, 'bad_args', `kind is one of: ${KINDS.join(', ')}.`)
    if (kind === 'code' && (typeof a.prompt !== 'string' || a.prompt.trim().length < 20)) throw new AppError(400, 'bad_args', 'A code proposal needs a complete prompt for the Claude session that will do it.')
    if (kind === 'goal' && !(a.goal && typeof (a.goal as { title?: unknown }).title === 'string')) throw new AppError(400, 'bad_args', 'A goal proposal needs goal.title (and ideally measure and due).')
    const r = await team.propose(c.r.id, {
      kind: kind as ProposalInput['kind'], title: text(a.title, 'title'), why: typeof a.why === 'string' ? a.why : '',
      tasks: Array.isArray(a.tasks) ? (a.tasks as ProposalInput['tasks'])!.filter((t) => typeof t?.title === 'string') : undefined,
      prompt: typeof a.prompt === 'string' ? a.prompt : undefined,
      goal: a.goal as ProposalInput['goal'], details: typeof a.details === 'string' ? a.details : undefined,
    }, ((params ?? {}) as Ctx).sessionId ?? undefined)
    return r.status === 'done' ? `Done (you may do this on your own): ${r.outcome}` : 'Sent to the team for approval. You will find their answer in your notebook.'
  })
  agents.onRpc('mcp.team_decide', async (username, params) => {
    const c = role(username, params)
    const a = c.args
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the proposal id (the number after # in team_context).')
    const action = String(a.action)
    if (!['approve', 'reject', 'escalate'].includes(action)) throw new AppError(400, 'bad_args', 'action is one of: approve, reject, escalate.')
    return team.leadDecide(c.r.id, a.id as number, action as 'approve' | 'reject' | 'escalate', typeof a.reason === 'string' ? a.reason : '')
  })
  agents.onRpc('mcp.team_goal_update', (username, params) => {
    const c = role(username, params)
    const a = c.args
    if (!Number.isInteger(a.id)) throw new AppError(400, 'bad_args', 'Give the goal id (the number after # in team_context).')
    team.roleGoalUpdate(c.r.id, {
      id: a.id as number, progress: typeof a.progress === 'number' ? a.progress : undefined,
      note: typeof a.note === 'string' ? a.note : undefined, done: a.done === true,
    })
    return 'Goal updated.'
  })
  agents.onRpc('mcp.team_shift_report', (username, params) => {
    const c = role(username, params)
    const sessionId = ((params ?? {}) as Ctx).sessionId!
    return team.shiftReport(sessionId, text(c.args.report, 'report'))
      ? 'Report saved. Your shift ends when you stop.'
      : 'This is a chat, not a shift: nothing to report. Answer the person directly.'
  })
}
