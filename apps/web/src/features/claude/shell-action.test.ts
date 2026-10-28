import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolBlock } from './transcript.ts'
import { shellAction, toolView } from './tool-view.ts'

const bash = (command: string, description?: string): ToolBlock =>
  ({ kind: 'tool', key: 'k', id: 'i', name: 'Bash', input: { command, ...(description ? { description } : {}) }, children: [] })

test('shell commands read as what they do (Claude Code has no Grep or Glob tools now, so searches are Bash)', () => {
  // The ten commands of a real DevDash session that showed "Ran" ten times.
  const real = [
    'ls website/ && echo --- && git log --oneline -5 -- website/',
    'cd /srv/devdash/worktrees/shop/9f10776f/website && head -50 build.py',
    'cd /srv/devdash/worktrees/shop/9f10776f/website/assets && head -c 300 app.js',
    `cd /srv/devdash/worktrees/shop/9f10776f && grep -oE '"1[0-9]\\.[0-9]+' package.json`,
    "ls backend/ | grep -iE 'req|pyproject|lock|Pipfile'; cat backend/requirements.txt",
    "grep -hE '^FROM' backend/Dockerfile* deploy/*Dockerfile* 2>/dev/null; ",
    'for p in django djangorestframework channels; do echo $p; done',
    `curl -s --max-time 15 -d '{"package":{"name":"django"}}' https://api.osv.dev/v1/query`,
    "grep -rnE 'CacheMiddleware|get_signed_cookie' backend/",
    'curl -s --max-time 10 https://pypi.org/pypi/djangorestframework/3.18.3/json',
  ]
  assert.deepEqual(real.map((c) => shellAction(c).verb), ['Listed', 'Read', 'Read', 'Searched', 'Listed', 'Searched', 'Ran', 'Fetched', 'Searched', 'Fetched'])

  const cases: [string, string][] = [
    ['export PATH="$HOME/.local/bin:$PATH" && flutter test test/grammar_test.dart', 'Ran tests'],
    ['npm install --no-audit', 'Installed'],
    ['npm run build', 'Built'],
    ['npm run dev', 'Ran dev'],
    ['git add CLAUDE.md && git commit -q -m "docs"', 'Staged changes'],
    ['git push -q origin main', 'Pushed'],
    ['gh run watch 123 --exit-status', 'Checked CI runs'],
    ['python3 -I - <<EOF', 'Ran Python'],
    ["sed -i 's/a/b/' x.txt", 'Edited'],
    ["sed -n '1,40p' x.txt", 'Read'],
    ['B=/tmp/x && umask 077 && mkdir -p "$B"', 'Created a folder'],
    ['sudo -u devdash node /tmp/x.mjs', 'Ran JavaScript'],
    ['docker compose up -d', 'Used Docker'],
    ['rm -rf /tmp/build', 'Deleted'],
    ['unzip -o handoff.zip -d /tmp/x', 'Unpacked'],
    ['pandoc doc.docx -t plain', 'Converted'],
    ['devdash service add web --cmd "npm start"', 'Managed services'],
    ['some-new-cli --flag', 'Ran'],
  ]
  for (const [c, verb] of cases) assert.equal(shellAction(c).verb, verb, c)

  const v = toolView(bash('grep -rn foo .', 'Find usages'))
  assert.deepEqual([v.verb, v.target, v.where, v.icon], ['Searched', 'Find usages', 'grep -rn foo .', 'search'])
})

test("tools DevDash has never heard of still read as what they're about", () => {
  const future = toolView({ kind: 'tool', key: 'k', id: 'i', name: 'ImageGenerate', input: { prompt: 'a red fox', size: '1024' }, children: [],
    result: { text: '[image]', isError: false, images: ['data:image/png;base64,AA'] } })
  assert.deepEqual([future.verb, future.target, future.meta, future.inline?.kind], ['Image Generate', 'a red fox', '1 image', 'images'])

  const file = toolView({ kind: 'tool', key: 'k', id: 'i', name: 'FormatFile', input: { file_path: '/srv/app/src/main.ts' }, children: [], result: { text: 'ok', isError: false, images: [] } })
  assert.deepEqual([file.verb, file.target, file.where], ['Format File', 'main.ts', 'app/src'])

  const web = toolView({ kind: 'tool', key: 'k', id: 'i', name: 'mcp__browser__navigate', input: { url: 'https://example.com/docs' }, children: [] })
  assert.deepEqual([web.verb, web.target, web.where], ['Navigate', 'example.com', 'Browser'], 'an MCP server outside any plugin is named after itself')

  const failed = toolView({ kind: 'tool', key: 'k', id: 'i', name: 'Deploy', input: { env: 'prod' }, children: [], result: { text: 'boom', isError: true, images: [] } })
  assert.deepEqual([failed.meta, failed.inline?.kind], ['failed', 'output'])
})
