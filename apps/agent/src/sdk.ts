// The Agent SDK is loaded from the system-wide Claude install (deploy/claude-update.sh), not from DevDash's
// node_modules, so Chat mode and CLI mode always run the same Claude Code version.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CLAUDE_HOME = process.env.DEVDASH_CLAUDE_HOME ?? '/opt/devdash/claude/current'
export const CLAUDE_BIN = join(CLAUDE_HOME, 'bin', 'claude')

// Minimal types for the parts of @anthropic-ai/claude-agent-sdk DevDash uses (full types: sdk.d.ts in the package).
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
export type SDKMessage = { type: string; subtype?: string; uuid?: string; session_id?: string; [k: string]: unknown }
export type SDKUserMessage = {
  type: 'user'
  message: { role: 'user'; content: unknown[] }
  parent_tool_use_id: null
  session_id?: string
  uuid?: string
}
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
export type Query = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  /** Session-scoped settings, applied live (e.g. { effortLevel: 'xhigh' }; null resets to the model default). */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  supportedCommands(): Promise<{ name: string; description: string; argumentHint?: string }[]>
  /** The data behind /usage (experimental in the SDK, so optional here). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(o?: { skipBehaviors?: boolean }): Promise<{
    subscription_type: string | null
    rate_limits_available: boolean
    rate_limits: Record<string, unknown> | null
  }>
  supportedModels(): Promise<{ value: string; displayName: string; description?: string }[]>
  /** The data behind /context. 'summary' answers from the last response's usage, without token-count calls. */
  getContextUsage(o?: { detail?: 'summary' | 'full' }): Promise<{ percentage: number; totalTokens: number; maxTokens: number }>
  /** Remote Control (claude.ai/code and the Claude app). Not in the SDK's public types yet, so optional here. */
  enableRemoteControl?(enabled: boolean, name?: string): Promise<{ session_url?: string } | undefined>
  /** Stops a background task (a shell, subagent or monitor) by its task id. */
  stopTask(taskId: string): Promise<void>
  close(): void
}
type Sdk = {
  query(p: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }): Query
  getSessionMessages(id: string, o?: { dir?: string; limit?: number; offset?: number }): Promise<unknown[]>
  /** summary = the /rename title, else Claude Code's own generated title, else the first prompt. */
  getSessionInfo(id: string, o?: { dir?: string }): Promise<{ summary: string; customTitle?: string } | undefined>
  renameSession(id: string, title: string, o?: { dir?: string }): Promise<void>
}

let sdk: Promise<Sdk> | undefined
export const loadSdk = () =>
  (sdk ??= import(pathToFileURL(join(CLAUDE_HOME, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href) as Promise<Sdk>)
