import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { HARNESSES, PERMISSION_MODES, type ClaudeService, type Harness } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { AGENT_NAME, PAGE_TAG } from './prompt.ts'
import type { AssistantService } from './service.ts'

type Ctx = { sessionId?: string | null; args?: Record<string, unknown> }
type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
type Msg = { type?: string; message?: { content?: string | Block[] } }

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
const PAGE = new RegExp(`^<${PAGE_TAG}\\b[^>]*/>\\s*`)
// DevDash's notes for the agent inside a message (a teammate's note, autopilot's rules): not what anyone said.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/**
 * A session's conversation as the personal agent reads it: who said what, and which tools the session's agent used,
 * without tool outputs, thinking or images. The last `max` entries. Pure, tested.
 */
export function condense(messages: Msg[], max = 40) {
  const out: { from: 'person' | 'agent'; text?: string; tools?: string[] }[] = []
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue
    const content = m.message?.content
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const text = blocks.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.replace(REMINDER, '').replace(PAGE, '').trim()).filter(Boolean).join('\n\n')
    const tools = blocks.filter((b) => b.type === 'tool_use' && b.name).map((b) => {
      const i = b.input ?? {}
      const what = [i.command, i.file_path, i.description, i.pattern, i.url].find((v) => typeof v === 'string') as string | undefined
      return what ? `${b.name}: ${clip(what, 120)}` : b.name!
    })
    if (!text && !tools.length) continue
    out.push({ from: m.type === 'user' ? 'person' : 'agent', ...(text ? { text: clip(text, 2000) } : {}), ...(tools.length ? { tools } : {}) })
  }
  return out.slice(-max)
}

/**
 * The tools only a member's personal agent gets (packages/claude-plugin/mcp/assistant.mjs), on top of the DevDash tools
 * every session has. They act as that member, with exactly their access: the session's owner is who they act for.
 */
export function registerAssistantMcp({ agents, claude, assistant, notify }: {
  agents: AgentsService; claude: ClaudeService; assistant: AssistantService
  notify: (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>
}) {
  const ctx = (username: string, params: unknown) => {
    const c = (params ?? {}) as Ctx
    const user = assistant.ofSession(username, c.sessionId ?? null)
    if (!user) throw new AppError(403, 'not_assistant', 'These tools work only in your personal agent.')
    return { user, sessionId: c.sessionId!, args: c.args ?? {} }
  }
  const on = (name: string, fn: (c: { user: User; sessionId: string; args: Record<string, unknown> }) => unknown) =>
    agents.onRpc(`mcp.${name}`, (username, params) => fn(ctx(username, params)))
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const need = (v: unknown, what: string) => str(v) ?? (() => { throw new AppError(400, 'bad_args', `Give ${what}.`) })()
  const int = (v: unknown, what: string) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'bad_args', `${what} must be a positive whole number.`)
    return n
  }
  const brief = (s: ReturnType<ClaudeService['list']>[number]) => ({
    id: s.id, title: s.title, status: s.status, agent: s.harness, project: s.project?.slug ?? null, folder: s.cwd,
    owner: s.owner.username, lastActivity: new Date(s.lastActivityAt * 1000).toISOString(), url: `/sessions/${s.id}`,
  })

  // Asked when the tool server starts: only a personal agent's own sessions list these tools.
  agents.onRpc('mcp.assistant_here', (username, params) => {
    const user = assistant.ofSession(username, ((params ?? {}) as Ctx).sessionId ?? null)
    return user ? { name: user.name } : null
  })

  on('sessions_list', (c) => {
    const all = claude.list(c.user, !!c.args.archived).filter((s) => s.id !== c.sessionId)
    const project = str(c.args.project)
    return all.filter((s) => !project || s.project?.slug === project).filter((s) => !c.args.mine || s.owner.id === c.user.id).slice(0, 60).map(brief)
  })
  on('session_read', async (c) => {
    const id = need(c.args.id, 'the session id')
    const [info, page] = await Promise.all([claude.get(c.user, id), claude.history(c.user, id)])
    const s = info.session
    return {
      ...brief(s as Parameters<typeof brief>[0]),
      // What it's blocked on: only its owner (or someone they let in) can answer, in the session itself.
      waitingFor: (info.pending as { toolName?: string; input?: { command?: string; questions?: { question?: string }[] } }[]).map((p) =>
        p.toolName === 'AskUserQuestion' ? `a question: ${p.input?.questions?.[0]?.question ?? ''}` : `permission for ${p.toolName}${p.input?.command ? `: ${clip(p.input.command, 120)}` : ''}`),
      messages: condense(page.messages as Msg[], Math.min(80, Math.max(1, Number(c.args.last) || 30))),
    }
  })
  on('session_create', async (c) => {
    const prompt = need(c.args.prompt, 'the prompt: the whole job, as you would brief a colleague')
    const d = claude.defaults(c.user)
    const harness = (str(c.args.agent) ?? d.harness) as Harness
    if (!(HARNESSES as readonly string[]).includes(harness)) throw new AppError(400, 'bad_args', `agent is one of: ${HARNESSES.join(', ')}.`)
    const same = harness === d.harness
    const mode = str(c.args.permission_mode) ?? d.permission_mode
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) throw new AppError(400, 'bad_args', `permission_mode is one of: ${PERMISSION_MODES.join(', ')}.`)
    const project = str(c.args.project)
    const s = await claude.create(c.user, {
      prompt, images: [], cwd: str(c.args.folder) ?? '~', harness, profile: str(c.args.profile) ?? (same ? d.profile : 'default'),
      model: str(c.args.model) ?? (same ? d.model : null), effort: same ? d.effort : null, permissionMode: mode, mode: 'chat',
      project, worktree: project ? c.args.worktree !== false : undefined,
    })
    return { id: s.id, title: s.title, project: s.project?.slug ?? null, folder: s.cwd, url: `/sessions/${s.id}` }
  })
  on('session_send', async (c) => {
    const id = need(c.args.id, 'the session id')
    if (assistant.ofSession(c.user.username, id)) throw new AppError(400, 'bad_args', 'That is one of your own conversations; answer here instead.')
    const first = c.user.name.split(' ')[0]
    await claude.send(c.user, id, `(From ${AGENT_NAME}, ${first}'s personal agent) ${need(c.args.text, 'the message')}`, [])
    return `Sent. Check on it with session_read; it's at /sessions/${id}.`
  })
  on('session_stop', async (c) => {
    await claude.interrupt(c.user, need(c.args.id, 'the session id'))
    return 'Stopped its current turn.'
  })

  on('schedules_list', (c) => assistant.schedules(c.user))
  on('schedule_create', (c) => assistant.createSchedule(c.user, c.args))
  on('schedule_update', (c) => assistant.updateSchedule(c.user, int(c.args.id, 'id'), c.args))
  on('schedule_delete', (c) => (assistant.deleteSchedule(c.user, int(c.args.id, 'id')), 'Deleted.'))

  on('open_page', (c) => {
    const path = need(c.args.path, 'the path, like /tasks/shop/12')
    if (!/^\/(?!\/)[^\s<>"]*$/.test(path)) throw new AppError(400, 'bad_args', 'A DevDash path starts with one slash, like /tasks or /sessions/<id>.')
    assistant.open(c.user.id, path)
    return `Opened ${path} wherever ${c.user.name.split(' ')[0]} has DevDash open.`
  })
  on('notify_me', async (c) => {
    const title = clip(need(c.args.title, 'a title'), 120)
    const url = str(c.args.url)
    await notify(c.user.id, 'needs_you', {
      title, body: str(c.args.body) && clip(str(c.args.body)!, 300), url: url?.startsWith('/') && !url.startsWith('//') ? url : `/sessions/${c.sessionId}`,
      tag: `assistant:${c.user.id}:${title}`,
    })
    return 'Notified.'
  })
}
