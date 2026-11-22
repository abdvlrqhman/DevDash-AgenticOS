#!/usr/bin/env node
// DevDash Multi-Device Computer Use MCP server (Windows PC + Android Phone, stdio JSON-RPC 2.0).
// Zero external dependencies, zero secrets in provider configs: every call routes through this member's
// DevDash agent Unix socket → DevDash server → Tailscale online gate → Tailscale SOCKS5 proxy → device agent.
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { createInterface } from 'node:readline'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET || `/run/devdash/agent-${process.env.USER || userInfo().username}.sock`
const deviceProp = {
  type: 'string',
  description: 'Optional target device selector: device name (e.g. "DESKTOP-LGSA21G" or "Kensei\'s A36"), platform ("windows" or "android"), or Tailscale IP. Omit to use the default device.',
}
const obj = (properties, required = [], withDevice = true) => ({
  type: 'object',
  properties: withDevice ? { device: deviceProp, ...properties } : properties,
  required,
  additionalProperties: false,
})

const TOOLS = [
  {
    name: 'pc_list_devices',
    description: 'List all paired Tailscale devices (Windows PC and/or Android phone) with their platform, Tailscale IP, enabled state, default flag, and live Tailscale online status. Call this first when choosing between PC and phone.',
    inputSchema: obj({}, [], false),
  },
  {
    name: 'pc_status',
    description: 'Check the target Windows PC or Android phone health over Tailscale: hostname/model, OS, Tailscale IP, battery (Android), displays, ADB status (Android), paused/kill-switch state, and shell access.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_monitors',
    description: 'List connected displays on the Windows PC or Android phone with coordinate bounds (x, y, width, height).',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_apps',
    description: 'List running apps on Windows (with PID/memory) or installed user app packages on Android.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_windows',
    description: 'List visible desktop windows on Windows (hwnd, pid, process, title, bounds) or current focused app/window on Android.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_get_window_state',
    description: 'Codex-style hybrid inspection: captures BOTH the live accessibility/UI tree (Windows UI Automation or Android uiautomator XML with clickable elementIds e1, e2, ..., roles, names, bounds) AND a visual screenshot.',
    inputSchema: obj({
      hwnd: { type: 'string', description: 'Windows hwnd from pc_list_windows (optional; ignored on Android).' },
      includeScreenshot: { type: 'boolean', description: 'Include screenshot image (default true).' },
      fullScreen: { type: 'boolean', description: 'Capture full screen instead of window crop on Windows (default false).' },
      maxWidth: { type: 'integer', description: 'Max screenshot width in px on Windows (default 1280).' },
      quality: { type: 'integer', description: 'JPEG quality 30-95 on Windows (default 72).' },
      maxElements: { type: 'integer', description: 'Max UI elements to extract (default 140).' },
    }),
  },
  {
    name: 'pc_screenshot',
    description: 'Take a visual screenshot of the Windows desktop or Android phone screen with exact coordinate mapping.',
    inputSchema: obj({
      monitor: { type: 'integer', description: 'Monitor index on Windows (omit for full screen).' },
      hwnd: { type: 'string', description: 'Optional Windows hwnd.' },
      maxWidth: { type: 'integer', description: 'Max image width in px on Windows (default 1280).' },
      quality: { type: 'integer', description: 'JPEG quality 30-95 on Windows (default 72).' },
      drawCursor: { type: 'boolean', description: 'Overlay cursor marker on Windows (default true).' },
    }),
  },
  {
    name: 'pc_window_action',
    description: 'Focus, minimize, maximize, restore, close, or move/resize a window (on Android: focus launches a package, minimize presses Home, close presses Back).',
    inputSchema: obj({
      action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close', 'move_resize'] },
      hwnd: { type: 'string', description: 'Windows hwnd from pc_list_windows.' },
      title: { type: 'string', description: 'Partial window title/process on Windows, or Android package name.' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    }, ['action']),
  },
  {
    name: 'pc_launch_app',
    description: 'Launch an app or URL: executable/file/URL on Windows (e.g. "chrome", "code", "https://...") or package name/URL on Android (e.g. "com.android.chrome", "https://...").',
    inputSchema: obj({
      target: { type: 'string', description: 'App executable/package name, file path, or URL.' },
      args: { type: 'string', description: 'Optional arguments (Windows).' },
      cwd: { type: 'string', description: 'Optional working directory (Windows).' },
    }, ['target']),
  },
  {
    name: 'pc_kill_app',
    description: 'Stop a running app: by pid or process name on Windows, or force-stop package name on Android.',
    inputSchema: obj({
      pid: { type: 'integer', description: 'Windows process ID.' },
      name: { type: 'string', description: 'Windows process name without .exe, or Android package name.' },
    }),
  },
  {
    name: 'pc_click',
    description: 'Click (Windows) or tap (Android) by screen coordinates (x, y) or UI elementId (e.g. "e12") from pc_get_window_state. Use button:"right" for right-click on Windows or long-press on Android.',
    inputSchema: obj({
      elementId: { type: 'string', description: 'UI element ID from pc_get_window_state (preferred when available).' },
      x: { type: 'integer', description: 'Native screen X pixel coordinate.' },
      y: { type: 'integer', description: 'Native screen Y pixel coordinate.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (right = long-press on Android).' },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: '1=single, 2=double, 3=triple.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Optional Windows modifier keys (e.g. ["ctrl"]).' },
    }),
  },
  {
    name: 'pc_move_mouse',
    description: 'Move mouse cursor to (x, y) or elementId on Windows without clicking.',
    inputSchema: obj({
      elementId: { type: 'string' },
      x: { type: 'integer' },
      y: { type: 'integer' },
    }),
  },
  {
    name: 'pc_drag',
    description: 'Drag (Windows) or touch-swipe (Android) smoothly from (x1, y1) to (x2, y2).',
    inputSchema: obj({
      x1: { type: 'integer' },
      y1: { type: 'integer' },
      x2: { type: 'integer' },
      y2: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right'] },
      steps: { type: 'integer', minimum: 5, maximum: 60 },
    }, ['x1', 'y1', 'x2', 'y2']),
  },
  {
    name: 'pc_scroll',
    description: 'Scroll vertically (deltaY: negative = scroll down, positive = scroll up) or horizontally (deltaX). Uses mouse wheel on Windows and touch swipe on Android.',
    inputSchema: obj({
      deltaY: { type: 'integer', description: 'Vertical scroll notches (negative = down, positive = up; default -3).' },
      deltaX: { type: 'integer', description: 'Horizontal scroll notches.' },
      x: { type: 'integer' },
      y: { type: 'integer' },
    }),
  },
  {
    name: 'pc_type_text',
    description: 'Type text into the active input (or click/tap elementId first), optionally pressing Enter afterward.',
    inputSchema: obj({
      text: { type: 'string', description: 'Text to type (supports Unicode).' },
      elementId: { type: 'string', description: 'Optional UI elementId to focus before typing.' },
      enter: { type: 'boolean', description: 'Press Enter after typing (default false).' },
    }, ['text']),
  },
  {
    name: 'pc_set_value',
    description: 'Replace the value of an input field (taps/clicks target, selects all, types new value).',
    inputSchema: obj({
      elementId: { type: 'string' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      value: { type: 'string' },
      enter: { type: 'boolean' },
    }, ['value']),
  },
  {
    name: 'pc_press_key',
    description: 'Press a key or shortcut. Windows: "Enter", "Escape", "Ctrl+C", "Win+R", "Alt+Tab", "Ctrl+Shift+Esc". Android: "Home", "Back", "Recents", "Notifications", "QuickSettings", "Wake", "Power", "VolumeUp", "VolumeDown", "Enter", "Backspace".',
    inputSchema: obj({
      key: { type: 'string', description: 'Key name or hotkey chord.' },
    }, ['key']),
  },
  {
    name: 'pc_clipboard',
    description: 'Read or write plain text on the Windows or Android clipboard.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['get', 'set'] },
      text: { type: 'string', description: 'Text to copy when mode is "set".' },
    }, ['mode']),
  },
  {
    name: 'pc_run_powershell',
    description: 'Run a shell command on the device: PowerShell on Windows, or Termux sh (or prefix with "adb:" for adb shell) on Android. Requires shell access enabled.',
    inputSchema: obj({
      command: { type: 'string', description: 'PowerShell command (Windows) or sh / "adb:..." command (Android).' },
      cwd: { type: 'string', description: 'Optional working directory.' },
      timeoutSec: { type: 'integer', minimum: 2, maximum: 90, description: 'Timeout in seconds (default 30).' },
    }, ['command']),
  },
  {
    name: 'pc_fs',
    description: 'Direct filesystem access on Windows (e.g. C:\\Users\\...) or Android (e.g. /sdcard/Download): list directory, read UTF-8 file, or write file.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['list', 'read', 'write'] },
      path: { type: 'string', description: 'Absolute path on the target device.' },
      content: { type: 'string', description: 'File contents when mode is "write".' },
      maxBytes: { type: 'integer', description: 'Max bytes to read when mode is "read" (default 131072).' },
    }, ['mode', 'path']),
  },
  {
    name: 'pc_wait',
    description: 'Wait for a short delay and optionally take a fresh screenshot afterward.',
    inputSchema: obj({
      ms: { type: 'integer', minimum: 100, maximum: 15000, description: 'Delay in milliseconds (default 1000).' },
      screenshot: { type: 'boolean', description: 'Capture a fresh screenshot after waiting.' },
      maxWidth: { type: 'integer' },
    }),
  },
]

function call(method, params) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET)
    let buf = ''
    let settled = false
    const done = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(val)
    }
    const timer = setTimeout(() => done(new Error('DevDash device bridge timed out.')), 115_000)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const m = JSON.parse(buf.slice(0, i))
        if (m.error) done(new Error(m.error))
        else done(null, m.result)
      } catch {
        done(new Error('DevDash returned an unreadable response.'))
      }
    })
    sock.on('error', (err) => done(new Error(`DevDash agent socket unavailable (${SOCKET}): ${err.message}`)))
    sock.on('close', () => done(new Error('DevDash agent closed the connection.')))
  })
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(m) {
  switch (m.method) {
    case 'initialize':
      return {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'devdash-pc', version: '1.1.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = m.params?.name
      if (!TOOLS.some((t) => t.name === name)) {
        throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 })
      }
      try {
        const result = await call('mcp.pc_tool', { tool: name, args: m.params?.arguments ?? {} })
        const content = []
        if (result && typeof result === 'object' && typeof result.screenshotBase64 === 'string') {
          const { screenshotBase64, mimeType, ...meta } = result
          content.push({
            type: 'image',
            data: screenshotBase64,
            mimeType: typeof mimeType === 'string' ? mimeType : 'image/jpeg',
          })
          content.push({ type: 'text', text: JSON.stringify(meta, null, 2) })
        } else {
          content.push({ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) })
        }
        return { content }
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = 0
let closed = false
const maybeExit = () => { if (closed && !pending) process.exit(0) }
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (m.id === undefined || m.id === null) return
  pending++
  try {
    send({ jsonrpc: '2.0', id: m.id, result: await handle(m) })
  } catch (err) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: err.message } })
  } finally {
    pending--
    maybeExit()
  }
})
rl.on('close', () => { closed = true; maybeExit() })
