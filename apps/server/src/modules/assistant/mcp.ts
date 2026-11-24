import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { ADVISORS, HARNESSES, PERMISSION_MODES, type ClaudeService, type Harness } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import { Create as ProjectCreate } from '../projects/routes.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { BuiltInSkill, Review, SkillSummary } from '../skills/routes.ts'
import { AGENT_NAME, PAGE_TAG, VOICE_TAG } from './prompt.ts'
import type { FollowService } from './follow.ts'
import type { AssistantService } from './service.ts'

type Ctx = { sessionId?: string | null; args?: Record<string, unknown> }
type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
type Msg = { type?: string; message?: { content?: string | Block[] } }

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
const PAGE = new RegExp(`^<${PAGE_TAG}\\b[^>]*/>\\s*(<${VOICE_TAG}\\b[^>]*/>\\s*)?`)
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
export function registerAssistantMcp({ agents, claude, assistant, projects, notify, follow }: {
  agents: AgentsService; claude: ClaudeService; assistant: AssistantService; projects: ProjectsService; follow?: FollowService
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
      model: str(c.args.model) ?? (same ? d.model : null), effort: str(c.args.effort) ?? (same ? d.effort : null), permissionMode: mode, mode: 'chat',
      project, worktree: project ? c.args.worktree !== false : undefined,
    })
    // Followed from its first message: its whole run reports back here.
    const goal = str(c.args.follow)
    const following = goal && follow && claude.typedByOwner(c.sessionId) ? (() => { try { return follow.follow(c.user, s.id, goal) } catch (err) { return (err as Error).message } })() : undefined
    return { id: s.id, title: s.title, project: s.project?.slug ?? null, folder: s.cwd, url: `/sessions/${s.id}`, ...(following ? { following } : {}) }
  })
  on('session_send', async (c) => {
    const id = need(c.args.id, 'the session id')
    if (assistant.ofSession(c.user.username, id)) throw new AppError(400, 'bad_args', 'That is one of your own conversations; answer here instead.')
    const first = c.user.name.split(' ')[0]
    if (follow?.wakeTurnFor(c.user, c.sessionId, id)) throw new AppError(400, 'use_follow_reply', `${first} didn't write this turn: continue a followed session with follow_reply (tier and why), or tell them.`)
    const text = need(c.args.text, 'the message').trim()
    // A slash command goes as it is: Claude Code only runs it when it starts the message, and DevDash runs /model and
    // /effort itself (claude.command).
    if (text.startsWith('/')) {
      const done = await claude.command(c.user, id, text)
      if (done) return done
      await claude.send(c.user, id, text, [])
      return `Sent the command ${text.split(/\s/)[0]}. Check on it with session_read; it's at /sessions/${id}.`
    }
    const uuid = await claude.send(c.user, id, `(From ${AGENT_NAME}, ${first}'s personal agent) ${text}`, [])
    follow?.sent(c.user, id, uuid)
    return `Sent. Check on it with session_read; it's at /sessions/${id}.`
  })
  // A session's model, effort, permission level and advisor, as its menus set them (claude.update: who may, applied live).
  on('session_settings', async (c) => {
    const id = need(c.args.id, 'the session id')
    const a = c.args
    const mode = str(a.permission_mode)
    if (mode !== undefined) {
      if (!(PERMISSION_MODES as readonly string[]).includes(mode)) throw new AppError(400, 'bad_args', `permission_mode is one of: ${PERMISSION_MODES.join(', ')}.`)
      // A security setting: only on their word, in a message they write to you now; never from a schedule or autopilot.
      if (!claude.typedByOwner(c.sessionId)) {
        const first = c.user.name.split(' ')[0]
        throw new AppError(403, 'not_asked', `Only ${first} can change a session's permission level, by asking you in a message they write here. This turn didn't come from that, so it's unchanged.`)
      }
    }
    const advisor = str(a.advisor)
    if (advisor !== undefined && advisor !== 'off' && !(ADVISORS as readonly string[]).includes(advisor)) throw new AppError(400, 'bad_args', `advisor is "off" or one of: ${ADVISORS.join(', ')}.`)
    const patch = {
      model: a.model === null ? null : str(a.model), effort: a.effort === null ? null : str(a.effort), permissionMode: mode,
      advisorModel: advisor === undefined ? undefined : advisor === 'off' ? null : advisor,
    }
    if (Object.values(patch).every((v) => v === undefined)) throw new AppError(400, 'bad_args', 'Say what to change: model, effort, permission_mode or advisor.')
    const s = await claude.update(c.user, id, patch)
    return {
      session: s.title, url: `/sessions/${s.id}`, model: s.model ?? 'default', effort: s.effort ?? 'default', permission_mode: s.permissionMode,
      advisor: s.advisorModel ?? 'off', note: s.mode === 'chat' ? 'Applied now; a turn already running finishes as it was.' : 'Applies when its terminal app next starts.',
    }
  })
  on('session_stop', async (c) => {
    await claude.interrupt(c.user, need(c.args.id, 'the session id'))
    return 'Stopped its current turn.'
  })

  // A new project, made exactly like the Projects page makes one (projects.create: the git repo in /srv/devdash/projects,
  // the person as its creator). Starting a project is theirs to decide: it only runs while the agent answers a message
  // they typed themself, never a schedule, autopilot, another agent or a teammate.
  on('project_create', async (c) => {
    const first = c.user.name.split(' ')[0]
    if (!claude.typedByOwner(c.sessionId)) {
      throw new AppError(403, 'not_asked', `Only ${first} can start a project, by asking for it in a message they write to you here. This turn didn't come from that (a schedule, autopilot or another agent), so it wasn't created; ask ${first} to confirm.`)
    }
    const input = ProjectCreate.safeParse({
      name: str(c.args.name) ?? '', slug: str(c.args.slug), repoUrl: str(c.args.repo_url), instructions: str(c.args.instructions),
    })
    if (!input.success) throw new AppError(400, 'bad_args', `Check the arguments: ${input.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}.`)
    const p = await projects.create(c.user, input.data)
    return {
      slug: p.slug, name: p.name, folder: p.path, repoUrl: p.repoUrl, defaultBranch: p.defaultBranch, url: `/projects/${p.slug}`,
      next: `Start work there with session_create and project "${p.slug}".`,
    }
  })

  on('schedules_list', (c) => assistant.schedules(c.user))
  on('schedule_create', (c) => assistant.createSchedule(c.user, c.args))
  on('schedule_update', (c) => assistant.updateSchedule(c.user, int(c.args.id, 'id'), c.args))
  on('schedule_delete', (c) => (assistant.deleteSchedule(c.user, int(c.args.id, 'id')), 'Deleted.'))

  // Skills (apps/agent/src/skills.ts), as the person: theirs, a project's, and plugins'. Installing stays theirs:
  // skill_find only fetches one for review and opens that page, where they read every file and press Install.
  const ask = <T>(c: { user: User }, msg: object, ms = 60_000) => agents.request<T>(c.user.username, msg, ms)
  const checkout = (c: { user: User }, slug: string) => {
    const p = projects.get(slug, c.user.id)
    if (p.archived) throw new AppError(409, 'archived', `${slug} is archived.`)
    return p.path
  }
  on('skills_list', async (c) => {
    const slug = str(c.args.project)
    if (slug) {
      const r = await ask<{ skills: SkillSummary[] }>(c, { op: 'skills.list', project: checkout(c, slug) })
      return { project: slug, skills: r.skills.map((x) => ({ name: x.name, description: x.description })), note: 'Committed in the project: every session there gets them, for the whole team.' }
    }
    const r = await ask<{ skills: SkillSummary[]; builtIn: BuiltInSkill[] }>(c, { op: 'skills.list' })
    const plugins = new Map<string, { id: string; skills: number; on: boolean; only_in: string[] | null; claude_keeps_it_to: string | null }>()
    for (const b of r.builtIn) {
      if (!b.plugin) continue
      const p = plugins.get(b.plugin) ?? { id: b.plugin, skills: 0, on: b.enabled, only_in: b.folders ?? null, claude_keeps_it_to: b.onlyIn ?? null }
      p.skills++
      plugins.set(b.plugin, p)
    }
    return {
      mine: r.skills.map((x) => ({ name: x.name, description: x.description, on: x.enabled !== false, only_in: x.folders ?? null })),
      plugins: [...plugins.values()],
      devdash: r.builtIn.filter((b) => b.kind === 'devdash').map((b) => b.name),
      note: 'Their own skills work in Claude Code and OpenCode; plugins only in Claude Code. only_in null = every session.',
    }
  })
  on('skill_find', async (c) => {
    const slug = str(c.args.project)
    const review = await ask<Review>(c, { op: 'skills.review.github', url: need(c.args.source, 'a GitHub link or an install command'), project: slug ? checkout(c, slug) : undefined }, 200_000)
    const page = `/skills/review/${review.id}${slug ? `?project=${slug}` : ''}`
    assistant.open(c.user.id, page)
    return {
      page, skills: review.skills.map((x) => ({ name: x.suggested, description: x.description, problems: x.problems, same_name_as: x.collisions })), left_out: review.extras ?? [],
      next: `The review page is open for ${c.user.name.split(' ')[0]}: they read it and press Install. You can't install it yourself.`,
    }
  })
  on('skill_update', async (c) => {
    const plugin = str(c.args.plugin)
    const name = str(c.args.name)
    if (!plugin === !name) throw new AppError(400, 'bad_args', 'Give name (one of their skills) or plugin (name@marketplace), not both.')
    const done: string[] = []
    if (typeof c.args.enabled === 'boolean') {
      if (plugin) throw new AppError(400, 'bad_args', 'Plugins are turned on and off in Claude Code (/plugin). Use only_in to keep one to some folders.')
      await ask(c, { op: 'skills.enable', name, enabled: c.args.enabled })
      done.push(c.args.enabled ? 'on' : 'off')
    }
    if (c.args.only_in !== undefined) {
      const v = c.args.only_in
      const folders = v === null || v === 'everywhere' ? null
        : (Array.isArray(v) ? v : [v]).map((f) => { const t = String(f).trim(); return t.startsWith('/') || t.startsWith('~') ? t : checkout(c, t) })
      await ask(c, { op: 'skills.scope', ...(plugin ? { plugin } : { name }), folders })
      done.push(folders ? `only in ${folders.join(', ')}` : 'in every session')
    }
    if (!done.length) throw new AppError(400, 'bad_args', 'Say what to change: enabled and/or only_in.')
    return `${plugin ?? name}: ${done.join(', ')}. New sessions follow it; running ones keep what they started with.`
  })
  on('skill_remove', async (c) => {
    const first = c.user.name.split(' ')[0]
    if (!claude.typedByOwner(c.sessionId)) {
      throw new AppError(403, 'not_asked', `Only ${first} can remove a skill, by asking for it in a message they write to you here. This turn didn't come from that, so nothing was removed.`)
    }
    const name = need(c.args.name, 'the skill name')
    const slug = str(c.args.project)
    await ask(c, slug ? { op: 'skills.remove', scope: 'project', project: checkout(c, slug), name } : { op: 'skills.remove', name })
    return slug ? `Removed ${name} from ${slug}, in a commit of its own.` : `Removed ${name}.`
  })

  on('open_page', (c) => {
    const path = need(c.args.path, 'the path, like /tasks/shop/12')
    if (!/^\/(?!\/)[^\s<>"]*$/.test(path)) throw new AppError(400, 'bad_args', 'A DevDash path starts with one slash, like /tasks or /sessions/<id>.')
    assistant.open(c.user.id, path)
    return `Opened ${path} wherever ${c.user.name.split(' ')[0]} has DevDash open.`
  })
  // A schedule's run doesn't reach them itself: it hands over to their chat, so there's one place and one notification.
  on('hand_off', async (c) => {
    const s = assistant.scheduleOf(c.user, c.sessionId)
    if (!s) throw new AppError(400, 'bad_args', "hand_off is for a schedule's run; here you're already talking to them.")
    return assistant.handOff(c.user, s.title, clip(need(c.args.note, 'the note: what you found, and what to tell or ask them'), 2000))
  })
  on('notify_me', async (c) => {
    if (assistant.scheduleOf(c.user, c.sessionId)) throw new AppError(400, 'use_hand_off', 'From a schedule, use hand_off: you tell them in their chat, and that notifies them.')
    const title = clip(need(c.args.title, 'a title'), 120)
    const url = str(c.args.url)
    await notify(c.user.id, 'needs_you', {
      title, body: str(c.args.body) && clip(str(c.args.body)!, 300), url: url?.startsWith('/') && !url.startsWith('//') ? url : `/sessions/${c.sessionId}`,
      tag: `assistant:${c.user.id}:${title}`,
    })
    return 'Notified.'
  })
}
