import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { svcTmux, tmux } from './tmux.ts'

// The team's shared tools (/srv/devdash/shared, made by install.sh): SDKs and package caches that every member's Claude
// sessions, terminals and services use, so four people don't each download and keep the same Android SDK, Flutter and
// packages. Only downloaded, public things live there: logins stay in each member's own config (~/.npmrc, pip.conf, the
// Hugging Face token in HF_HOME, ~/.gradle/gradle.properties). Projects still pin their own versions (lockfiles, .fvmrc,
// compileSdk), and every cache keeps the versions side by side.

const run = promisify(execFile)
export const sharedRoot = () => `${process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'}/shared`

/** Caches, made on first use: empty is fine, the tools fill them. */
const CACHES: Record<string, string> = {
  PUB_CACHE: 'pub-cache',
  npm_config_cache: 'npm-cache',
  PIP_CACHE_DIR: 'pip-cache',
  // Only the models: HF_HOME, where the login token lives, stays each member's own.
  HF_HUB_CACHE: 'huggingface/hub',
  PLAYWRIGHT_BROWSERS_PATH: 'ms-playwright',
  // Flutter versions a project pins with FVM (.fvmrc): one copy of each, for everyone.
  FVM_CACHE_PATH: 'fvm',
}
/** SDKs and Gradle's read-only dependency cache: used once someone has put them there. */
const SDKS: Record<string, string> = { ANDROID_HOME: 'android-sdk', ANDROID_SDK_ROOT: 'android-sdk', GRADLE_RO_DEP_CACHE: 'gradle-ro' }

/** What a member's processes get to use the shared tools; nothing until the shared folder exists. */
export function sharedEnv(root = sharedRoot(), exists: (p: string) => boolean = existsSync, path = process.env.PATH ?? ''): Record<string, string> {
  if (!exists(root)) return {}
  // Playwright removes browsers no project of *this* user still uses: with one shared folder, another member's might.
  const env: Record<string, string> = { PLAYWRIGHT_SKIP_BROWSER_GC: '1' }
  for (const [k, dir] of Object.entries(CACHES)) env[k] = join(root, dir)
  for (const [k, dir] of Object.entries(SDKS)) if (exists(join(root, dir))) env[k] = join(root, dir)
  // The team's default Flutter, first on PATH (a project that pins another version uses FVM).
  const flutter = join(root, 'flutter', 'bin')
  if (exists(join(flutter, 'flutter'))) env.PATH = [flutter, ...path.split(':').filter((p) => p && p !== flutter)].join(':')
  return env
}

/** The shared Flutter SDKs: git repositories that git refuses to use unless each member trusts them (safe.directory). */
export function sharedRepos(root = sharedRoot()): string[] {
  const versions = join(root, 'fvm', 'versions')
  const fvm = existsSync(versions) ? readdirSync(versions).map((v) => join(versions, v)) : []
  return [join(root, 'flutter'), ...fvm].filter((p) => existsSync(join(p, '.git')))
}

/** Points this member's processes at the shared tools; run at start and now and then (new SDKs, new versions). */
export async function applySharedTools(): Promise<void> {
  const env = sharedEnv()
  if (!Object.keys(env).length) return
  for (const k of Object.keys(CACHES)) {
    try { mkdirSync(env[k]!, { recursive: true }) } catch { /* someone else's, or no access: the tool says so */ }
  }
  Object.assign(process.env, env)
  // Terminals and services run in tmux servers that may have started before: they get the new values too.
  for (const [k, v] of Object.entries(env)) {
    void tmux('set-environment', '-g', k, v).catch(() => {})
    void svcTmux('set-environment', '-g', k, v).catch(() => {})
  }
  const trusted = (await run('git', ['config', '--global', '--get-all', 'safe.directory']).catch(() => ({ stdout: '' }))).stdout.split('\n')
  for (const repo of sharedRepos()) {
    if (!trusted.includes(repo)) await run('git', ['config', '--global', '--add', 'safe.directory', repo]).catch(() => {})
  }
}

export function startSharedTools(): void {
  const once = () => void applySharedTools().catch((err: Error) => console.log(`shared tools: ${err.message}`))
  once()
  setInterval(once, 15 * 60_000).unref()
}
