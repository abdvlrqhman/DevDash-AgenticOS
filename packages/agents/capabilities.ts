/** Agent features that both the server and web must enforce. Adding an agent does not opt it into every workflow. */
export const HARNESSES = ['claude', 'opencode', 't3code'] as const
export type Harness = (typeof HARNESSES)[number]
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
export type AgentCapabilities = {
  label: string
  name: string
  profiles: boolean
  terminal: boolean
  attachments: boolean
  guests: boolean
  toolPolicies: boolean
  completions: boolean
  assistant: boolean
  autopilot: boolean
  devdashConnections: boolean
  automaticResume: boolean
  mutablePermissions: boolean
  atomicSelection: boolean
  defaultModelSwitch: boolean
  /** Accepted at server boundaries, including unattended role modes. */
  acceptedModes: readonly PermissionMode[]
  /** Modes offered when someone creates or configures an ordinary session. */
  sessionModes: readonly PermissionMode[]
}
const local = {
  profiles: true, terminal: true, attachments: true, guests: true, toolPolicies: true, completions: true, assistant: true, autopilot: true,
  devdashConnections: true, automaticResume: true, mutablePermissions: true, atomicSelection: false, defaultModelSwitch: true,
  acceptedModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
} as const
export const AGENT_CAPABILITIES: Record<Harness, AgentCapabilities> = {
  claude: { ...local, label: 'Claude Code', name: 'Claude', sessionModes: ['bypassPermissions', 'acceptEdits', 'plan', 'default', 'auto'] },
  opencode: { ...local, label: 'OpenCode', name: 'OpenCode', sessionModes: ['bypassPermissions', 'acceptEdits', 'plan', 'default'] },
  t3code: {
    label: 'T3 Code', name: 'T3 Code', profiles: false, terminal: false, attachments: false, guests: false,
    toolPolicies: false, completions: true, assistant: true, autopilot: true, devdashConnections: false, automaticResume: false, mutablePermissions: false,
    atomicSelection: true, defaultModelSwitch: false,
    // The MCP bridge cannot enforce DevDash approval decisions. It may only execute an explicit Full access session.
    acceptedModes: ['bypassPermissions'], sessionModes: ['bypassPermissions'],
  },
}
export const harnessId = (value: string | null | undefined): Harness => (HARNESSES as readonly string[]).includes(value ?? '') ? value as Harness : 'claude'
export const agentCapabilities = (value: string | null | undefined): AgentCapabilities => AGENT_CAPABILITIES[harnessId(value)]
export const supportsPermissionMode = (harness: string | null | undefined, mode: string) => (agentCapabilities(harness).acceptedModes as readonly string[]).includes(mode)
