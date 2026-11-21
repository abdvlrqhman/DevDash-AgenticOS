#!/usr/bin/env node
// DevDash root helper. The only code that runs as root on behalf of the DevDash server.
// systemd starts one instance per connection on /run/devdash/helper.sock (mode 0660, group devdash):
// one JSON request line on stdin, one JSON response line on stdout.
//
// Rules: dependency-free (install.sh copies this single file to /usr/local/libexec before any npm build runs),
// fixed command allowlist, every argument validated, argv arrays only (never a shell).
// DEVDASH_HELPER_DRYRUN=1 prints the commands instead of running them (used by tests).
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const DRY = process.env.DEVDASH_HELPER_DRYRUN === '1'

/** A oneshot unit's state, for the update jobs' progress (read-only). */
function unitState(unit) {
  if (DRY) return { state: 'inactive', result: 'success' }
  // key=value lines: systemctl prints properties in its own order, not the order asked for.
  const out = run('systemctl', ['show', '-p', 'ActiveState', '-p', 'Result', unit], { allowFail: true }) ?? ''
  const prop = (k) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || 'unknown'
  return { state: prop('ActiveState'), result: prop('Result') }
}
const planned = []

// Keep in sync with apps/server/src/modules/auth/service.ts
const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/
const RESERVED = new Set([
  'root', 'admin', 'devdash', 'caddy', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody', 'sshd', 'syslog', 'messagebus',
  'ubuntu', 'docker', 'lxd', 'polkitd', 'tss', 'uuidd', 'tcpdump', 'landscape', 'dnsmasq', 'pollinate', 'neko',
])
const MEMBERS_GROUP = 'devdash-users'
const BROWSER = 'devdash-browser'
const BROWSER_REPO = 'ghcr.io/m1k1o/neko/chromium'
// neko's major version: the NEKO_* settings below and the API DevDash calls. Updates follow its newest release; a new
// major version needs DevDash's say first.
const BROWSER_API = 3
const BROWSER_VERSION_RE = new RegExp(`^${BROWSER_API}\\.\\d+\\.\\d+$`)
const BROWSER_IMAGE = `${BROWSER_REPO}:3.1` // what it ran before updates existed (3.1.2+ fixes CVE-2026-39386)
const byVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
/** The neko releases downloaded here (x.y.z tags an update pulled), oldest first. Tests pass DEVDASH_HELPER_FAKE_TAGS. */
function browserVersions() {
  const out = DRY ? process.env.DEVDASH_HELPER_FAKE_TAGS ?? '' : run('docker', ['image', 'ls', BROWSER_REPO, '--format', '{{.Tag}}'], { allowFail: true }) ?? ''
  return out.split(/[\s,]+/).filter((t) => BROWSER_VERSION_RE.test(t)).sort(byVersion)
}
/** The image the browser runs: the newest release downloaded, else the one it always had. */
const browserImage = () => { const v = browserVersions().at(-1); return v ? `${BROWSER_REPO}:${v}` : BROWSER_IMAGE }
const BROWSER_ENV = '/etc/devdash/browser.env'
const BROWSER_PROFILE_DIR = '/home/neko/.devdash-chromium'
const BROWSER_CHROMIUM_CONF = '/etc/devdash/browser-chromium.conf'
const BROWSER_CDP_PROXY = '/etc/devdash/browser-cdp-proxy.py'
const BROWSER_POLICIES = '/etc/devdash/browser-policies.json'
// Neko's image ships DeveloperToolsAvailability: 2, which blocks CDP page attachment with "Not allowed".
// Keep all of Neko's sandbox policies intact and set DeveloperToolsAvailability: 0 so loopback CDP works
// on regular pages while force-installed extensions remain protected.
const BROWSER_POLICIES_TEXT = JSON.stringify({
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  BrowserSignin: 0,
  DefaultNotificationsSetting: 2,
  DeveloperToolsAvailability: 0,
  EditBookmarksEnabled: false,
  FullscreenAllowed: true,
  IncognitoModeAvailability: 1,
  SyncDisabled: true,
  AutoplayAllowed: true,
  BrowserAddPersonEnabled: false,
  BrowserGuestModeEnabled: false,
  DefaultPopupsSetting: 2,
  DownloadRestrictions: 3,
  VideoCaptureAllowed: true,
  AllowFileSelectionDialogs: false,
  PromptForDownloadLocation: false,
  BookmarkBarEnabled: false,
  PasswordManagerEnabled: false,
  BrowserLabsEnabled: false,
  CommandLineFlagSecurityWarningsEnabled: false,
  URLAllowlist: ['file:///home/neko/Downloads'],
  URLBlocklist: ['file://*', 'chrome://policy'],
  ExtensionInstallForcelist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx',
    'mnjggcdmjocbbbhaepdhchncahnbgone;https://clients2.google.com/service/update2/crx',
  ],
  ExtensionInstallAllowlist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh',
    'mnjggcdmjocbbbhaepdhchncahnbgone',
  ],
  ExtensionInstallBlocklist: ['*'],
}, null, 2) + '\n'
const BROWSER_CHROMIUM_CONF_TEXT = `[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/chromium
  --no-sandbox
  --window-position=0,0
  --display=%(ENV_DISPLAY)s
  --user-data-dir=${BROWSER_PROFILE_DIR}
  --remote-debugging-port=9222
  --no-first-run
  --start-maximized
  --bwsi
  --force-dark-mode
  --disable-file-system
  --disable-gpu
  --disable-software-rasterizer
  --disable-dev-shm-usage
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/chromium.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=10
redirect_stderr=true

[program:openbox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/openbox.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=10
redirect_stderr=true

[program:cdp-proxy]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s"
command=/usr/bin/python3 /etc/neko/devdash-cdp-proxy.py
autorestart=true
priority=810
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/cdp-proxy.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=2
redirect_stderr=true
`
const BROWSER_CDP_PROXY_TEXT = String.raw`#!/usr/bin/env python3
import hmac, os, socket, threading

TOKEN = os.environ.get("NEKO_SESSION_API_TOKEN", "")
MAX_HDR = 16384

def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def handle(client):
    upstream = None
    try:
        client.settimeout(5.0)
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < MAX_HDR:
            chunk = client.recv(4096)
            if not chunk:
                return
            buf += chunk
        sep = buf.find(b"\r\n\r\n")
        if sep < 0:
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        head = buf[:sep].decode("latin1")
        rest = buf[sep + 4:]
        lines = head.split("\r\n")
        if not lines or " " not in lines[0]:
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        got = ""
        out = [lines[0]]
        for line in lines[1:]:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            kl = k.strip().lower()
            if kl == "x-devdash-cdp-token":
                got = v.strip()
                continue
            if kl in ("host", "origin"):
                continue
            out.append(line)
        if not TOKEN or not hmac.compare_digest(got, TOKEN):
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        out.append("Host: 127.0.0.1:9222")
        payload = ("\r\n".join(out) + "\r\n\r\n").encode("latin1") + rest
        upstream = socket.create_connection(("127.0.0.1", 9222), timeout=5.0)
        upstream.sendall(payload)
        client.settimeout(None)
        upstream.settimeout(None)
        t = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t.start()
        pipe(client, upstream)
        t.join(timeout=2.0)
    except OSError:
        pass
    finally:
        try:
            client.close()
        except OSError:
            pass
        if upstream is not None:
            try:
                upstream.close()
            except OSError:
                pass

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 9223))
srv.listen(64)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
`

const BROWSER_UPDATE = 'devdash-browser-update' // a transient unit: systemd-run names it, no unit file
// Guests (invite links) watch only: no control, no clipboard. Members sign in with the admin profile (full control).
const GUEST_PROFILE = JSON.stringify({
  name: '', is_admin: false, can_login: true, can_connect: true, can_watch: true, can_host: false, can_share_media: false,
  can_access_clipboard: false, sends_inactive_cursor: false, can_see_inactive_cursors: true,
})

class Refused extends Error {}

function username(v) {
  if (typeof v !== 'string' || !USERNAME_RE.test(v) || RESERVED.has(v) || v.startsWith('systemd-') || v.startsWith('devdash')) {
    throw new Refused('invalid username')
  }
  return v
}
function text(v, max) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\x00-\x1f\x7f:,]/.test(v)) throw new Refused('invalid text field')
  return v
}
function email(v) {
  if (typeof v !== 'string' || v.length > 254 || !/^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/.test(v)) throw new Refused('invalid email')
  return v
}

function commit(v) {
  if (typeof v !== 'string' || !/^[0-9a-f]{40}$/.test(v)) throw new Refused('not a full commit id')
  return v
}

function run(cmd, args, { allowFail = false } = {}) {
  if (DRY) { planned.push([cmd, ...args].join(' ')); return '' }
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return null
    throw new Error(`${cmd} failed: ${(err.stderr || err.message).toString().trim().slice(0, 300)}`)
  }
}

/** passwd entry or null. Never trusts DRY mode for reads: tests pass a fake via DEVDASH_HELPER_FAKE_UID. */
function lookup(name) {
  if (DRY) {
    const fake = process.env.DEVDASH_HELPER_FAKE_UID
    return fake ? { uid: Number(fake), home: `/home/${name}` } : null
  }
  const line = run('getent', ['passwd', name], { allowFail: true })
  if (!line) return null
  const f = line.split(':')
  return { uid: Number(f[2]), home: f[5] }
}

const groupsOf = (name) => (DRY ? [] : (run('id', ['-nG', name], { allowFail: true }) ?? '').split(/\s+/))

function runInput(cmd, args, input) {
  if (DRY) { planned.push([cmd, ...args, '<stdin>'].join(' ')); return }
  try {
    execFileSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'pipe'] })
  } catch (err) {
    throw new Error(`${cmd} failed: ${(err.stderr || err.message).toString().trim().slice(0, 200)}`)
  }
}

const commands = {
  /** Create or adopt the member's Linux account and enable their agent. Idempotent. */
  'user-ensure'(a) {
    const u = username(a.username)
    const name = text(a.name, 80)
    const mail = a.email === undefined ? null : email(a.email)
    const admin = a.admin === true

    let entry = lookup(u)
    let created = false
    if (entry) {
      // Adopt only regular human accounts (e.g. one created by bootstrap.sh), never system accounts.
      if (!(entry.uid >= 1000 && entry.uid < 60000)) throw new Refused('existing account is not a regular user')
    } else {
      run('useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', '--comment', name, u])
      created = true
      entry = lookup(u) ?? { home: `/home/${u}` }
    }

    run('usermod', ['-aG', MEMBERS_GROUP, u])
    // Admins also get Docker (root-equivalent, like sudo) so their services and Claude can run containers.
    const extra = ['sudo', ...(run('getent', ['group', 'docker'], { allowFail: true }) ? ['docker'] : [])]
    for (const g of extra) {
      if (admin) run('usermod', ['-aG', g, u])
      else if (groupsOf(u).includes(g)) run('gpasswd', ['-d', u, g])
    }
    if (!DRY && existsSync(entry.home)) chmodSync(entry.home, 0o700)

    // Git identity, only if we know an email and the member hasn't set one.
    if (mail && !run('runuser', ['-u', u, '--', 'git', 'config', '--global', '--get', 'user.email'], { allowFail: true })) {
      run('runuser', ['-u', u, '--', 'git', 'config', '--global', 'user.name', name])
      run('runuser', ['-u', u, '--', 'git', 'config', '--global', 'user.email', mail])
    }

    run('systemctl', ['enable', '--now', `devdash-agent@${u}.socket`])
    return { created }
  },

  /** Sets an admin's Linux password, which sudo asks for in the admin shell. Only for DevDash admins (sudo group). */
  'set-password'(a) {
    const u = username(a.username)
    const pw = a.password
    if (typeof pw !== 'string' || pw.length < 1 || pw.length > 256 || /[ -:]/.test(pw)) {
      throw new Refused('password must be 1-256 characters without control characters or colons')
    }
    const entry = lookup(u)
    if (!entry || !(entry.uid >= 1000 && entry.uid < 60000)) throw new Refused('not a member account')
    const groups = groupsOf(u)
    if (!DRY && (!groups.includes(MEMBERS_GROUP) || !groups.includes('sudo'))) throw new Refused('only admins have a server password')
    runInput('chpasswd', [], `${u}:${pw}
`)
    return {}
  },

  /**
   * The team's shared remote browser (neko + Chromium in Docker), started on demand and stopped when nobody uses it.
   * Fixed arguments only. Its passwords live in /etc/devdash/browser.env (readable by the DevDash server, not members);
   * the stream goes straight to the server's public IP on UDP 59000 / TCP 59001, signaling through DevDash.
   */
  'browser-start'() {
    if (DRY) { planned.push(`docker run devdash-browser ${browserImage()}`); return {} }
    const image = browserImage()
    const state = run('docker', ['inspect', '-f', '{{.State.Running}}', BROWSER], { allowFail: true })
    if (state === 'true') return {}
    if (state === 'false') { run('docker', ['start', BROWSER]); return {} }
    // Secrets DevDash uses to sign people in (members: full control; guests: watch only) and to ask who's watching.
    const env = existsSync(BROWSER_ENV) ? readFileSync(BROWSER_ENV, 'utf8') : ''
    const missing = ['NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD', 'NEKO_SESSION_API_TOKEN']
      .filter((k) => !new RegExp(`^${k}=`, 'm').test(env))
    if (missing.length) {
      writeFileSync(BROWSER_ENV, env + missing.map((k) => `${k}=${randomBytes(32).toString('base64url')}\n`).join(''), { mode: 0o640 })
      run('chown', ['root:devdash', BROWSER_ENV])
    }
    const ip = (run('ip', ['-4', 'route', 'get', '1.1.1.1'], { allowFail: true }) ?? '').match(/\bsrc (\d+\.\d+\.\d+\.\d+)/)?.[1]
    if (!ip) throw new Error('could not find the public IP address')
    // Chromium refuses a profile whose lock names another "computer": every new container used to be one. Same
    // hostname each time, and stale locks cleared (logins and cookies are untouched).
    run('docker', ['run', '--rm', '--entrypoint', 'sh', '-v', 'devdash-browser-profile:/p', image, '-c', 'rm -f /p/Singleton*'], { allowFail: true })
    writeFileSync(BROWSER_CHROMIUM_CONF, BROWSER_CHROMIUM_CONF_TEXT, { mode: 0o644 })
    writeFileSync(BROWSER_CDP_PROXY, BROWSER_CDP_PROXY_TEXT, { mode: 0o755 })
    writeFileSync(BROWSER_POLICIES, BROWSER_POLICIES_TEXT, { mode: 0o644 })
    run('docker', ['run', '-d', '--name', BROWSER, '--hostname', 'devdash-browser', '--restart', 'no', '--shm-size=2g', '--memory=2500m',
      '-p', '127.0.0.1:8090:8080', '-p', '127.0.0.1:9222:9223', '-p', '59000:59000/udp', '-p', '59001:59001/tcp',
      '--health-cmd', 'wget -q -O /dev/null http://127.0.0.1:8080/browser/health',
      '--env-file', BROWSER_ENV,
      '-e', 'NEKO_SERVER_BIND=:8080', '-e', 'NEKO_SERVER_PATH_PREFIX=/browser/',
      '-e', 'NEKO_WEBRTC_UDPMUX=59000', '-e', 'NEKO_WEBRTC_TCPMUX=59001', '-e', `NEKO_WEBRTC_NAT1TO1=${ip}`,
      '-e', 'NEKO_MEMBER_PROVIDER=multiuser', '-e', `NEKO_MEMBER_MULTIUSER_USER_PROFILE=${GUEST_PROFILE}`,
      '-e', 'NEKO_SESSION_IMPLICIT_HOSTING=true', '-e', 'NEKO_DESKTOP_SCREEN=1600x900@30',
      '-v', `devdash-browser-profile:${BROWSER_PROFILE_DIR}`,
      '-v', `${BROWSER_CHROMIUM_CONF}:/etc/neko/supervisord/chromium.conf:ro`,
      '-v', `${BROWSER_CDP_PROXY}:/etc/neko/devdash-cdp-proxy.py:ro`,
      '-v', `${BROWSER_POLICIES}:/etc/chromium/policies/managed/policies.json:ro`,
      image])
    return {}
  },

  // A single visible action inside the existing shared Chromium. Fixed operations and validated arguments only.
  'browser-action'({ kind, url, x, y, direction, text, key }) {
    const inside = ['exec', '--user', 'neko', BROWSER]
    const BROWSER_KEYS = {
      Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'BackSpace', Space: 'space',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      PageUp: 'Page_Up', PageDown: 'Page_Down', Back: 'Alt+Left', Forward: 'Alt+Right',
      Reload: 'F5', SelectAll: 'ctrl+a',
    }
    let args
    if (kind === 'open') {
      let link
      try { link = new URL(url) } catch { throw new Refused('invalid web address') }
      if (typeof url !== 'string' || url.length > 2048 || !['http:', 'https:'].includes(link.protocol) || link.username || link.password) throw new Refused('invalid web address')
      args = ['/usr/bin/chromium', '--no-sandbox', `--user-data-dir=${BROWSER_PROFILE_DIR}`, '--new-tab', link.href]
    } else if (kind === 'click' && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 100 && x < 16384 && y < 16384) {
      args = ['xdotool', 'mousemove', String(x), String(y), 'click', '1']
    } else if (kind === 'scroll' && ['up', 'down'].includes(direction)) {
      args = ['xdotool', 'mousemove', '400', '300', 'click', '--repeat', '5', direction === 'up' ? '4' : '5']
    } else if (kind === 'type' && typeof text === 'string' && text.length >= 1 && text.length <= 500 && !/[\x00-\x1f\x7f]/.test(text)) {
      args = ['xdotool', 'type', '--clearmodifiers', '--delay', '12', '--', text]
    } else if (kind === 'press' && typeof key === 'string' && Object.hasOwn(BROWSER_KEYS, key)) {
      args = ['xdotool', 'key', '--clearmodifiers', BROWSER_KEYS[key]]
    } else {
      throw new Refused('invalid browser action')
    }
    if (DRY) planned.push(['docker', ...inside, ...args].join(' '))
    else {
      try {
        execFileSync('docker', [...inside, ...args], { timeout: 8000, stdio: 'ignore' })
      } catch { throw new Error('The shared browser could not carry out the action.') }
    }
    return {}
  },

  'browser-stop'() {
    run('docker', ['stop', '--time', '15', BROWSER], { allowFail: true }) // let Chromium close cleanly (no "restore pages?")
    run('docker', ['rm', '-f', BROWSER], { allowFail: true }) // the profile volume stays: logins survive
    // Releases an update replaced are unused now: only the newest stays (and the original 3.1, which the README's
    // screenshot tool also runs). Only neko's images go, nobody else's.
    for (const v of browserVersions().slice(0, -1)) run('docker', ['rmi', `${BROWSER_REPO}:${v}`], { allowFail: true })
    run('docker', ['image', 'prune', '-f', '--filter', 'label=net.m1k1o.neko.api-version'], { allowFail: true })
    return {}
  },

  /** The browser's image as Docker has it: its neko version, or null before the first download. */
  'browser-version'() {
    const image = browserImage()
    if (DRY) return { image, major: BROWSER_API, version: null }
    const v = run('docker', ['image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.version"}}', image], { allowFail: true })
    return { image, major: BROWSER_API, version: v && /^\d+\.\d+\.\d+$/.test(v) ? v : null }
  },

  /**
   * Downloads a neko release (the server picks the newest of the major version DevDash speaks), in the background. The
   * browser runs it from its next start; a running one keeps its version until it stops, 30 minutes after the last viewer.
   */
  'browser-update'({ version }) {
    if (typeof version !== 'string' || !BROWSER_VERSION_RE.test(version)) throw new Refused(`invalid version: neko ${BROWSER_API}.x.y`)
    run('systemctl', ['reset-failed', `${BROWSER_UPDATE}.service`], { allowFail: true }) // a failed run stays listed until cleared
    run('systemd-run', ['--unit', BROWSER_UPDATE, '--no-block', '--quiet', '/usr/bin/docker', 'pull', '--quiet', `${BROWSER_REPO}:${version}`])
    return {}
  },

  'browser-update-status'() {
    return unitState(`${BROWSER_UPDATE}.service`)
  },

  /** Starts the nightly backup now (deploy/backup.sh, as its systemd unit). */
  'backup-run'() {
    run('systemctl', ['start', '--no-block', 'devdash-backup.service'])
    return {}
  },

  /** Updates Claude Code for everyone to the latest version (deploy/claude-update.sh), in the background. */
  'claude-update'() {
    run('systemctl', ['start', '--no-block', 'devdash-claude-update.service'])
    return {}
  },

  'claude-update-status'() {
    return unitState('devdash-claude-update.service')
  },

  /** Installs or updates OpenCode for everyone to the latest version (deploy/opencode-update.sh), in the background. */
  'opencode-update'() {
    run('systemctl', ['start', '--no-block', 'devdash-opencode-update.service'])
    return {}
  },

  'opencode-update-status'() {
    return unitState('devdash-opencode-update.service')
  },

  /**
   * Deploys a commit of DevDash's GitHub repository (deploy/self-deploy.sh), in the background, after an admin
   * approved it. The script checks the commit is on the repository's main branch. One deploy at a time.
   */
  'deploy'(a) {
    const sha = commit(a.sha)
    const running = run('systemctl', ['list-units', '--all', '--plain', '--no-legend', '--state=activating,active', 'devdash-deploy@*'], { allowFail: true })
    if (running) throw new Refused('a deploy is already running')
    run('systemctl', ['start', '--no-block', `devdash-deploy@${sha}.service`])
    return {}
  },

  /** How a deploy went: its unit's state, whether it ever ran, and the end of its output when it failed. */
  'deploy-status'(a) {
    const sha = commit(a.sha)
    if (DRY) return { state: 'inactive', result: 'success', ran: false }
    const unit = `devdash-deploy@${sha}.service`
    const out = run('systemctl', ['show', '-p', 'ActiveState', '-p', 'Result', '-p', 'InactiveExitTimestampMonotonic', unit], { allowFail: true }) ?? ''
    const prop = (k) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || ''
    const state = prop('ActiveState') || 'unknown'
    const result = prop('Result') || 'unknown'
    const ran = !!prop('InactiveExitTimestampMonotonic') && prop('InactiveExitTimestampMonotonic') !== '0'
    const log = state === 'failed' || (ran && state === 'inactive' && result !== 'success')
      ? (run('journalctl', ['-u', unit, '-n', '40', '-o', 'cat', '--no-pager'], { allowFail: true }) ?? '').slice(-4000)
      : undefined
    return { state, result, ran, log }
  },

  'browser-status'() {
    if (DRY) return { running: false }
    return { running: run('docker', ['inspect', '-f', '{{.State.Running}}', BROWSER], { allowFail: true }) === 'true' }
  },

  /**
   * Lets every member use git in a shared checkout another member created (git refuses "dubious ownership"
   * otherwise). Only folders under /srv/devdash/projects or /srv/devdash/worktrees.
   */
  'git-safe-dir'(a) {
    const path = a.path
    if (typeof path !== 'string' || !/^\/srv\/devdash\/(projects\/[a-z0-9][a-z0-9-]{0,39}|worktrees\/[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9-]{1,40})$/.test(path)) {
      throw new Refused('not a DevDash project folder')
    }
    const known = (run('git', ['config', '--system', '--get-all', 'safe.directory'], { allowFail: true }) ?? '').split('\n')
    if (!known.includes(path)) run('git', ['config', '--system', '--add', 'safe.directory', path])
    return {}
  },

  /**
   * A deleted project's folders (apps/server/src/modules/projects/trash.ts). Its checkout and its session worktrees are
   * owned by different members, and not every folder in them is group-writable, so no member's agent can move or remove
   * all of it: root does, in fixed places only. The trash (/srv/devdash/trash, root only) keeps a project for seven days
   * as <id>-<slug>/checkout and <id>-<slug>/worktrees, then project-purge removes it. Ownership is kept as it was.
   */
  'project-trash'(a) {
    const { slug, from, to } = trashPaths(a)
    run('install', ['-d', '-m', '700', '-o', 'root', '-g', 'root', TRASH])
    if (!DRY && existsSync(to)) throw new Refused('already in the trash')
    run('install', ['-d', '-m', '700', '-o', 'root', '-g', 'root', to])
    for (const [src, dest] of [[from.checkout, `${to}/checkout`], [from.worktrees, `${to}/worktrees`]]) {
      if (DRY || existsSync(src)) run('mv', ['-T', '--', src, dest])
    }
    return { slug }
  },

  /** Puts a deleted project's folders back where they were. Refuses if something new took the checkout's place. */
  'project-restore'(a) {
    const { slug, from, to } = trashPaths(a)
    if (!DRY && !existsSync(to)) throw new Refused('not in the trash')
    if (!DRY && (existsSync(from.checkout) || existsSync(from.worktrees))) throw new Refused('a folder with that name is already there')
    for (const [src, dest] of [[`${to}/checkout`, from.checkout], [`${to}/worktrees`, from.worktrees]]) {
      if (DRY || existsSync(src)) run('mv', ['-T', '--', src, dest])
    }
    run('rmdir', ['--', to])
    return { slug }
  },

  /** Removes a deleted project's folders for good. Only inside the trash. */
  'project-purge'(a) {
    const { slug, to } = trashPaths(a)
    if (DRY || existsSync(to)) run('rm', ['-rf', '--one-file-system', '--', to])
    return { slug }
  },

  /**
   * Isolates a member's userspace Tailscale proxy ports (apps/agent/src/tailscale.ts). The SOCKS/HTTP proxy listens
   * on 127.0.0.1, so without this any local user on this shared box could connect and reach the owner's private
   * tailnet. For each port we add an OUTPUT owner-match rule that REJECTs connections to that loopback port from any
   * uid other than the owner's. The uid is resolved here from the username (never trusted from the caller). Idempotent
   * (-C checks before -A). Runs on every `tailnet.up`.
   */
  'tailnet-isolate'(a) {
    const u = username(a.username)
    const entry = lookup(u)
    if (!entry || !(entry.uid >= 1000 && entry.uid < 60000)) throw new Refused('not a member account')
    for (const port of tailnetPorts(a.ports)) tailnetRule('ensure', entry.uid, port)
    return { uid: entry.uid, ports: tailnetPorts(a.ports) }
  },

  /** Removes the owner-match rules for a member's tailnet proxy ports. Runs on disconnect. Idempotent. */
  'tailnet-unisolate'(a) {
    const u = username(a.username)
    const entry = lookup(u)
    if (!entry || !(entry.uid >= 1000 && entry.uid < 60000)) throw new Refused('not a member account')
    for (const port of tailnetPorts(a.ports)) tailnetRule('remove', entry.uid, port)
    return { uid: entry.uid, ports: tailnetPorts(a.ports) }
  },
}

const TRASH = '/srv/devdash/trash'
/** Where a project's folders live and where they go in the trash, from its id and short name (validated, never a path). */
function trashPaths(a) {
  const id = a.id
  const slug = a.slug
  if (!Number.isInteger(id) || id < 1 || id > 1e9) throw new Refused('invalid project id')
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Refused('invalid project name')
  return { slug, from: { checkout: `/srv/devdash/projects/${slug}`, worktrees: `/srv/devdash/worktrees/${slug}` }, to: `${TRASH}/${id}-${slug}` }
}

function tailnetPorts(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) throw new Refused('give 1-8 ports')
  return v.map((p) => {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Refused('invalid port')
    return p
  })
}

// Adds or removes one iptables OUTPUT owner-match REJECT rule for a loopback port. `-C` tells us whether it already
// exists, so we never add it twice. If iptables lacks owner-match (dev/test boxes), we still plan the right commands
// and surface a clear error at runtime instead of pretending it worked.
function tailnetRule(action, uid, port) {
  const rule = ['OUTPUT', '-o', 'lo', '-p', 'tcp', '--dport', String(port), '-m', 'owner', '!', '--uid-owner', String(uid), '-j', 'REJECT']
  if (DRY) {
    planned.push(['iptables', '-C', ...rule].join(' '))
    planned.push(['iptables', action === 'ensure' ? '-A' : '-D', ...rule].join(' '))
    return
  }
  let exists = false
  try {
    execFileSync('iptables', ['-C', ...rule], { stdio: ['ignore', 'ignore', 'pipe'] })
    exists = true
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString()
    // `-C` exits 1 for a valid-but-absent rule ("does a matching rule exist?"); anything else (missing owner match,
    // no iptables, no permission) means we can't apply the rule, so fail loudly instead of pretending it worked.
    if (!/does a matching rule exist/i.test(msg)) {
      throw new Error(`iptables owner-match is not available on this host: ${msg.trim().slice(0, 200)}`)
    }
  }
  if (action === 'ensure' && !exists) run('iptables', ['-A', ...rule])
  if (action === 'remove' && exists) run('iptables', ['-D', ...rule])
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.includes('\n') || input.length > 16_384) break
  }
  let res
  try {
    const req = JSON.parse(input.split('\n')[0])
    const fn = Object.hasOwn(commands, req?.cmd) ? commands[req.cmd] : null
    if (!fn) throw new Refused('unknown command')
    res = { ok: true, ...fn(req.args ?? {}) }
  } catch (err) {
    res = { ok: false, error: err instanceof Refused || err instanceof SyntaxError ? `refused: ${err.message}` : err.message }
  }
  if (DRY) res.planned = planned
  process.stdout.write(JSON.stringify(res) + '\n')
}

await main()
