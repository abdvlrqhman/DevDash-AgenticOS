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
    }, ['prompt']),
  },
  {
    name: 'session_send',
    description: "Send a message to one of the person's sessions (or a shared one they can write in), as them: a follow-up, a correction, \"run the tests\". It's queued if the session is busy.",
    inputSchema: obj({ id, text: { type: 'string' } }, ['id', 'text']),
  },
  {
    name: 'session_stop',
    description: "Stop a session's current turn (like the Stop button). It keeps its conversation.",
    inputSchema: obj({ id }, ['id']),
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
    name: 'notify_me',
    description: "Notify the person's phone and browsers. Only for what needs them or that they asked to hear about, mostly from scheduled runs: they already see your replies.",
    inputSchema: obj({ title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string', description: 'A DevDash path to open; default: this conversation.' } }, ['title']),
  },
]

export const assistantTools = (call, context) =>
  call('mcp.assistant_here', { ...context, args: {} }).then((r) => (r?.name ? ASSISTANT_TOOLS : []), () => []) // "no" arrives as {}
