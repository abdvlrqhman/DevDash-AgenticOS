import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Team must stay removable: only these files outside it may mention it.
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const ALLOWED = new Set([
  'apps/server/src/app.ts',
  'apps/web/src/main.tsx',
  'apps/web/src/features/projects/ProjectPage.tsx',
  'apps/web/src/components/app/shell.tsx',
  'packages/claude-plugin/mcp/devdash.mjs',
])
// A static or dynamic import of anything under a team/ folder, or team.mjs.
const IMPORTS_TEAM = /(from\s+|import\()\s*['"][^'"]*\/team(\/|\.mjs)[^'"]*['"]/
const OWN = ['apps/server/src/modules/team/', 'apps/web/src/features/team/', 'packages/claude-plugin/mcp/team.mjs']

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(ts|tsx|mjs)$/.test(name)) yield path
  }
}

test('nothing outside Team imports it, except the plug-in lines listed in REMOVING-TEAM.md', () => {
  const offenders: string[] = []
  for (const dir of ['apps/server/src', 'apps/web/src', 'apps/agent/src', 'packages/claude-plugin']) {
    for (const path of files(join(ROOT, dir))) {
      const rel = relative(ROOT, path).replaceAll('\\', '/')
      if (OWN.some((o) => rel.startsWith(o)) || ALLOWED.has(rel)) continue
      if (IMPORTS_TEAM.test(readFileSync(path, 'utf8'))) offenders.push(rel)
    }
  }
  assert.deepEqual(offenders, [])
  // The check itself works: each allowed file does import Team.
  for (const rel of ALLOWED) assert.ok(IMPORTS_TEAM.test(readFileSync(join(ROOT, rel), 'utf8')), `${rel} should be a Team plug-in`)
})
