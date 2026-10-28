// The Android app on an emulator, against a real space (.github/workflows/android-e2e.yml).
// usage: DEVDASH_E2E_TOKEN=<session of a test member> DEVDASH_E2E_ORIGIN=https://space node android/e2e.mjs <apk> <outdir>
// Drives the app's WebView over Chrome DevTools (debug build) and checks the native side with dumpsys and uiautomator.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [apk, out = 'e2e-out'] = process.argv.slice(2)
const TOKEN = process.env.DEVDASH_E2E_TOKEN
const ORIGIN = process.env.DEVDASH_E2E_ORIGIN
if (!apk || !TOKEN || !ORIGIN) throw new Error('usage: DEVDASH_E2E_TOKEN=... DEVDASH_E2E_ORIGIN=... node e2e.mjs <apk> [outdir]')
const HOST = new URL(ORIGIN).host
const PKG = 'io.github.abdvlrqhman.devdash'
const VAULT_PW = 'correct horse battery staple 42'
mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const screenshot = (name) => writeFileSync(join(out, name), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }))
const results = []
const check = (ok, what) => { results.push({ ok, what }); console.log(ok ? '✓' : '✗', what) }
async function until(fn, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch { /* not yet */ } await sleep(500) }
  throw new Error(`timed out: ${label}`)
}
const api = (path, init = {}) => fetch(ORIGIN + path, { ...init, headers: { cookie: `__Host-devdash=${TOKEN}`, origin: ORIGIN, 'content-type': 'application/json', ...init.headers } })

/** A DevTools page session: in the app's WebView (over adb) or in a desktop Chrome. */
async function session(wsUrl, touch = false) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
  const s = {
    send, evaluate,
    text: () => evaluate('document.body ? document.body.innerText : ""'),
    waitFor: (needle, ms = 30000) => until(async () => (await s.text()).includes(needle), ms, `"${needle}"`),
    go: async (path) => { await evaluate(`location.href = ${JSON.stringify(ORIGIN + path)}`); await sleep(2500) },
    type: async (selector, value) => {
      if (!(await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true })()`))) throw new Error(`no ${selector}`)
      await send('Input.insertText', { text: value })
    },
    click: async (label) => {
      const ok = await evaluate(`(() => { const all = [...document.querySelectorAll('button, [role=menuitem], [role=button], [role=option], label, a, li')].filter(e => !e.disabled)
        const el = all.find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})) ?? all.find(e => e.textContent.includes(${JSON.stringify(label)}))
        if (!el) return false; el.click(); return true })()`)
      if (!ok) throw new Error(`no "${label}"`)
      await sleep(500)
    },
    // A press at the button's centre: a finger in the app's WebView (it ignores synthetic mice), a mouse elsewhere.
    press: async (label) => {
      const box = await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      if (!box) throw new Error(`no menu "${label}"`)
      if (touch) {
        // In the app's WebView: the events a press makes, sent to the button itself (Radix menus open on pointerdown,
        // plain buttons on click). Protocol-level input isn't delivered reliably to an Android WebView.
        await evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}));
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
          el.click() })()`)
      } else {
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      await sleep(700)
    },
    close: () => ws.close(),
  }
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setCookie', { name: '__Host-devdash', value: TOKEN, url: `${ORIGIN}/`, secure: true, httpOnly: true, path: '/', sameSite: 'Lax' })
  return s
}

/** The app's WebView, through its DevTools socket (one per process, so look it up again after a restart). */
async function app() {
  const pid = await until(() => adb('shell', 'pidof', PKG).trim(), 60000, 'app process')
  const socket = await until(() => adb('shell', 'cat', '/proc/net/unix').match(new RegExp(`@(webview_devtools_remote_${pid})\\b`))?.[1], 60000, 'WebView DevTools socket')
  adb('forward', '--remove-all')
  adb('forward', 'tcp:9222', `localabstract:${socket}`)
  const page = await until(async () => (await (await fetch('http://127.0.0.1:9222/json')).json()).find((t) => t.type === 'page'), 30000, 'WebView page')
  return session(page.webSocketDebuggerUrl, true)
}

/** Bounds of the first UI element whose text matches, from a uiautomator dump: [x, y] of its centre. */
function find(textRe) {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
  const xml = adb('shell', 'cat', '/sdcard/ui.xml')
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    if (textRe.test(m[1])) return [Math.round((+m[2] + +m[4]) / 2), Math.round((+m[3] + +m[5]) / 2), xml]
  }
  return null
}
const webviewBox = () => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
  // Tauri's WebView is a subclass (RustWebView), so match any class that ends in WebView.
  const m = adb('shell', 'cat', '/sdcard/ui.xml').match(/class="[\w.$]*WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (!m) throw new Error('WebView not found on screen')
  return { x: +m[1], y: +m[2] }
}

async function run() {
  adb('install', '-r', apk)
  adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
  adb('shell', 'cmd', 'uimode', 'night', 'yes')
  adb('logcat', '-c')
  writeFileSync(join(out, 'launch.txt'), adb('shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`))
  await sleep(8000)
  screenshot('0-launch.png')
  const alive = (() => { try { return !!adb('shell', 'pidof', PKG).trim() } catch { return false } })()
  if (!alive) {
    writeFileSync(join(out, 'crash.txt'), adb('logcat', '-d', '-b', 'crash'))
    const nl = String.fromCharCode(10)
    writeFileSync(join(out, 'app-log.txt'), adb('logcat', '-d', '-v', 'time').split(nl).filter((l) => /abdvlrqhman|AndroidRuntime|libc|DEBUG|tauri|Tauri|RustStdout|chromium|WebView/.test(l)).join(nl))
  }

  // Sign-in: the connect screen takes the space; the session cookie is the test member's.
  let w = await app()
  await until(() => w.evaluate(`!!document.querySelector('#host')`), 60000, 'connect screen')
  await w.type('#host', HOST)
  await w.evaluate(`document.querySelector('#connect').requestSubmit()`)
  await until(() => w.evaluate(`location.host === ${JSON.stringify(HOST)} && document.readyState === 'complete'`), 60000, 'the space')
  await w.waitFor('Running now', 60000)
  screenshot('1-home.png')
  check(true, 'the app connects to the space and opens Home, signed in')

  // Background notifications switch on by themselves once notifications are allowed.
  const bg = await until(() => w.evaluate('window.DevDashAndroid?.backgroundNotifications() === true'), 20000, 'background notifications on').catch(() => false)
  const connected = bg && await until(() => adb('shell', 'dumpsys', 'notification', '--noredact').includes('DevDash is connected'), 20000, 'connected notification').catch(() => false)
  check(!!connected, 'background notifications on: "DevDash is connected" is showing')

  // A link opens outside the app, and the app keeps working (opening one used to freeze it until Android closed it).
  await w.evaluate(`window.devdashShell.openExternal('https://example.com/')`)
  await sleep(4000)
  const front = adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity=ActivityRecord\{\S+ \S+ ([\w.]+)\//)?.[1] ?? 'unknown'
  screenshot('1b-link.png')
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  await sleep(3000)
  const frozen = find(/isn't responding|keeps stopping/)
  const answers = await Promise.race([w.evaluate('document.readyState'), sleep(10000).then(() => null)])
  check(front !== PKG && !frozen && answers === 'complete', `a link opens outside the app (in front: ${front}) and the app still responds`)

  // Downloads: a file from the server (Download in the file viewer, as in chat), and one made in the page.
  const name = `e2e-${Date.now()}.txt`
  const up = await api(`/api/files/upload?${new URLSearchParams({ path: `~/${name}`, offset: '0' })}`, { method: 'POST', body: 'downloaded from DevDash', headers: { 'content-type': 'application/octet-stream' } })
  await w.evaluate(`(() => { const a = document.createElement('a'); a.href = '/api/files/download?' + new URLSearchParams({ path: ${JSON.stringify(`~/${name}`)} }); a.download = ${JSON.stringify(name)}; document.body.append(a); a.click(); a.remove() })()`)
  const got = await until(() => adb('shell', 'ls', '/sdcard/Download/').includes(name), 45000, 'downloaded file').catch(() => false)
  screenshot('1c-download.png')
  check(up.ok && !!got, `Download saves a file from the server to the phone's Downloads (${name})`)
  await api('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: `~/${name}` }) })
  const made = `e2e-made-${Date.now()}.txt`
  const saved = await w.evaluate(`(() => { const d = window.DevDashAndroid; const id = d.saveFileStart(${JSON.stringify(made)}, 'text/plain'); return !!id && d.saveFilePiece(id, btoa('made in the page')) && d.saveFileEnd(id) })()`)
  const there = saved && await until(() => adb('shell', 'ls', '/sdcard/Download/').includes(made), 15000, 'saved file').catch(() => false)
  check(!!there, `a file made in the page is saved to Downloads (${made})`)

  // Dark mode: the page and the native picker.
  await w.go('/claude')
  await sleep(1500)
  await w.press('New')
  await sleep(1500)
  screenshot('2a-new-session.png')
  console.log('dialog open:', await w.evaluate(`!!document.querySelector('[role=dialog]')`), 'model button:', await w.evaluate(`document.querySelector('#ns-model')?.textContent ?? null`))
  const model = await until(() => w.evaluate(`(() => { const t = document.querySelector('#ns-model')?.textContent ?? ''; return /Default/.test(t) && t })()`), 60000, 'model picker')
  check(true, `the model picker shows what Default is: "${model}"`)
  const scheme = await w.evaluate(`getComputedStyle(document.documentElement).colorScheme`)
  check(scheme === 'dark', `dark mode reaches native controls (color-scheme: ${scheme})`)
  // A native picker (the project list) opened by a real tap, as a person would.
  const r = await w.evaluate(`(() => { const e = document.querySelector('#ns-project'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, dpr: devicePixelRatio } })()`)
  if (r) {
    await sleep(500)
    const box = webviewBox()
    adb('shell', 'input', 'tap', String(Math.round(box.x + r.x * r.dpr)), String(Math.round(box.y + r.y * r.dpr)))
    await sleep(1500)
    screenshot('2-picker.png')
    const option = find(/^None, its own folder$/)
    check(!!option, 'a native picker opens and its options are readable text (see 2-picker.png)')
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(800)
  } else check(true, 'no native picker on this screen for this member (no projects to choose from)')
  adb('shell', 'input', 'keyevent', 'KEYCODE_ESCAPE')
  await sleep(500)

  // The shared browser inside the app.
  await w.go('/browser')
  await sleep(2000)
  // Start it, or join it if it's already running (or already showing).
  if (!(await w.evaluate(`!!document.querySelector('#dd-browser')`))) await w.click('Start the browser').catch(() => w.click('Join')).catch(() => {})
  const playing = await until(() => w.evaluate(`(() => { const v = document.querySelector('#dd-browser')?.contentDocument?.querySelector('video'); return !!v && !v.paused && v.readyState >= 2 })()`), 120000, 'browser stream').catch(() => false)
  screenshot('3-browser.png')
  check(!!playing, 'the shared browser streams inside the app')

  // Vault: the phone creates it, a computer opens it with the password.
  await w.go('/vault')
  await until(async () => /Set up your vault|Unlock your vault|Personal/.test(await w.text()), 30000, 'vault page')
  if ((await w.text()).includes('Set up your vault')) {
    await w.type('#vp', VAULT_PW)
    await w.type('#vp2', VAULT_PW)
    await w.click('I understand')
    await w.click('Create my vault')
  } else if ((await w.text()).includes('Unlock your vault')) {
    await w.type('input[aria-label="Vault password"]', VAULT_PW)
    await w.click('Unlock')
  }
  await w.waitFor('Personal', 60000)
  await w.press('New')
  await w.click('Login')
  await w.waitFor('New login')
  await w.type('#vi-name', 'Staging DB')
  await w.type('#vi-user', 'admin')
  await w.type('#vi-pw', 's3cret-pass')
  await w.click('Save')
  await w.waitFor('Staging DB')
  screenshot('4-vault-phone.png')
  check(true, 'vault: created on the phone, a login saved')
  const pcDir = mkdtempSync(join(tmpdir(), 'chrome-'))
  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox', '--remote-debugging-port=9333', `--user-data-dir=${pcDir}`, 'about:blank'], { stdio: 'ignore' })
  try {
    const page = await until(async () => (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'), 30000, 'desktop chrome')
    const pc = await session(page.webSocketDebuggerUrl)
    await pc.go('/vault')
    await pc.waitFor('Unlock your vault')
    await pc.type('input[aria-label="Vault password"]', VAULT_PW)
    await pc.click('Unlock')
    await pc.waitFor('Staging DB', 60000)
    await pc.click('Staging DB')
    await pc.waitFor('admin')
    check(true, 'vault: a second device (a computer) unlocks it with the password and reads the same login')
    pc.close()
  } finally { chrome.kill() }

  // Close the app (back out until it leaves), keep the service, then something happens on the server.
  w.close()
  for (let i = 0; i < 25 && adb('shell', 'dumpsys', 'activity', 'activities').includes(`${PKG}/.MainActivity`); i++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(400)
  }
  const closed = !adb('shell', 'dumpsys', 'activity', 'activities').includes(`${PKG}/.MainActivity`)
  const serviceUp = adb('shell', 'dumpsys', 'activity', 'services', PKG).includes('NotifyService')
  check(closed && serviceUp, `app closed (activity gone: ${closed}), background service still running: ${serviceUp}`)
  const sent = await api('/api/notifications/test', { method: 'POST', body: '{}' })
  const arrived = await until(() => adb('shell', 'dumpsys', 'notification', '--noredact').includes('Notifications work'), 30000, 'notification').catch(() => false)
  screenshot('5-closed.png')
  check(sent.ok && !!arrived, 'with the app closed, a notification from the server arrives')

  // Tapping it opens the app on its page.
  adb('shell', 'cmd', 'statusbar', 'expand-notifications')
  await sleep(1500)
  screenshot('6-shade.png')
  const n = find(/Notifications work/)
  if (n) adb('shell', 'input', 'tap', String(n[0]), String(n[1]))
  let landed = false
  if (n) {
    w = await app()
    landed = await until(() => w.evaluate(`location.host === ${JSON.stringify(HOST)} && location.pathname === '/account'`), 60000, 'opened page').catch(() => false)
    screenshot('7-opened.png')
  }
  check(!!landed, 'tapping the notification opens the app on its page (/account)')
}

try {
  await run()
} catch (err) {
  check(false, `stopped: ${err.message}`)
  try { screenshot('error.png') } catch { /* no device */ }
  try {
    writeFileSync(join(out, 'logcat.txt'), adb('logcat', '-d', '-v', 'time', '-t', '4000'))
    writeFileSync(join(out, 'devtools.txt'), adb('shell', 'cat', '/proc/net/unix').split(String.fromCharCode(10)).filter((l) => l.includes('devtools')).join(String.fromCharCode(10)))
  } catch { /* no device */ }
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
