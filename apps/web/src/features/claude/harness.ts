import { AGENT_CAPABILITIES, harnessId, type AgentCapabilities, type Harness } from '../../../../../packages/agents/capabilities.ts'
export { HARNESSES, agentCapabilities, type Harness } from '../../../../../packages/agents/capabilities.ts'
import type { PermissionMode } from './data'

/** The coding agents a session can run (the server's HARNESSES), and what DevDash offers with each. */

type Info = AgentCapabilities & {
  hint: string
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
  cli: string | null
}

export const HARNESS: Record<Harness, Info> = {
  claude: {
    ...AGENT_CAPABILITIES.claude,
    hint: "Anthropic's coding agent, on your Claude plan",
    planLimits: true, effort: true, fast: true, advisor: true, remote: true,
    modes: [...AGENT_CAPABILITIES.claude.sessionModes],
    modelHint: 'Any model ID Claude Code accepts, for a specific version.',
    defaultModel: 'Claude Code picks it for your plan, and may change it when it updates.',
    cli: 'The real Claude Code terminal',
  },
  opencode: {
    ...AGENT_CAPABILITIES.opencode,
    hint: 'Open-source coding agent, with any model provider you connect',
    planLimits: false, effort: true, fast: false, advisor: false, remote: false,
    modes: [...AGENT_CAPABILITIES.opencode.sessionModes],
    modelHint: 'A provider/model ID OpenCode knows, like anthropic/claude-sonnet-4-5.',
    defaultModel: 'The model in your OpenCode settings, or OpenCode\'s own pick.',
    cli: 'The OpenCode terminal app',
  },
  t3code: {
    ...AGENT_CAPABILITIES.t3code,
    hint: 'A T3 Code instance running as your Linux account, with explicit Full access',
    planLimits: false, effort: true, fast: false, advisor: false, remote: false,
    modes: [...AGENT_CAPABILITIES.t3code.sessionModes],
    modelHint: 'A provider/model ID offered by your T3 Code connection.',
    defaultModel: 'The default model configured in T3 Code.',
    cli: null,
  },
}

export const harnessOf = (s: { harness?: string | null } | undefined): Harness => harnessId(s?.harness)
export const agentName = (h: string | null | undefined) => HARNESS[harnessOf({ harness: h })].name
