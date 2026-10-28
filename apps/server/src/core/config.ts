import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Config = {
  origin: string
  spaceName: string
  dataDir: string
  port: number
  masterKey: Buffer
  trustCfIp: boolean
  /** Where systemd puts the root helper and agent sockets. Empty on a dev machine (no host integration). */
  runDir: string
  /** Shared git checkouts and worktrees live under <projectsRoot>/projects and <projectsRoot>/worktrees. */
  projectsRoot: string
  /** Port of the services site (https://<space>:<port>/service/<name>/), a separate origin from DevDash. */
  servicesPort: number
  version: string
  /** DevDash's own GitHub repository ("owner/name"): what the Server page offers to deploy. */
  repo: string
  /**
   * A read-only GitHub token (fine-grained: Contents read, for that repository only), needed once the repository is
   * private: to see its commits, deploy them, and serve the app's releases. Null for a public repository.
   */
  githubToken: string | null
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing environment variable ${name} (see .env.example)`)
  return v
}

function repo(v: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) throw new Error('DEVDASH_REPO must be owner/name of a GitHub repository')
  return v
}

export function loadConfig(): Config {
  const origin = need('DEVDASH_ORIGIN').replace(/\/$/, '')
  new URL(origin) // throws on garbage
  const masterKey = Buffer.from(need('DEVDASH_MASTER_KEY'), 'base64')
  if (masterKey.length !== 32) throw new Error('DEVDASH_MASTER_KEY must be 32 bytes, base64')
  const dataDir = resolve(need('DEVDASH_DATA_DIR'))
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return {
    origin,
    spaceName: process.env.DEVDASH_SPACE_NAME || 'DevDash',
    dataDir,
    port: Number(process.env.DEVDASH_PORT || 8787),
    masterKey,
    trustCfIp: process.env.DEVDASH_TRUST_CF_IP === '1',
    runDir: process.env.DEVDASH_RUN_DIR ?? (existsSync('/run/devdash') ? '/run/devdash' : ''),
    projectsRoot: process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash',
    servicesPort: Number(process.env.DEVDASH_SERVICES_PORT || 8443),
    version: pkg.version,
    repo: repo(process.env.DEVDASH_REPO || 'abdvlrqhman/DevDash-AgenticOS'),
    githubToken: process.env.DEVDASH_GITHUB_TOKEN?.trim() || null,
  }
}
