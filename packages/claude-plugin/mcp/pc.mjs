#!/usr/bin/env node
// DevDash PC Computer Use MCP server (stdio JSON-RPC 2.0).
// Zero external dependencies, zero secrets in provider configs: every call routes through this member's
// DevDash agent Unix socket → DevDash server → Tailscale online gate → Tailscale SOCKS5 proxy → Windows PC agent.
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { createInterface } from 'node:readline'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET || `/run/devdash/agent-${process.env.USER || userInfo().username}.sock`
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  {
    name: 'pc_status',
    description: 'Check the paired Windows PC health over Tailscale: hostname, OS, Tailscale IP, monitors, cursor position, paused/kill-switch state, and whether PowerShell access is enabled.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_monitors',
    description: 'List all connected monitors on the Windows PC with their indices, primary flag, and desktop coordinate bounds (x, y, width, height).',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_apps',
    description: 'List running Windows applications/processes with PID, process name, window title, executable path, and memory usage.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_list_windows',
    description: 'Enumerate all visible top-level Windows desktop windows (hwnd, pid, process, title, bounds, focused, minimized, maximized). Call this first to find windows before focusing or inspecting them.',
    inputSchema: obj({}),
  },
  {
    name: 'pc_get_window_state',
    description: 'Codex-style hybrid inspection: captures BOTH the structured Windows UI Automation (UIA) interactive element tree (with clickable elementIds e1, e2, ..., roles, names, values, and screen bounds) AND a visual screenshot of the active or target window.',
    inputSchema: obj({
      hwnd: { type: 'string', description: 'Window handle from pc_list_windows. Omit to inspect the active foreground window.' },
      includeScreenshot: { type: 'boolean', description: 'Include screenshot image (default true).' },
      fullScreen: { type: 'boolean', description: 'Capture full screen instead of cropping to the window (default false).' },
      maxWidth: { type: 'integer', description: 'Max screenshot width in px (default 1280).' },
      quality: { type: 'integer', description: 'JPEG quality 30-95 (default 72).' },
      maxElements: { type: 'integer', description: 'Max UIA elements to extract (default 140).' },
    }),
  },
  {
    name: 'pc_screenshot',
    description: 'Take a visual screenshot of the Windows desktop (full virtual screen, a specific monitor index, or a specific window hwnd) with cursor indicator and exact screen coordinate mapping.',
    inputSchema: obj({
      monitor: { type: 'integer', description: 'Monitor index from pc_list_monitors (omit for full virtual screen).' },
      hwnd: { type: 'string', description: 'Optional window hwnd to capture only that window.' },
      maxWidth: { type: 'integer', description: 'Max image width in px (default 1280).' },
      quality: { type: 'integer', description: 'JPEG quality 30-95 (default 72).' },
      drawCursor: { type: 'boolean', description: 'Overlay current cursor marker (default true).' },
    }),
  },
  {
    name: 'pc_window_action',
    description: 'Focus, minimize, maximize, restore, close, or move/resize a Windows window by hwnd or partial title/process match.',
    inputSchema: obj({
      action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close', 'move_resize'] },
      hwnd: { type: 'string', description: 'Window handle from pc_list_windows.' },
      title: { type: 'string', description: 'Partial window title or process name if hwnd is omitted.' },
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    }, ['action']),
  },
  {
    name: 'pc_launch_app',
    description: 'Launch any Windows app, executable, URL, ms-settings URI, folder, or file (e.g. "chrome", "notepad.exe", "code", "https://...", "ms-settings:network").',
    inputSchema: obj({
      target: { type: 'string', description: 'Executable, command, file path, or URL to open.' },
      args: { type: 'string', description: 'Optional command-line arguments.' },
      cwd: { type: 'string', description: 'Optional working directory.' },
    }, ['target']),
  },
  {
    name: 'pc_kill_app',
    description: 'Terminate a Windows process by PID or process name.',
    inputSchema: obj({
      pid: { type: 'integer', description: 'Process ID to kill.' },
      name: { type: 'string', description: 'Process name without .exe (e.g. "notepad").' },
    }),
  },
  {
    name: 'pc_click',
    description: 'Click on the Windows screen either by screen pixel coordinates (x, y) or by UIA elementId (e.g. "e12") from the latest pc_get_window_state.',
    inputSchema: obj({
      elementId: { type: 'string', description: 'UIA element ID from pc_get_window_state (preferred when available).' },
      x: { type: 'integer', description: 'Native screen X pixel coordinate.' },
      y: { type: 'integer', description: 'Native screen Y pixel coordinate.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left").' },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: 'Number of clicks: 1=single, 2=double, 3=triple.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Optional modifier keys held during click (e.g. ["ctrl"], ["shift"]).' },
    }),
  },
  {
    name: 'pc_move_mouse',
    description: 'Move the mouse cursor to (x, y) or to a UIA elementId without clicking (useful for hover menus/tooltips).',
    inputSchema: obj({
      elementId: { type: 'string' },
      x: { type: 'integer' },
      y: { type: 'integer' },
    }),
  },
  {
    name: 'pc_drag',
    description: 'Drag the mouse smoothly from (x1, y1) to (x2, y2) for drag-and-drop, sliders, text selection, or window resizing.',
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
    description: 'Scroll the mouse wheel vertically (deltaY: negative scrolls down, positive scrolls up) or horizontally (deltaX), optionally moving to (x, y) first.',
    inputSchema: obj({
      deltaY: { type: 'integer', description: 'Vertical scroll notches (negative = down, positive = up; default -3).' },
      deltaX: { type: 'integer', description: 'Horizontal scroll notches.' },
      x: { type: 'integer' },
      y: { type: 'integer' },
    }),
  },
  {
    name: 'pc_type_text',
    description: 'Type Unicode text into the active input (or click elementId first), optionally pressing Enter afterward.',
    inputSchema: obj({
      text: { type: 'string', description: 'Text to type (supports Unicode, symbols, newlines).' },
      elementId: { type: 'string', description: 'Optional UIA elementId to click/focus before typing.' },
      enter: { type: 'boolean', description: 'Press Enter after typing (default false).' },
    }, ['text']),
  },
  {
    name: 'pc_set_value',
    description: 'Replace the value of an input field (clicks elementId or x/y, selects all with Ctrl+A, and types value).',
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
    description: 'Press a keyboard key or hotkey chord (e.g. "Enter", "Escape", "Tab", "Ctrl+C", "Ctrl+V", "Ctrl+Shift+Esc", "Win+R", "Alt+Tab", "Alt+F4", "F5").',
    inputSchema: obj({
      key: { type: 'string', description: 'Key name or "+"-joined chord.' },
    }, ['key']),
  },
  {
    name: 'pc_clipboard',
    description: 'Read or write plain text on the Windows PC clipboard.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['get', 'set'] },
      text: { type: 'string', description: 'Text to copy to clipboard when mode is "set".' },
    }, ['mode']),
  },
  {
    name: 'pc_run_powershell',
    description: 'Run a PowerShell command directly on the Windows PC (returns stdout, stderr, exitCode). Requires PowerShell access to be enabled in My PC.',
    inputSchema: obj({
      command: { type: 'string', description: 'PowerShell command or script to run.' },
      cwd: { type: 'string', description: 'Optional working directory on the Windows PC.' },
      timeoutSec: { type: 'integer', minimum: 2, maximum: 90, description: 'Timeout in seconds (default 30).' },
    }, ['command']),
  },
  {
    name: 'pc_fs',
    description: 'Direct Windows filesystem access: list a directory, read a text file, or write a UTF-8 file on the paired PC.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['list', 'read', 'write'] },
      path: { type: 'string', description: 'Absolute Windows path (e.g. "C:\\Users\\ken\\Desktop").' },
      content: { type: 'string', description: 'File contents when mode is "write".' },
      maxBytes: { type: 'integer', description: 'Max bytes to read when mode is "read" (default 131072).' },
    }, ['mode', 'path']),
  },
  {
    name: 'pc_wait',
    description: 'Wait for a short delay (e.g. for an app or page to load) and optionally take a fresh screenshot afterward.',
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
    const timer = setTimeout(() => done(new Error('DevDash PC bridge timed out.')), 115_000)
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
        serverInfo: { name: 'devdash-pc', version: '1.0.0' },
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
