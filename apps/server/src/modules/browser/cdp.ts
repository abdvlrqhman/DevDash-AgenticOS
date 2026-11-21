import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

export type BrowserTab = {
  index: number
  id: string
  title: string
  url: string
  active: boolean
}

export type BrowserElement = {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
  checked?: boolean
  disabled?: boolean
  href?: string
  options?: string[]
  inputType?: string
}

export type BrowserObservation = {
  mode: 'cdp' | 'ocr'
  url: string
  title: string
  tabs: BrowserTab[]
  elements: BrowserElement[]
  text: string
  scroll?: { y: number; maxY: number; height: number }
  fingerprint: string
  screenshotBase64?: string
}

export type CdpAction =
  | { kind: 'navigate'; url: string; newTab?: boolean }
  | { kind: 'click'; ref?: string; label?: string; x?: number; y?: number }
  | { kind: 'fill'; ref?: string; label?: string; x?: number; y?: number; text: string; submit?: boolean }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { kind: 'wait_for'; selector?: string; text?: string; networkidle?: boolean; ms?: number }
  | { kind: 'switch_tab'; index: number }
  | { kind: 'close_tab'; index?: number }
  | { kind: 'extract_text'; selector?: string; ref?: string }

export type CdpActionResult = {
  summary: string
  url?: string
  extractedText?: string
}

type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

type KeyDef = { key: string; code: string; windowsVirtualKeyCode: number; text?: string }

const KEY_DEFS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
}

export function computeObservationFingerprint(obs: Pick<BrowserObservation, 'url' | 'title' | 'elements' | 'text'>): string {
  const h = createHash('sha256')
  h.update(obs.url + '\n' + obs.title + '\n')
  for (const el of obs.elements.slice(0, 60)) {
    h.update(`${el.ref}|${el.role}|${el.name}|${el.value ?? ''}|${el.checked ?? ''}\n`)
  }
  h.update(obs.text.slice(0, 2000))
  return h.digest('hex').slice(0, 16)
}

export function formatObservation(obs: BrowserObservation): string {
  const lines: string[] = []
  if (obs.url) lines.push(`URL: ${obs.url}`)
  if (obs.title) lines.push(`Title: ${obs.title}`)
  if (obs.tabs.length > 0) {
    const tabStr = obs.tabs
      .map((t) => `[${t.index}${t.active ? '*' : ''}] ${(t.title || t.url || 'Untitled').slice(0, 50)} (${t.url.slice(0, 80)})`)
      .join(' | ')
    lines.push(`Tabs: ${tabStr}`)
  }
  if (obs.scroll) {
    lines.push(`Scroll: y=${obs.scroll.y} / max=${obs.scroll.maxY} (viewport=${obs.scroll.height})`)
  }
  if (obs.elements.length > 0) {
    lines.push('Interactive elements:')
    for (const el of obs.elements) {
      const parts = [`[${el.ref}]`, el.role]
      if (el.name) parts.push(JSON.stringify(el.name))
      if (el.value !== undefined && el.value !== '') parts.push(`value=${JSON.stringify(el.value)}`)
      if (el.checked !== undefined) parts.push(`checked=${el.checked}`)
      if (el.disabled) parts.push('disabled')
      if (el.options?.length) parts.push(`options=${JSON.stringify(el.options)}`)
      lines.push(parts.join(' '))
    }
  }
  if (obs.text) {
    lines.push('Visible text:')
    lines.push(obs.text)
  }
  return lines.join('\n')
}

/** Lightweight CDP WebSocket RPC client for one target or browser endpoint. */
class CdpSocket {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message?: string } }
        if (typeof msg.id !== 'number') return
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'))
        else p.resolve(msg.result)
      } catch { /* ignore malformed event */ }
    })
    const failAll = (reason: string) => {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      this.pending.clear()
    }
    ws.on('close', () => failAll('CDP connection closed'))
    ws.on('error', (err) => failAll(`CDP error: ${err.message}`))
  }

  static connect(wsUrl: string, token: string, timeoutMs = 5000): Promise<CdpSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: token ? { 'X-DevDash-CDP-Token': token } : undefined,
        handshakeTimeout: timeoutMs,
      })
      const timer = setTimeout(() => {
        try { ws.terminate() } catch { /* ignore */ }
        reject(new Error('CDP connection timed out'))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve(new CdpSocket(ws))
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch { /* ignore */ }
  }
}

const OBSERVE_SCRIPT = `(() => {
  const KEY = Symbol.for('devdash.cdp.refs');
  const refs = new Map();
  globalThis[KEY] = refs;
  const clean = (s, max = 120) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const roleOf = (el) => {
    const r = (el.getAttribute('role') || '').trim().toLowerCase();
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(txt)) return clean(txt);
    }
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && clean(lbl.textContent)) return clean(lbl.textContent);
      } catch {}
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input,textarea,select').forEach((n) => n.remove());
      if (clean(clone.textContent)) return clean(clone.textContent);
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return clean(ph);
    const title = el.getAttribute('title');
    if (title) return clean(title);
    const alt = el.getAttribute('alt') || el.querySelector('img[alt]')?.getAttribute('alt');
    if (alt) return clean(alt);
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(el.value);
      return clean(el.getAttribute('name') || '');
    }
    return clean(el.innerText || el.textContent || '');
  };
  const selector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[contenteditable="true"]', '[contenteditable=""]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const seen = new Set();
  const inView = [];
  const offView = [];
  const vh = window.innerHeight || 900;
  for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.bottom >= -100 && r.top <= vh + 400) inView.push(el);
    else offView.push(el);
  }
  const ordered = [...inView, ...offView].slice(0, 120);
  const elements = [];
  let idx = 1;
  for (const el of ordered) {
    const ref = 'e' + idx++;
    refs.set(ref, el);
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const name = nameOf(el);
    const item = { ref, role, name, tag };
    if (tag === 'input' || tag === 'textarea') {
      const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : 'textarea';
      item.inputType = inputType;
      if (inputType === 'checkbox' || inputType === 'radio') {
        item.checked = Boolean(el.checked);
      } else if (inputType === 'password') {
        item.value = el.value ? '[password]' : '';
      } else {
        item.value = clean(el.value, 160);
      }
    } else if (tag === 'select') {
      item.value = clean(el.value, 120);
      item.options = Array.from(el.options).slice(0, 12).map((o) => clean(o.text || o.value, 60)).filter(Boolean);
    } else if (el.isContentEditable) {
      item.value = clean(el.innerText || el.textContent || '', 160);
    }
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-checked') === 'false') {
      item.checked = el.getAttribute('aria-checked') === 'true';
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) item.href = String(el.href || href).slice(0, 200);
    }
    elements.push(item);
  }
  const rawText = (document.body && document.body.innerText) ? document.body.innerText : '';
  const text = rawText.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 6000);
  const docEl = document.documentElement;
  const maxY = Math.max(0, (docEl.scrollHeight || 0) - vh);
  return {
    url: location.href,
    title: clean(document.title, 200),
    elements,
    text,
    scroll: { y: Math.round(window.scrollY || 0), maxY: Math.round(maxY), height: Math.round(vh) },
  };
})()`

/**
 * Thin native Chrome DevTools Protocol client for the shared Neko Chromium instance.
 * Speaks only to loopback (127.0.0.1:9222) using the private server token in X-DevDash-CDP-Token.
 */
export function createCdpClient(opts: { baseUrl?: string; token: () => string }) {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9222').replace(/\/$/, '')
  let activeTargetId: string | null = null

  const headers = (): Record<string, string> => {
    const t = opts.token()
    return t ? { 'X-DevDash-CDP-Token': t } : {}
  }

  async function fetchJson<T>(path: string, method: 'GET' | 'PUT' = 'GET', timeoutMs = 4000): Promise<T> {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) throw new Error(`CDP HTTP ${r.status} on ${path}`)
    return await r.json() as T
  }

  async function rawTargets(): Promise<CdpTarget[]> {
    const all = await fetchJson<CdpTarget[]>('/json/list')
    return all.filter((t) => t.type === 'page' && !!t.webSocketDebuggerUrl)
  }

  function rewriteWsUrl(wsUrl: string): string {
    const parsed = new URL(wsUrl)
    const base = new URL(baseUrl)
    parsed.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    parsed.hostname = base.hostname
    parsed.port = base.port
    return parsed.toString()
  }

  async function resolveActiveTarget(): Promise<{ target: CdpTarget; tabs: BrowserTab[] }> {
    const pages = await rawTargets()
    if (!pages.length) throw new Error('No open browser tab found.')
    let picked = activeTargetId ? pages.find((p) => p.id === activeTargetId) : undefined
    if (!picked) {
      picked = pages.find((p) => !p.url.startsWith('chrome://') && !p.url.startsWith('devtools://')) ?? pages[0]!
      activeTargetId = picked.id
    }
    const tabs: BrowserTab[] = pages.map((p, index) => ({
      index,
      id: p.id,
      title: p.title || '',
      url: p.url || '',
      active: p.id === picked!.id,
    }))
    return { target: picked, tabs }
  }

  async function withTab<T>(fn: (sock: CdpSocket, target: CdpTarget, tabs: BrowserTab[]) => Promise<T>): Promise<T> {
    const { target, tabs } = await resolveActiveTarget()
    const sock = await CdpSocket.connect(rewriteWsUrl(target.webSocketDebuggerUrl!), opts.token())
    try {
      return await fn(sock, target, tabs)
    } finally {
      sock.close()
    }
  }

  async function evalValue<T>(sock: CdpSocket, expression: string, awaitPromise = false): Promise<T> {
    const res = await sock.send<{
      result?: { value?: T; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Page evaluation failed')
    }
    return res.result?.value as T
  }

  async function locateElement(sock: CdpSocket, target: { ref?: string; label?: string }): Promise<{
    found: boolean
    x?: number
    y?: number
    name?: string
    role?: string
    tag?: string
    href?: string
    disabled?: boolean
    error?: string
  }> {
    return evalValue(sock, `((arg) => {
      const KEY = Symbol.for('devdash.cdp.refs');
      const refs = globalThis[KEY];
      let el = null;
      if (arg.ref && refs instanceof Map) el = refs.get(arg.ref) || null;
      if (!el && arg.label) {
        const needle = arg.label.trim().toLowerCase();
        const matches = [];
        if (refs instanceof Map) {
          for (const node of refs.values()) {
            const txt = String(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            if (txt && (txt === needle || txt.includes(needle))) matches.push(node);
          }
        }
        if (matches.length === 1) el = matches[0];
        else if (matches.length > 1) return { found: false, error: 'More than one element matched "' + arg.label + '". Use an element ref like e12 instead.' };
      }
      if (!el || !el.isConnected) return { found: false, error: arg.ref ? 'Element ' + arg.ref + ' is no longer on the page.' : 'Could not find "' + (arg.label || '') + '" on the page.' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const name = String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      return {
        found: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        name,
        role: (el.getAttribute('role') || el.tagName).toLowerCase(),
        tag: el.tagName.toLowerCase(),
        href: el.tagName === 'A' ? String(el.href || '').slice(0, 200) : undefined,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      };
    })(${JSON.stringify(target)})`)
  }

  return {
    async available(): Promise<boolean> {
      try {
        await fetchJson('/json/version', 'GET', 1500)
        return true
      } catch {
        return false
      }
    },

    async observe(options?: { includeScreenshot?: boolean }): Promise<BrowserObservation> {
      return withTab(async (sock, _target, tabs) => {
        const data = await evalValue<{
          url: string
          title: string
          elements: BrowserElement[]
          text: string
          scroll: { y: number; maxY: number; height: number }
        }>(sock, OBSERVE_SCRIPT)
        let screenshotBase64: string | undefined
        if (options?.includeScreenshot) {
          try {
            const shot = await sock.send<{ data?: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 8000)
            screenshotBase64 = shot.data
          } catch { /* optional */ }
        }
        const obs: BrowserObservation = {
          mode: 'cdp',
          url: data.url,
          title: data.title,
          tabs,
          elements: data.elements,
          text: data.text,
          scroll: data.scroll,
          fingerprint: computeObservationFingerprint(data),
          ...(screenshotBase64 ? { screenshotBase64 } : {}),
        }
        return obs
      })
    },

    async act(action: CdpAction, signal?: AbortSignal): Promise<CdpActionResult> {
      if (action.kind === 'switch_tab') {
        const pages = await rawTargets()
        const picked = pages[action.index]
        if (!picked) throw new Error(`Tab ${action.index} does not exist.`)
        const sock = await CdpSocket.connect(rewriteWsUrl(picked.webSocketDebuggerUrl!), opts.token())
        try {
          await sock.send('Page.bringToFront')
        } finally {
          sock.close()
        }
        activeTargetId = picked.id
        return { summary: `Switched to tab [${action.index}] ${picked.title || picked.url}`, url: picked.url }
      }

      if (action.kind === 'close_tab') {
        const pages = await rawTargets()
        if (pages.length <= 1) throw new Error('Cannot close the last remaining browser tab.')
        const idx = action.index ?? pages.findIndex((p) => p.id === activeTargetId)
        const victim = pages[idx >= 0 ? idx : 0]
        if (!victim) throw new Error(`Tab ${action.index} does not exist.`)
        await fetch(`${baseUrl}/json/close/${encodeURIComponent(victim.id)}`, {
          method: 'GET',
          headers: headers(),
          redirect: 'error',
          signal: AbortSignal.timeout(4000),
        })
        if (activeTargetId === victim.id) {
          const remaining = pages.filter((p) => p.id !== victim.id)
          activeTargetId = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null
        }
        return { summary: `Closed tab ${victim.title || victim.url}` }
      }

      if (action.kind === 'navigate' && action.newTab) {
        const created = await fetchJson<CdpTarget>(`/json/new?${encodeURIComponent(action.url)}`, 'PUT', 8000)
        if (created?.id) activeTargetId = created.id
        return { summary: `Opened ${action.url} in a new tab`, url: action.url }
      }

      return withTab(async (sock, target) => {
        if (action.kind === 'navigate') {
          await sock.send('Page.enable')
          await sock.send('Page.bringToFront')
          const nav = await sock.send<{ errorText?: string }>('Page.navigate', { url: action.url }, 15_000)
          if (nav.errorText) throw new Error(`Navigation failed: ${nav.errorText}`)
          await delay(400, undefined, { signal })
          const deadline = Date.now() + 8000
          while (Date.now() < deadline) {
            const ready = await evalValue<string>(sock, 'document.readyState').catch(() => 'loading')
            if (ready === 'complete' || ready === 'interactive') break
            await delay(250, undefined, { signal })
          }
          const finalUrl = await evalValue<string>(sock, 'location.href').catch(() => action.url)
          return { summary: `Navigated to ${finalUrl}`, url: finalUrl }
        }

        if (action.kind === 'click') {
          let x = action.x
          let y = action.y
          let desc = x !== undefined && y !== undefined ? `(${x}, ${y})` : (action.ref ?? action.label ?? 'element')
          if (action.ref || action.label) {
            const loc = await locateElement(sock, { ref: action.ref, label: action.label })
            if (!loc.found) throw new Error(loc.error || 'Element not found.')
            if (loc.disabled) throw new Error(`Element ${desc} is disabled.`)
            x = loc.x
            y = loc.y
            desc = loc.name ? `${action.ref ? `[${action.ref}] ` : ''}“${loc.name}”` : desc
          }
          if (x === undefined || y === undefined) throw new Error('Click requires an element ref, label, or coordinates.')
          await sock.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
          await sock.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await sock.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          await delay(350, undefined, { signal })
          const finalUrl = await evalValue<string>(sock, 'location.href').catch(() => target.url)
          return { summary: `Clicked ${desc}`, url: finalUrl }
        }

        if (action.kind === 'fill') {
          let desc = action.ref ?? action.label ?? 'focused input'
          if (action.ref || action.label) {
            const loc = await locateElement(sock, { ref: action.ref, label: action.label })
            if (!loc.found) throw new Error(loc.error || 'Input element not found.')
            if (loc.disabled) throw new Error(`Input ${desc} is disabled.`)
            desc = loc.name ? `${action.ref ? `[${action.ref}] ` : ''}“${loc.name}”` : desc
            const applied = await evalValue<{ ok: boolean; isContentEditable?: boolean; error?: string }>(sock, `((arg) => {
              const KEY = Symbol.for('devdash.cdp.refs');
              const refs = globalThis[KEY];
              let el = arg.ref && refs instanceof Map ? refs.get(arg.ref) : null;
              if (!el && arg.label && refs instanceof Map) {
                const needle = arg.label.trim().toLowerCase();
                for (const node of refs.values()) {
                  const txt = String(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.innerText || '').trim().toLowerCase();
                  if (txt === needle || txt.includes(needle)) { el = node; break; }
                }
              }
              if (!el || !el.isConnected) return { ok: false, error: 'Input is no longer on the page.' };
              el.focus();
              if (el.isContentEditable) {
                el.textContent = arg.text;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: arg.text, inputType: 'insertText' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, isContentEditable: true };
              }
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, arg.text);
              else el.value = arg.text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            })(${JSON.stringify({ ref: action.ref, label: action.label, text: action.text })})`)
            if (!applied.ok) throw new Error(applied.error || 'Could not fill input.')
          } else {
            if (action.x !== undefined && action.y !== undefined) {
              await sock.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 })
              await sock.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 })
            }
            await sock.send('Input.insertText', { text: action.text })
          }
          if (action.submit) {
            const def = KEY_DEFS.Enter!
            await sock.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode })
            await sock.send('Input.dispatchKeyEvent', { type: 'char', text: '\r' })
            await sock.send('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode })
            await delay(500, undefined, { signal })
          } else {
            await delay(150, undefined, { signal })
          }
          const finalUrl = await evalValue<string>(sock, 'location.href').catch(() => target.url)
          const preview = action.text.replace(/\s+/g, ' ').slice(0, 60)
          return { summary: `Filled ${desc} with “${preview}”${action.submit ? ' and submitted' : ''}`, url: finalUrl }
        }

        if (action.kind === 'select') {
          const res = await evalValue<{ ok: boolean; label?: string; error?: string }>(sock, `((arg) => {
            const KEY = Symbol.for('devdash.cdp.refs');
            const refs = globalThis[KEY];
            const el = refs instanceof Map ? refs.get(arg.ref) : null;
            if (!el || !el.isConnected || el.tagName !== 'SELECT') return { ok: false, error: 'Element ' + arg.ref + ' is not a select dropdown.' };
            const needle = arg.value.trim().toLowerCase();
            const opt = Array.from(el.options).find((o) => o.value === arg.value || o.value.toLowerCase() === needle || o.text.trim().toLowerCase() === needle || o.text.trim().toLowerCase().includes(needle));
            if (!opt) return { ok: false, error: 'Option "' + arg.value + '" not found in ' + arg.ref + '.' };
            el.value = opt.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, label: opt.text.trim() || opt.value };
          })(${JSON.stringify({ ref: action.ref, value: action.value })})`)
          if (!res.ok) throw new Error(res.error || 'Could not select option.')
          await delay(200, undefined, { signal })
          return { summary: `Selected “${res.label}” in [${action.ref}]`, url: target.url }
        }

        if (action.kind === 'press') {
          if (action.key === 'Reload') {
            await sock.send('Page.reload')
            await delay(500, undefined, { signal })
            return { summary: 'Reloaded page', url: target.url }
          }
          if (action.key === 'Back' || action.key === 'Forward') {
            const hist = await sock.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory')
            const nextIdx = action.key === 'Back' ? hist.currentIndex - 1 : hist.currentIndex + 1
            const entry = hist.entries[nextIdx]
            if (!entry) return { summary: `No ${action.key.toLowerCase()} history entry`, url: target.url }
            await sock.send('Page.navigateToHistoryEntry', { entryId: entry.id })
            await delay(500, undefined, { signal })
            return { summary: `Navigated ${action.key.toLowerCase()} to ${entry.url}`, url: entry.url }
          }
          if (action.key === 'SelectAll') {
            await sock.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
            await sock.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
            return { summary: 'Pressed SelectAll', url: target.url }
          }
          const def = KEY_DEFS[action.key]
          if (!def) throw new Error(`Unsupported key: ${action.key}`)
          await sock.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode })
          if (def.text) await sock.send('Input.dispatchKeyEvent', { type: 'char', text: def.text })
          await sock.send('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode })
          await delay(250, undefined, { signal })
          const finalUrl = await evalValue<string>(sock, 'location.href').catch(() => target.url)
          return { summary: `Pressed ${action.key}`, url: finalUrl }
        }

        if (action.kind === 'scroll') {
          const delta = Math.max(100, Math.min(action.amount ?? 650, 2400))
          const signed = action.direction === 'down' ? delta : -delta
          const pos = await evalValue<{ y: number; maxY: number }>(sock, `(() => {
            window.scrollBy({ top: ${signed}, behavior: 'instant' });
            const maxY = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 900));
            return { y: Math.round(window.scrollY || 0), maxY: Math.round(maxY) };
          })()`)
          await delay(200, undefined, { signal })
          return { summary: `Scrolled ${action.direction} (y=${pos.y}/${pos.maxY})`, url: target.url }
        }

        if (action.kind === 'wait_for') {
          const maxMs = Math.max(200, Math.min(action.ms ?? (action.selector || action.text || action.networkidle ? 10_000 : 2000), 15_000))
          if (!action.selector && !action.text && !action.networkidle) {
            await delay(maxMs, undefined, { signal })
            return { summary: `Waited ${maxMs}ms`, url: target.url }
          }
          const deadline = Date.now() + maxMs
          let lastCount = -1
          let quietSince = 0
          while (Date.now() < deadline) {
            if (action.selector) {
              const found = await evalValue<boolean>(sock, `Boolean(document.querySelector(${JSON.stringify(action.selector)}))`).catch(() => false)
              if (found) return { summary: `Found selector ${action.selector}`, url: target.url }
            }
            if (action.text) {
              const found = await evalValue<boolean>(sock, `Boolean((document.body?.innerText || '').toLowerCase().includes(${JSON.stringify(action.text.toLowerCase())}))`).catch(() => false)
              if (found) return { summary: `Found text “${action.text.slice(0, 60)}”`, url: target.url }
            }
            if (action.networkidle) {
              const st = await evalValue<{ ready: string; count: number }>(sock, `({ ready: document.readyState, count: performance.getEntriesByType('resource').length })`).catch(() => ({ ready: 'loading', count: -1 }))
              if (st.ready === 'complete') {
                if (st.count === lastCount) {
                  if (!quietSince) quietSince = Date.now()
                  if (Date.now() - quietSince >= 600) return { summary: 'Page reached network idle', url: target.url }
                } else {
                  lastCount = st.count
                  quietSince = Date.now()
                }
              }
            }
            await delay(250, undefined, { signal })
          }
          return { summary: `Waited up to ${maxMs}ms`, url: target.url }
        }

        if (action.kind === 'extract_text') {
          const res = await evalValue<{ ok: boolean; text?: string; error?: string }>(sock, `((arg) => {
            const KEY = Symbol.for('devdash.cdp.refs');
            const refs = globalThis[KEY];
            let node = document.body;
            if (arg.ref && refs instanceof Map) {
              node = refs.get(arg.ref) || null;
              if (!node) return { ok: false, error: 'Element ' + arg.ref + ' not found.' };
            } else if (arg.selector) {
              try { node = document.querySelector(arg.selector); } catch { return { ok: false, error: 'Invalid CSS selector.' }; }
              if (!node) return { ok: false, error: 'Selector "' + arg.selector + '" not found.' };
            }
            const text = String(node?.innerText || node?.textContent || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 12000);
            return { ok: true, text };
          })(${JSON.stringify({ selector: action.selector, ref: action.ref })})`)
          if (!res.ok) throw new Error(res.error || 'Could not extract text.')
          return {
            summary: `Extracted ${(res.text ?? '').length} chars${action.ref ? ` from [${action.ref}]` : action.selector ? ` from ${action.selector}` : ''}`,
            url: target.url,
            extractedText: res.text ?? '',
          }
        }

        throw new Error('Unsupported CDP action.')
      })
    },
  }
}

export type CdpClient = ReturnType<typeof createCdpClient>
