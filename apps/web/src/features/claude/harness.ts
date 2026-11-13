import type { PermissionMode } from './data'

/** The coding agents a session can run (the server's HARNESSES), and what DevDash offers with each. */
export type Harness = 'claude' | 'opencode'

type Info = {
  label: string
  /** How messages and notifications name it: "OpenCode finished". */
  name: string
  hint: string
  /** Profiles: separate sign-ins (Claude logins; OpenCode provider keys) and settings. */
  profiles: boolean
  /** Claude plan limits (5-hour, weekly) beside a session's own cost. */
  planLimits: boolean
  /** Effort (OpenCode: the model's own levels, which it reports), fast mode and Remote Control (Claude Code's own). */
  effort: boolean
  fast: boolean
  /** Claude Code's advisor tool: a stronger model it consults on hard steps. */
  advisor: boolean
  remote: boolean
  /** The permission modes it can run in. */
  modes: PermissionMode[]
  /** Text for the model picker's "another model" field. */
  modelHint: string
  /** What its own default model is: the one a session gets when nobody picks one. */
  defaultModel: string
  cli: string
}

export const HARNESS: Record<Harness, Info> = {
  claude: {
    label: 'Claude Code', name: 'Claude', hint: "Anthropic's coding agent, on your Claude plan",
    profiles: true, planLimits: true, effort: true, fast: true, advisor: true, remote: true,
    modes: ['bypassPermissions', 'acceptEdits', 'plan', 'default', 'auto'],
    modelHint: 'Any model ID Claude Code accepts, for a specific version.',
    defaultModel: 'Claude Code picks it for your plan, and may change it when it updates.',
    cli: 'The real Claude Code terminal',
  },
  opencode: {
    label: 'OpenCode', name: 'OpenCode', hint: 'Open-source coding agent, with any model provider you connect',
    profiles: true, planLimits: false, effort: true, fast: false, advisor: false, remote: false,
    modes: ['bypassPermissions', 'acceptEdits', 'plan', 'default'],
    modelHint: 'A provider/model ID OpenCode knows, like anthropic/claude-sonnet-4-5.',
    defaultModel: 'The model in your OpenCode settings, or OpenCode\'s own pick.',
    cli: 'The OpenCode terminal app',
  },
}
export const HARNESSES = Object.keys(HARNESS) as Harness[]

export const harnessOf = (s: { harness?: string | null } | undefined): Harness => (s?.harness === 'opencode' ? 'opencode' : 'claude')
export const agentName = (h: string | null | undefined) => HARNESS[harnessOf({ harness: h })].name
