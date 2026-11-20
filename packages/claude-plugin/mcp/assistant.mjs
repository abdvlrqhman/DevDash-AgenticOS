// Tools only a member's personal agent gets (apps/server/src/modules/assistant/mcp.ts): their sessions, their schedules,
// and reaching them (a page in their DevDash, a notification). devdash.mjs asks DevDash once, when the tool server
// starts, whether this session is a personal agent.
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const id = { type: 'string', description: 'The session id (from sessions_list, or the /sessions/<id> link).' }
const days = {
  description: 'Weekdays it repeats on: names ("mon", "thu"), numbers (0 = Sunday), or "daily", "weekdays", "weekends". Default: daily.',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: ['string', 'integer'] } }],
}

export const ASSISTANT_TOOLS = [
  {
    name: 'sessions_list',
    description: "Coding sessions you can see: the person's own and ones teammates shared, newest first, with status (working, waiting = blocked on a person, idle, error), agent, project and link.",
    inputSchema: obj({ project: { type: 'string', description: 'Only this project.' }, mine: { type: 'boolean', description: "Only the person's own." }, archived: { type: 'boolean' } }),
  },
  {
    name: 'session_read',
    description: "One session's state and recent conversation: who said what, which tools its agent used, and what it's waiting for. Use it to check on work before reporting.",
    inputSchema: obj({ id, last: { type: 'integer', description: 'How many recent entries (default 30, up to 80).' } }, ['id']),
  },
  {
    name: 'session_create',
    description: 'Start a coding session that works on its own: in a project (its own worktree and branch by default) or a folder. The prompt is all it gets, so brief it completely: the goal, where, constraints, how to check the result, and to report back. Uses the person\'s default agent, account and permission mode unless you name others.',
    inputSchema: obj({
      prompt: { type: 'string' },
      project: { type: 'string', description: "Project short name. Leave out for a folder outside projects (then give folder)." },
      folder: { type: 'string', description: 'Outside a project: the folder, e.g. ~/sessions/research.' },
      worktree: { type: 'boolean', description: 'In a project: false to work in the shared checkout instead of a fresh worktree.' },
      agent: { type: 'string', enum: ['claude', 'opencode'] },
      profile: { type: 'string', description: 'Account (profile) name.' },
      model: { type: 'string' },
      permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan'] },
      follow: { type: 'string', description: 'Follow it from the start (see session_follow): the goal in one line. When they asked you for this work.' },
    }, ['prompt']),
  },
  {
    name: 'session_send',
    description: "Send a message to one of the person's sessions (or a shared one they can write in), as them: a follow-up, a correction, \"run the tests\". It's queued if the session is busy.",
    inputSchema: obj({ id, text: { type: 'string' } }, ['id', 'text']),
  },
  {
    name: 'session_follow',
    description: "Follow a session for the person until its work is done: DevDash wakes you in this chat when it finishes a turn, asks something or fails, and you continue it or tell them. Only when they ask you to (or for a session you start for work they asked for).",
    inputSchema: obj({ id, goal: { type: 'string', description: 'What should be true when it is done, in one line: "panel polished and a PR open".' } }, ['id', 'goal']),
  },
  { name: 'session_unfollow', description: 'Stop following a session: its goal is reached, or they asked.', inputSchema: obj({ id }, ['id']) },
  {
    name: 'follow_reply',
    description: "Only after DevDash woke you about a followed session: continue it on your own with the next step the person already agreed, within their autopilot rules. Refused when autopilot is off, for red, after 5 replies, when a person took over or it goes in circles: then tell them instead.",
    inputSchema: obj({
      id, text: { type: 'string', description: 'The message to the session.' },
      tier: { type: 'string', enum: ['green', 'yellow'] }, why: { type: 'string', description: 'The rule, or what they agreed in this chat.' },
    }, ['id', 'text', 'tier', 'why']),
  },
  {
    name: 'follow_keep',
    description: "Only after DevDash woke you about a followed session: there's nothing new for the person (it's still on it). The follow stays as it was, nothing is shown to them and they aren't notified; you're woken again when it changes. Then write nothing to them about it.",
    inputSchema: obj({ id }, ['id']),
  },
  {
    name: 'follow_answer',
    description: "Only after DevDash woke you about a followed session that asks a question: answer it for the person, within their autopilot rules (never a permission prompt; never a red question). Same limits as follow_reply.",
    inputSchema: obj({
      id, answers: { type: 'object', description: '{"<the question, exactly>": "<the chosen option\'s label, or your answer>"}', additionalProperties: { type: 'string' } },
      tier: { type: 'string', enum: ['green', 'yellow'] }, why: { type: 'string' },
    }, ['id', 'answers', 'tier', 'why']),
  },
  {
    name: 'session_stop',
    description: "Stop a session's current turn (like the Stop button). It keeps its conversation.",
    inputSchema: obj({ id }, ['id']),
  },
  {
    name: 'project_create',
    description: "Create a new DevDash project, exactly as the Projects page does: a git repository in /srv/devdash/projects (empty, or cloned from repo_url), with the person as its creator. ONLY when the person asks you for a new project in a message they write to you now: never from a schedule, autopilot, another session, or because a teammate asked; DevDash refuses it then. Don't create one on your own initiative either: if a project might help, ask them first. Check project_info so you don't duplicate one that exists. Then start work there with session_create (project = the slug it returns).",
    inputSchema: obj({
      name: { type: 'string', description: 'Project name, e.g. "Shop app".' },
      slug: { type: 'string', description: 'Short name for the folder and links: lowercase letters, digits and dashes, up to 40. Default: made from the name.' },
      instructions: { type: 'string', description: 'What the project is and how to work on it: every session in the project gets these (like a Claude Project).' },
      repo_url: { type: 'string', description: 'An existing git repository to clone instead of starting empty.' },
    }, ['name']),
  },
  {
    name: 'skills_list',
    description: "The person's skills: their own (every session, or only_in some folders; Claude Code and OpenCode), plugins' (Claude Code only), DevDash's. With project: that project's committed skills, for the whole team.",
    inputSchema: obj({ project: { type: 'string', description: 'Project short name.' } }),
  },
  {
    name: 'skill_find',
    description: 'Fetch a skill for the person to install: from a GitHub link, owner/repo, or an install command they found (`npx skills add owner/repo --skill x`, `/plugin install name@marketplace`, `/plugin marketplace add owner/repo`). Nothing is run. It opens the review page, where they read it and press Install; you cannot install it yourself. A plugin gives only its skills (its hooks and MCP servers are left out), so it works in OpenCode too.',
    inputSchema: obj({ source: { type: 'string' }, project: { type: 'string', description: 'Install into this project (committed, for the whole team) instead of their own skills.' } }, ['source']),
  },
  {
    name: 'skill_update',
    description: "Turn one of the person's skills on or off, or keep it (or a plugin) to some projects or folders: only_in takes project short names or folder paths (~/projects/x), or \"everywhere\". New sessions follow it.",
    inputSchema: obj({
      name: { type: 'string', description: 'One of their own skills (skills_list "mine").' },
      plugin: { type: 'string', description: 'A plugin id, name@marketplace (skills_list "plugins"): only_in only.' },
      enabled: { type: 'boolean' },
      only_in: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['everywhere'] }] },
    }),
  },
  {
    name: 'skill_remove',
    description: "Remove one of the person's skills, or a project's (committed on its own). Only when they ask for it in a message they write to you now.",
    inputSchema: obj({ name: { type: 'string' }, project: { type: 'string' } }, ['name']),
  },
  {
    name: 'schedules_list',
    description: "The person's schedules: prompts you get at set times, with when they run next.",
    inputSchema: obj({}),
  },
  {
    name: 'schedule_create',
    description: 'Schedule a prompt for yourself: weekly at a time ("at" + "days"), or once ("run_at"). When it runs you get "⏰ Scheduled: <title>" and the prompt, probably while the person is away, so write the prompt to stand on its own (what to check, what to do, when to notify them).',
    inputSchema: obj({
      title: { type: 'string', description: 'A few words, e.g. "Morning brief".' },
      prompt: { type: 'string' },
      at: { type: 'string', description: 'HH:MM, 24-hour, in the person\'s time zone (or tz).' },
      days,
      run_at: { type: 'string', description: 'For a one-off: an ISO time with offset, e.g. 2026-11-06T09:00:00+02:00.' },
      tz: { type: 'string', description: 'IANA time zone, if not the person\'s.' },
    }, ['title', 'prompt']),
  },
  {
    name: 'schedule_update',
    description: 'Change a schedule: its time, prompt or title, or pause/resume it (enabled).',
    inputSchema: obj({
      id: { type: 'integer' }, title: { type: 'string' }, prompt: { type: 'string' }, at: { type: 'string' }, days, run_at: { type: 'string' },
      tz: { type: 'string' }, enabled: { type: 'boolean' },
    }, ['id']),
  },
  { name: 'schedule_delete', description: 'Delete a schedule.', inputSchema: obj({ id: { type: 'integer' } }, ['id']) },
  {
    name: 'open_page',
    description: 'Show a DevDash page to the person, in the DevDash they have open: /tasks/<project>/<n>, /sessions/<id>, /projects/<project>, /services/<name>, /notes/<id>, /files?path=<folder>, /tasks, /server…',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
  },
  {
    name: 'hand_off',
    description: "Only in a schedule's run: hand what needs the person to their chat with you (a check-in, a question, something they must know or fix). You then write to them there and they're notified once. If nothing needs them, don't call it: the run stays silent.",
    inputSchema: obj({ note: { type: 'string', description: 'What you found and what to tell or ask them, with the facts their chat needs.' } }, ['note']),
  },
  {
    name: 'notify_me',
    description: "Notify the person's phone and browsers. Only for what needs them or that they asked to hear about: they already see your replies. Not from a schedule's run (use hand_off).",
    inputSchema: obj({ title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string', description: 'A DevDash path to open; default: this conversation.' } }, ['title']),
  },
]

export const assistantTools = (call, context) =>
  call('mcp.assistant_here', { ...context, args: {} }).then((r) => (r?.name ? ASSISTANT_TOOLS : []), () => []) // "no" arrives as {}
