#!/usr/bin/env node
// DevDash Android Computer Use Agent (Termux + local ADB, Tailscale-Only, Zero Dependencies)
// Binds strictly to the phone's Tailscale IPv4 (100.64.0.0/10), accepts requests ONLY from your
// DevDash VPS Tailscale IP with constant-time Bearer token auth, and shuts down immediately if
// Tailscale disconnects on Android.
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CONFIG_PATH = process.argv[2] || path.join(os.homedir(), '.devdash-android', 'config.json')
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found at ${CONFIG_PATH}`)
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const PORT = Number(config.port) || 47822
const ALLOWED_PEER_IP = String(config.vpsTailscaleIp || '').trim()
const TOKEN = String(config.token || '')
let allowShell = Boolean(config.allowShell)
let paused = false
let elementMap = new Map()
let adbTarget = String(config.adbTarget || '').trim()

function isTailscaleIp(ip) {
  const parts = String(ip || '').split('.')
  if (parts.length !== 4) return false
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  return !n.some((x) => x < 0 || x > 255) && n[0] === 100 && n[1] >= 64 && n[1] <= 127
}

function getLiveTailscaleIp() {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal && isTailscaleIp(addr.address)) {
        return addr.address
      }
    }
  }
  return null
}

function normalizeRemoteIp(raw) {
  const s = String(raw || '').trim()
  return s.startsWith('::ffff:') ? s.slice(7) : s
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function runCmd(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: opts.timeout ?? 20_000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    encoding: opts.encoding ?? 'utf8',
    cwd: opts.cwd,
  })
  return { stdout, stderr }
}

async function resolveAdbSerial() {
  try {
    const { stdout } = await runCmd('adb', ['devices'], { timeout: 5_000 })
    const lines = stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
    const ready = lines
      .map((l) => l.split(/\s+/))
      .filter((p) => p.length >= 2 && p[1] === 'device')
      .map((p) => p[0])
    if (ready.length > 0) {
      if (adbTarget && ready.includes(adbTarget)) return adbTarget
      adbTarget = ready[0]
      return adbTarget
    }
    // Try reconnecting to saved loopback target if present
    if (adbTarget) {
      await runCmd('adb', ['connect', adbTarget], { timeout: 5_000 }).catch(() => {})
      const { stdout: out2 } = await runCmd('adb', ['devices'], { timeout: 5_000 })
      const ok = out2.split(/\r?\n/).some((l) => l.includes(adbTarget) && l.includes('\tdevice'))
      if (ok) return adbTarget
    }
  } catch {}
  return null
}

async function adbShell(cmdStr, timeout = 15_000) {
  const serial = await resolveAdbSerial()
  if (!serial) {
    throw new Error('ADB is not connected on this phone. Run ~/.devdash-android/pair-adb.sh in Termux with Wireless Debugging enabled.')
  }
  const { stdout } = await runCmd('adb', ['-s', serial, 'shell', cmdStr], { timeout })
  return stdout
}

async function adbExecOut(args, timeout = 15_000) {
  const serial = await resolveAdbSerial()
  if (!serial) {
    throw new Error('ADB is not connected on this phone. Run ~/.devdash-android/pair-adb.sh in Termux with Wireless Debugging enabled.')
  }
  const { stdout } = await execFileAsync('adb', ['-s', serial, 'exec-out', ...args], {
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'buffer',
  })
  return stdout
}

async function getScreenSize() {
  try {
    const out = await adbShell('wm size', 5_000)
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) || /Physical size:\s*(\d+)x(\d+)/.exec(out)
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  } catch {}
  return { width: 1080, height: 2340 }
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseUiXml(xml, maxElements = 140) {
  const elements = []
  const nodeRe = /<node\s+([^>]+?)\/?>/g
  let match
  let idx = 0
  while ((match = nodeRe.exec(xml)) !== null && elements.length < maxElements) {
    const attrs = {}
    const attrRe = /([a-zA-Z0-9_:-]+)="([^"]*)"/g
    let am
    while ((am = attrRe.exec(match[1])) !== null) {
      attrs[am[1]] = unescapeXml(am[2])
    }
    const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '')
    if (!bm) continue
    const x1 = Number(bm[1]), y1 = Number(bm[2]), x2 = Number(bm[3]), y2 = Number(bm[4])
    const width = x2 - x1, height = y2 - y1
    if (width < 2 || height < 2) continue
    const text = (attrs.text || '').trim()
    const desc = (attrs['content-desc'] || '').trim()
    const clickable = attrs.clickable === 'true'
    const editable = /EditText|AutoCompleteTextView/i.test(attrs.class || '')
    const scrollable = attrs.scrollable === 'true'
    const interesting = clickable || editable || scrollable || text.length > 0 || desc.length > 0
    if (!interesting) continue

    idx++
    const role = (attrs.class || 'View').split('.').pop() || 'View'
    const resId = (attrs['resource-id'] || '').split('/').pop() || ''
    const el = {
      id: `e${idx}`,
      role,
      name: (text || desc || resId).slice(0, 160),
      ...(resId ? { automationId: resId } : {}),
      ...(desc && desc !== text ? { description: desc.slice(0, 120) } : {}),
      clickable,
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      bounds: { x: x1, y: y1, width, height },
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
    }
    elements.push(el)
  }
  return elements
}

function resolvePoint(body) {
  if (body?.elementId && elementMap.has(String(body.elementId))) {
    const el = elementMap.get(String(body.elementId))
    return { x: el.center.x, y: el.center.y }
  }
  if (body?.x === undefined || body?.y === undefined) {
    throw new Error('Provide either (x, y) coordinates or a valid elementId from pc_get_window_state.')
  }
  return { x: Math.round(Number(body.x)), y: Math.round(Number(body.y)) }
}

const KEY_MAP = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recents: 'KEYCODE_APP_SWITCH',
  app_switch: 'KEYCODE_APP_SWITCH',
  overview: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  return: 'KEYCODE_ENTER',
  escape: 'KEYCODE_ESCAPE',
  esc: 'KEYCODE_ESCAPE',
  backspace: 'KEYCODE_DEL',
  del: 'KEYCODE_DEL',
  delete: 'KEYCODE_FORWARD_DEL',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  power: 'KEYCODE_POWER',
  wake: 'KEYCODE_WAKEUP',
  wakeup: 'KEYCODE_WAKEUP',
  sleep: 'KEYCODE_SLEEP',
  volumeup: 'KEYCODE_VOLUME_UP',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  mute: 'KEYCODE_VOLUME_MUTE',
  camera: 'KEYCODE_CAMERA',
  search: 'KEYCODE_SEARCH',
  menu: 'KEYCODE_MENU',
  paste: 'KEYCODE_PASTE',
  copy: 'KEYCODE_COPY',
  cut: 'KEYCODE_CUT',
  'ctrl+v': 'KEYCODE_PASTE',
  'ctrl+c': 'KEYCODE_COPY',
  'ctrl+x': 'KEYCODE_CUT',
}

function shellEscapeSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

async function captureScreenshot() {
  const [pngBuf, size] = await Promise.all([
    adbExecOut(['screencap', '-p'], 20_000),
    getScreenSize(),
  ])
  if (!pngBuf || pngBuf.length < 100) throw new Error('Failed to capture Android screen via adb screencap.')
  return {
    ok: true,
    originX: 0,
    originY: 0,
    screenWidth: size.width,
    screenHeight: size.height,
    imageWidth: size.width,
    imageHeight: size.height,
    scaleX: 1,
    scaleY: 1,
    cursorX: 0,
    cursorY: 0,
    mimeType: 'image/png',
    screenshotBase64: pngBuf.toString('base64'),
  }
}

async function handleAction(method, urlPath, body) {
  if (urlPath === '/health' && method === 'GET') {
    const liveIp = getLiveTailscaleIp()
    const serial = await resolveAdbSerial()
    let model = os.hostname()
    let androidVer = ''
    let battery = null
    let size = { width: 1080, height: 2340 }
    if (serial) {
      try {
        model = (await adbShell('getprop ro.product.model', 3_000)).trim() || model
        androidVer = (await adbShell('getprop ro.build.version.release', 3_000)).trim()
        size = await getScreenSize()
        const batOut = await adbShell('dumpsys battery', 3_000)
        const lvl = /level:\s*(\d+)/.exec(batOut)
        if (lvl) battery = Number(lvl[1])
      } catch {}
    }
    return {
      ok: true,
      platform: 'android',
      hostname: model,
      os: androidVer ? `Android ${androidVer}` : 'Android (Termux)',
      tailscaleIp: liveIp,
      tailscaleConnected: Boolean(liveIp),
      adbReady: Boolean(serial),
      adbTarget: serial || null,
      battery,
      paused,
      allowShell,
      monitors: [{ index: 0, deviceName: 'Android Display', primary: true, x: 0, y: 0, width: size.width, height: size.height }],
      cursor: { x: 0, y: 0 },
      version: '1.0.0-android',
    }
  }

  if (paused) throw new Error('Android control is currently paused on the phone.')
  if (!getLiveTailscaleIp()) throw new Error('Tailscale is disconnected on the phone.')

  switch (urlPath) {
    case '/v1/monitors': {
      const size = await getScreenSize()
      return { ok: true, monitors: [{ index: 0, deviceName: 'Android Display', primary: true, x: 0, y: 0, width: size.width, height: size.height }] }
    }
    case '/v1/apps': {
      const out = await adbShell('pm list packages -3', 10_000)
      const apps = out
        .split(/\r?\n/)
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean)
        .sort()
        .slice(0, 150)
        .map((pkg) => ({ name: pkg, package: pkg }))
      return { ok: true, apps }
    }
    case '/v1/windows': {
      const out = await adbShell('dumpsys window displays | grep -E "mCurrentFocus|mFocusedApp"', 8_000).catch(() => '')
      const windows = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => ({
          hwnd: String(i + 1),
          process: (/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/.exec(line)?.[1]) || 'android',
          title: line.slice(0, 160),
          focused: line.includes('mCurrentFocus'),
          minimized: false,
        }))
      return { ok: true, windows }
    }
    case '/v1/window_state': {
      const includeScreenshot = body?.includeScreenshot !== false
      const maxElements = Number(body?.maxElements) || 140
      let xml = ''
      try {
        await adbShell('uiautomator dump /sdcard/.devdash_ui.xml >/dev/null 2>&1', 12_000)
        xml = await adbShell('cat /sdcard/.devdash_ui.xml', 8_000)
      } catch {
        xml = ''
      }
      const elements = parseUiXml(xml, maxElements)
      elementMap = new Map(elements.map((e) => [e.id, e]))
      const focusOut = await adbShell('dumpsys window | grep mCurrentFocus', 5_000).catch(() => '')
      const res = {
        ok: true,
        platform: 'android',
        window: { title: focusOut.trim() || 'Android Screen', focused: true },
        elements,
        elementCount: elements.length,
      }
      if (includeScreenshot) {
        Object.assign(res, await captureScreenshot())
      }
      return res
    }
    case '/v1/screenshot':
      return captureScreenshot()
    case '/v1/window_action': {
      const action = String(body?.action || 'focus')
      if (action === 'minimize' || action === 'close') {
        await adbShell(`input keyevent ${action === 'close' ? 'KEYCODE_BACK' : 'KEYCODE_HOME'}`)
        return { ok: true, action }
      }
      if (action === 'focus' && body?.title) {
        await adbShell(`monkey -p ${shellEscapeSingle(body.title)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`)
        return { ok: true, action, target: body.title }
      }
      return { ok: true, action }
    }
    case '/v1/launch_app': {
      const target = String(body?.target || '').trim()
      if (!target) throw new Error('Provide an Android package name (e.g. com.android.chrome) or URL (https://...).')
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
        await adbShell(`am start -a android.intent.action.VIEW -d ${shellEscapeSingle(target)}`)
      } else {
        await adbShell(`monkey -p ${shellEscapeSingle(target)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`)
      }
      return { ok: true, target }
    }
    case '/v1/kill_app': {
      const pkg = String(body?.name || '').trim()
      if (!pkg) throw new Error('Provide the Android package name to force-stop.')
      await adbShell(`am force-stop ${shellEscapeSingle(pkg)}`)
      return { ok: true, name: pkg }
    }
    case '/v1/click': {
      const pt = resolvePoint(body)
      const btn = String(body?.button || 'left')
      const clicks = Math.max(1, Math.min(3, Number(body?.clicks) || 1))
      if (btn === 'right') {
        // Right-click maps to long-press on Android touchscreen
        await adbShell(`input swipe ${pt.x} ${pt.y} ${pt.x} ${pt.y} 700`)
        return { ok: true, x: pt.x, y: pt.y, gesture: 'long_press' }
      }
      for (let i = 0; i < clicks; i++) {
        await adbShell(`input tap ${pt.x} ${pt.y}`)
      }
      return { ok: true, x: pt.x, y: pt.y, clicks }
    }
    case '/v1/move_mouse': {
      const pt = resolvePoint(body)
      return { ok: true, x: pt.x, y: pt.y, note: 'Touchscreen device (no hover cursor)' }
    }
    case '/v1/drag': {
      const x1 = Math.round(Number(body.x1)), y1 = Math.round(Number(body.y1))
      const x2 = Math.round(Number(body.x2)), y2 = Math.round(Number(body.y2))
      const dur = Math.min(Math.max((Number(body.steps) || 20) * 18, 150), 2000)
      await adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`)
      return { ok: true, x1, y1, x2, y2, durationMs: dur }
    }
    case '/v1/scroll': {
      const size = await getScreenSize()
      const cx = body?.x !== undefined ? Math.round(Number(body.x)) : Math.round(size.width / 2)
      const cy = body?.y !== undefined ? Math.round(Number(body.y)) : Math.round(size.height / 2)
      const dy = body?.deltaY !== undefined ? Number(body.deltaY) : -3
      const dx = body?.deltaX !== undefined ? Number(body.deltaX) : 0
      const distY = Math.round(Math.min(Math.abs(dy) * 140, size.height * 0.55)) * (dy < 0 ? -1 : 1)
      const distX = Math.round(Math.min(Math.abs(dx) * 140, size.width * 0.55)) * (dx < 0 ? -1 : 1)
      const x2 = Math.max(20, Math.min(size.width - 20, cx + distX))
      const y2 = Math.max(80, Math.min(size.height - 80, cy + distY))
      await adbShell(`input swipe ${cx} ${cy} ${x2} ${y2} 280`)
      return { ok: true, from: { x: cx, y: cy }, to: { x: x2, y: y2 } }
    }
    case '/v1/type_text': {
      if (body?.elementId && elementMap.has(String(body.elementId))) {
        const el = elementMap.get(String(body.elementId))
        await adbShell(`input tap ${el.center.x} ${el.center.y}`)
      }
      const text = String(body?.text || '')
      if (text) {
        if (/^[\x20-\x7E]+$/.test(text)) {
          // Safe ASCII via `adb shell input text` (spaces become %s)
          const escaped = text.replace(/([\\"'`$&|;<>()?*~\[\]{}!#])/g, '\\$1').replace(/ /g, '%s')
          await adbShell(`input text ${escaped}`)
        } else {
          // Unicode/Arabic/emoji fallback via termux-clipboard-set + KEYCODE_PASTE
          await runCmd('termux-clipboard-set', [text], { timeout: 5_000 })
          await adbShell('input keyevent KEYCODE_PASTE')
        }
      }
      if (body?.enter) await adbShell('input keyevent KEYCODE_ENTER')
      return { ok: true, length: text.length }
    }
    case '/v1/set_value': {
      const pt = resolvePoint(body)
      await adbShell(`input tap ${pt.x} ${pt.y}`)
      await adbShell('input keyevent KEYCODE_MOVE_END')
      // Clear existing text safely via Ctrl+A + DEL (supported on Android 11+ via keycombination)
      await adbShell('input keycombination 113 29 && input keyevent KEYCODE_DEL').catch(() => {})
      const val = String(body?.value || '')
      if (val) {
        if (/^[\x20-\x7E]+$/.test(val)) {
          const escaped = val.replace(/([\\"'`$&|;<>()?*~\[\]{}!#])/g, '\\$1').replace(/ /g, '%s')
          await adbShell(`input text ${escaped}`)
        } else {
          await runCmd('termux-clipboard-set', [val], { timeout: 5_000 })
          await adbShell('input keyevent KEYCODE_PASTE')
        }
      }
      if (body?.enter) await adbShell('input keyevent KEYCODE_ENTER')
      return { ok: true, x: pt.x, y: pt.y }
    }
    case '/v1/press_key': {
      const raw = String(body?.key || '').trim()
      const k = raw.toLowerCase().replace(/\s+/g, '')
      if (k === 'notifications' || k === 'shade') {
        await adbShell('cmd statusbar expand-notifications')
        return { ok: true, key: raw }
      }
      if (k === 'quicksettings' || k === 'qs') {
        await adbShell('cmd statusbar expand-settings')
        return { ok: true, key: raw }
      }
      if (k === 'collapse') {
        await adbShell('cmd statusbar collapse')
        return { ok: true, key: raw }
      }
      const code = KEY_MAP[k] || (/^KEYCODE_[A-Z0-9_]+$/i.test(raw) ? raw.toUpperCase() : null)
      if (!code) throw new Error(`Unknown Android key: ${raw}. Try Home, Back, Recents, Enter, Backspace, Wake, Power, Notifications, QuickSettings, VolumeUp, VolumeDown.`)
      await adbShell(`input keyevent ${code}`)
      return { ok: true, key: code }
    }
    case '/v1/clipboard': {
      if (body?.mode === 'set') {
        await runCmd('termux-clipboard-set', [String(body.text || '')], { timeout: 5_000 })
        return { ok: true, mode: 'set' }
      }
      const { stdout } = await runCmd('termux-clipboard-get', [], { timeout: 5_000 })
      return { ok: true, mode: 'get', text: stdout }
    }
    case '/v1/powershell': {
      if (!allowShell) throw new Error('Shell access is disabled on this Android device.')
      const command = String(body?.command || '').trim()
      if (!command) throw new Error('Missing command.')
      const timeoutMs = Math.min(Math.max((Number(body?.timeoutSec) || 30) * 1000, 2_000), 90_000)
      if (command.startsWith('adb:')) {
        const out = await adbShell(command.slice(4).trim(), timeoutMs)
        return { ok: true, exitCode: 0, stdout: out.slice(0, 65536), stderr: '' }
      }
      try {
        const { stdout, stderr } = await runCmd('sh', ['-c', command], { timeout: timeoutMs, cwd: body?.cwd })
        return { ok: true, exitCode: 0, stdout: stdout.slice(0, 65536), stderr: stderr.slice(0, 32768) }
      } catch (err) {
        return {
          ok: false,
          exitCode: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout || '').slice(0, 65536),
          stderr: String(err.stderr || err.message || '').slice(0, 32768),
        }
      }
    }
    case '/v1/fs': {
      const mode = String(body?.mode || '')
      const target = String(body?.path || '')
      if (!target) throw new Error('Missing path.')
      if (mode === 'list') {
        const names = fs.readdirSync(target).slice(0, 200)
        const entries = names.map((name) => {
          const full = path.join(target, name)
          const st = fs.statSync(full)
          return { name, path: full, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString() }
        })
        return { ok: true, path: target, entries }
      }
      if (mode === 'read') {
        const maxBytes = Math.min(Number(body?.maxBytes) || 131072, 524288)
        const buf = fs.readFileSync(target)
        const truncated = buf.length > maxBytes
        return { ok: true, path: target, size: buf.length, truncated, content: buf.subarray(0, maxBytes).toString('utf8') }
      }
      if (mode === 'write') {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const text = String(body?.content || '')
        fs.writeFileSync(target, text, 'utf8')
        return { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8') }
      }
      throw new Error(`Unknown fs mode: ${mode}`)
    }
    default:
      throw new Error(`Unknown endpoint: ${urlPath}`)
  }
}

function sendJson(res, status, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, Connection: 'close' })
  res.end(payload)
}

function createServer() {
  return http.createServer((req, res) => {
    const remote = normalizeRemoteIp(req.socket.remoteAddress)
    if (ALLOWED_PEER_IP && remote !== ALLOWED_PEER_IP) {
      log(`REJECTED unauthorized remote IP: ${remote}`)
      return sendJson(res, 403, { ok: false, error: 'Unauthorized peer IP.' })
    }
    const auth = req.headers.authorization || ''
    if (!safeEqual(auth, `Bearer ${TOKEN}`)) {
      log(`REJECTED invalid bearer token from ${remote}`)
      return sendJson(res, 401, { ok: false, error: 'Invalid token.' })
    }
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total <= 8 * 1024 * 1024) chunks.push(c)
    })
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        const body = raw ? JSON.parse(raw) : {}
        const urlPath = (req.url || '/health').split('?')[0]
        const result = await handleAction((req.method || 'GET').toUpperCase(), urlPath, body)
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  })
}

let server = null
let boundIp = null

function syncListener() {
  const live = getLiveTailscaleIp()
  if (!live) {
    if (server) {
      log('Tailscale disconnected on Android! Stopping listener immediately.')
      server.close()
      server = null
      boundIp = null
    }
    return
  }
  if (live !== boundIp || !server) {
    if (server) server.close()
    server = createServer()
    server.on('error', (err) => log(`Listener error: ${err.message}`))
    server.listen(PORT, live, () => {
      boundIp = live
      log(`Listening strictly on Tailscale ${live}:${PORT} (allowed peer: ${ALLOWED_PEER_IP})`)
    })
  }
}

syncListener()
setInterval(syncListener, 5_000)
