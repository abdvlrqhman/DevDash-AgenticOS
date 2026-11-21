import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { computeObservationFingerprint, createCdpClient, formatObservation } from './cdp.ts'

test('CDP client sends X-DevDash-CDP-Token on HTTP and WebSocket, observes DOM, and executes tab/DOM actions', async () => {
  const token = 'secret-cdp-token-123'
  const receivedCalls: { method: string; params?: Record<string, unknown> }[] = []
  let activeUrl = 'https://example.com/'
  let tabs = [
    { id: 'tab-1', type: 'page', title: 'Example Home', url: 'https://example.com/' },
    { id: 'tab-2', type: 'page', title: 'Docs', url: 'https://example.com/docs' },
  ]

  const server = createServer((req, res) => {
    if (req.headers['x-devdash-cdp-token'] !== token) {
      res.writeHead(403)
      res.end()
      return
    }
    const addr = server.address() as { port: number }
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Chrome/155.0' }))
      return
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(tabs.map((t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/${t.id}` }))))
      return
    }
    if (req.url?.startsWith('/json/new?')) {
      const url = decodeURIComponent(req.url.slice('/json/new?'.length))
      const created = { id: 'tab-3', type: 'page', title: 'New Tab', url }
      tabs.push(created)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...created, webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/${created.id}` }))
      return
    }
    if (req.url?.startsWith('/json/close/')) {
      const id = decodeURIComponent(req.url.slice('/json/close/'.length))
      tabs = tabs.filter((t) => t.id !== id)
      res.writeHead(200)
      res.end('Target is closing')
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['x-devdash-cdp-token'] !== token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> }
        receivedCalls.push({ method: msg.method, params: msg.params })
        if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression ?? '')
          if (expr.includes('devdash.cdp.refs') && expr.includes('OBSERVE') === false && expr.includes('document.querySelectorAll(selector)')) {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    url: activeUrl,
                    title: 'Example Home',
                    elements: [
                      { ref: 'e1', role: 'textbox', name: 'Email', tag: 'input', inputType: 'email', value: '' },
                      { ref: 'e2', role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', value: '[password]' },
                      { ref: 'e3', role: 'button', name: 'Continue', tag: 'button' },
                    ],
                    text: 'Sign in to Example',
                    scroll: { y: 0, maxY: 800, height: 900 },
                  },
                },
              },
            }))
            return
          }
          if (expr.includes('scrollIntoView')) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { found: true, x: 120, y: 240, name: 'Continue', role: 'button', tag: 'button', disabled: false } } } }))
            return
          }
          if (expr.includes('HTMLTextAreaElement')) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true } } } }))
            return
          }
          if (expr.includes("tagName !== 'SELECT'")) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, label: 'Pro Plan' } } } }))
            return
          }
          if (expr.includes('window.scrollBy')) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { y: 650, maxY: 1200 } } } }))
            return
          }
          if (expr.includes('document.readyState')) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: 'complete' } } }))
            return
          }
          if (expr === 'location.href') {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: activeUrl } } }))
            return
          }
          if (expr.includes('Invalid CSS selector')) {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, text: 'Pricing: $29/mo' } } } }))
            return
          }
        }
        if (msg.method === 'Page.navigate') {
          activeUrl = String(msg.params?.url ?? activeUrl)
          ws.send(JSON.stringify({ id: msg.id, result: { frameId: 'f1' } }))
          return
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // Wrong token is rejected cleanly
    const badClient = createCdpClient({ baseUrl, token: () => 'wrong' })
    assert.equal(await badClient.available(), false)

    const cdp = createCdpClient({ baseUrl, token: () => token })
    assert.equal(await cdp.available(), true)

    const obs = await cdp.observe()
    assert.equal(obs.mode, 'cdp')
    assert.equal(obs.url, 'https://example.com/')
    assert.equal(obs.tabs.length, 2)
    assert.equal(obs.elements.length, 3)
    assert.equal(obs.elements[1]?.value, '[password]')
    assert.equal(obs.fingerprint, computeObservationFingerprint(obs))
    const formatted = formatObservation(obs)
    assert.match(formatted, /\[e1\] textbox "Email"/)
    assert.match(formatted, /\[e2\] textbox "Password" value="\[password\]"/)
    assert.match(formatted, /Tabs: \[0\*\] Example Home/)

    const nav = await cdp.act({ kind: 'navigate', url: 'https://example.com/pricing' })
    assert.equal(nav.url, 'https://example.com/pricing')

    const clicked = await cdp.act({ kind: 'click', ref: 'e3' })
    assert.match(clicked.summary, /Clicked \[e3\] “Continue”/)

    const filled = await cdp.act({ kind: 'fill', ref: 'e1', text: 'line1\nline2', submit: true })
    assert.match(filled.summary, /Filled \[e1\].*and submitted/)

    const sel = await cdp.act({ kind: 'select', ref: 'e4', value: 'Pro Plan' })
    assert.match(sel.summary, /Selected “Pro Plan”/)

    const ext = await cdp.act({ kind: 'extract_text', selector: 'main' })
    assert.equal(ext.extractedText, 'Pricing: $29/mo')

    const sw = await cdp.act({ kind: 'switch_tab', index: 1 })
    assert.match(sw.summary, /Switched to tab \[1\]/)

    const created = await cdp.act({ kind: 'navigate', url: 'https://example.com/new', newTab: true })
    assert.match(created.summary, /new tab/)
    assert.equal(tabs.length, 3)

    const closed = await cdp.act({ kind: 'close_tab', index: 2 })
    assert.match(closed.summary, /Closed tab/)
    assert.equal(tabs.length, 2)

    assert.ok(receivedCalls.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed'))
    assert.ok(receivedCalls.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params?.key === 'Enter'))
  } finally {
    wss.close()
    server.close()
  }
})
