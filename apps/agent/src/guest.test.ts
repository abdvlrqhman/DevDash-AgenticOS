import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guestMay } from './guest.ts'

test('guest turns: the shared project is fine, the owner\'s access waits for them', () => {
  const tmp = mkdtempSync('/tmp/dd-guest-')
  try {
    const shared = join(tmp, 'projects')
    const project = join(shared, 'shop')
    const home = join(tmp, 'home', 'yara')
    mkdirSync(project, { recursive: true })
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(project, 'app.ts'), 'x')
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret')
    symlinkSync(join(home, '.ssh'), join(project, 'keys')) // a link inside the project to the owner's keys
    const o = { cwd: project, tailnet: false, roots: [shared] }

    // Reading and editing the shared project: the teammate could do that with their own account.
    assert.equal(guestMay('Read', { file_path: join(project, 'app.ts') }, o), true)
    assert.equal(guestMay('Read', { file_path: 'app.ts' }, o), true, 'relative to the session folder')
    assert.equal(guestMay('Write', { file_path: join(project, 'new', 'file.ts') }, o), true, 'a new file in a new folder')
    assert.equal(guestMay('Edit', { file_path: join(project, 'app.ts') }, o), true)
    assert.equal(guestMay('Grep', { pattern: 'TODO' }, o), true, 'no path: the session folder')
    assert.equal(guestMay('Glob', { pattern: '**/*.ts' }, o), true)

    // The owner's things: their home, keys, a link out of the project, ~ paths.
    assert.equal(guestMay('Read', { file_path: join(home, '.ssh', 'id_ed25519') }, o), false)
    assert.equal(guestMay('Read', { file_path: join(project, 'keys', 'id_ed25519') }, o), false, 'a symlink out of the project')
    assert.equal(guestMay('Read', { file_path: '../../home/yara/.ssh/id_ed25519' }, o), false)
    assert.equal(guestMay('Read', { file_path: '~/.config/gh/hosts.yml' }, o), false)
    assert.equal(guestMay('Glob', { pattern: `${home}/**/*` }, o), false)
    assert.equal(guestMay('Glob', { pattern: '../../home/yara/**' }, o), false, 'a relative pattern climbing out')
    assert.equal(guestMay('Glob', { pattern: '*.ts', path: '../..' }, o), false)
    assert.equal(guestMay('Glob', { pattern: 'src/**/*.ts', path: project }, o), true)
    assert.equal(guestMay('Grep', { pattern: 'token', path: home }, o), false)

    // Connected tools wait unless shared: they act with the owner's accounts.
    assert.equal(guestMay('mcp__devdash__tasks_list', {}, o), false)
    assert.equal(guestMay('SomethingNew', {}, o), false)

    // Planning, to-dos, web search and subagents use nothing of the owner's.
    for (const t of ['TodoWrite', 'Task', 'WebSearch', 'ExitPlanMode']) assert.equal(guestMay(t, {}, o), true, t)
    // Fetching a page is fine, unless the session reaches the owner's private network.
    assert.equal(guestMay('WebFetch', { url: 'https://example.com' }, o), true)
    assert.equal(guestMay('WebFetch', { url: 'http://100.64.0.3' }, { ...o, tailnet: true }), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("teammates' commands run, except what reaches the owner's own things: their files, unshared accounts, what can't be undone", () => {
  const tmp = mkdtempSync('/tmp/dd-guest-')
  try {
    const shared = join(tmp, 'projects')
    const project = join(shared, 'shop')
    mkdirSync(project, { recursive: true })
    const home = join(tmp, 'home', 'yara')
    mkdirSync(home, { recursive: true })
    const base = { cwd: project, tailnet: true, roots: [shared], tailnetMcps: ['ida'], home }
    const may = (caps: string[], tool: string, input: Record<string, unknown> = {}) => guestMay(tool, input, { ...base, caps })
    const bash = (caps: string[], command: string) => may(caps, 'Bash', { command })

    // Ordinary work runs: builds, tests, scripts, local git, services, even with nothing shared.
    for (const c of ['npm test', 'npm run build && node scripts/seed.js', 'python3 -m pytest -q', 'git add -A && git commit -m "Fix login"',
      'git status && git log --oneline -5', 'for f in out/*.mp4; do ffprobe "$f"; done', 'devdash service restart shop-web', 'docker compose up -d']) {
      assert.equal(bash([], c), true, c)
    }
    assert.equal(may([], 'BashOutput', { bash_id: 'x' }), true)
    assert.equal(bash([], 'git commit -m "Document the ssh setup and rclone uploads"'), true, 'a message is not a command')

    // The owner's home and credentials always wait.
    for (const c of ['cat ~/.bashrc', 'ls $HOME', `cat ${home}/notes.txt`, 'cd /home && ls', 'cat /root/x', 'cp deploy/.ssh/id_ed25519 .',
      'cat ~/.config/gh/hosts.yml', 'cat .netrc', 'echo $GH_TOKEN', 'cat /proc/self/environ']) {
      assert.equal(bash(['drive', 'tailnet', 'github', 'apps'], c), false, c)
    }
    assert.equal(bash([], 'git diff HEAD~1'), true, 'a ~ inside a word is not the home folder')

    // Accounts: only when shared.
    assert.equal(bash([], 'rclone move out/ad.mp4 drive:shop/videos/'), false)
    assert.equal(bash(['drive'], 'rclone move out/ad.mp4 drive:shop/videos/ --drive-chunk-size 128M'), true)
    assert.equal(bash(['drive'], 'for f in out/*.mp4; do rclone copy "$f" drive:shop/videos/; done'), true)
    assert.equal(bash([], 'git push origin main'), false)
    assert.equal(bash([], 'gh pr create --fill'), false)
    assert.equal(bash(['github'], 'git push origin main && gh pr create --fill'), true)
    assert.equal(bash(['github'], 'git -C web pull --rebase'), true)
    assert.equal(bash([], 'ssh pi@100.64.0.7 uptime'), false)
    assert.equal(bash([], 'curl -s http://100.64.0.3:8080/health'), false)
    assert.equal(bash(['tailnet'], 'ssh -o ProxyCommand="tailnet-connect %h %p" pi@100.64.0.7 uptime'), true)
    assert.equal(bash(['tailnet'], 'curl -s http://100.64.0.3:8080/health'), true)
    assert.equal(bash(['github'], 'ssh pi@100.64.0.7'), false, 'each account its own switch')

    // What can't be undone, or hands out or changes the owner's accounts, waits even when shared.
    const all = ['drive', 'tailnet', 'github', 'apps']
    for (const c of ['gh auth token', 'gh repo delete acme/shop --yes', 'gh api -X DELETE repos/acme/shop', 'git push --force origin main',
      'git push origin +main', 'git push origin :release', 'git push origin --delete old', 'rclone purge drive:shop', 'rclone config show',
      'rclone lsf drive: --config x.conf', 'rclone copy :local:/etc drive:x', 'tailscale funnel 3000', 'crontab -l']) {
      assert.equal(bash(all, c), false, c)
    }

    // A session in the owner's home: every relative path is theirs.
    assert.equal(guestMay('Bash', { command: 'cat .bashrc' }, { ...base, caps: all, cwd: home }), false)

    // Other tools: tailnet MCPs, DevDash's network tools and page fetches with Tailscale; every other MCP with apps.
    assert.equal(may([], 'mcp__ida__decompile'), false)
    assert.equal(may(['tailnet'], 'mcp__ida__decompile'), true)
    assert.equal(may(['tailnet'], 'mcp__plugin_devdash_devdash__net_devices'), true)
    assert.equal(may(['tailnet'], 'mcp__plugin_devdash_devdash__tasks_list'), false)
    assert.equal(may(['apps'], 'mcp__plugin_devdash_devdash__tasks_list'), true)
    assert.equal(may(['apps'], 'mcp__ida__decompile'), false, 'still Tailscale')
    assert.equal(may([], 'WebFetch', { url: 'http://100.64.0.3' }), false)
    assert.equal(may(['tailnet'], 'WebFetch', { url: 'http://100.64.0.3' }), true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
