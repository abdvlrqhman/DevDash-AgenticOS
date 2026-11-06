// Autopilot's tools (apps/server/src/modules/autopilot/mcp.ts), in a member's own sessions (not team roles'). While the
// member has autopilot off, they answer so, and the session asks them as usual.
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  {
    name: 'autopilot_log',
    description: "Log a decision you made for the person on autopilot, at the moment you make it: tier green or yellow (red is never decided on autopilot), what you decided, and why (the rule or preference). It answers if autopilot is off or this turn is a teammate's: then ask as usual.",
    inputSchema: obj({
      tier: { type: 'string', enum: ['green', 'yellow'] },
      what: { type: 'string', description: 'What you decided, in one line.' },
      why: { type: 'string', description: 'The rule or preference behind it, in one line.' },
    }, ['tier', 'what']),
  },
  {
    name: 'autopilot_rules',
    description: "The person's autopilot rules (green: decide; yellow: decide and log as yellow; red: ask), when autopilot is on and you don't have them in this conversation.",
    inputSchema: obj({}),
  },
]

export const autopilotTools = (call, context) =>
  call('mcp.autopilot_here', { ...context, args: {} }).then((here) => (here ? TOOLS : []), () => [])
