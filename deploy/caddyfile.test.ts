import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const caddy = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8')
const app = /header @app \{([\s\S]*?)\n\t\}/.exec(caddy)?.[1] ?? ''
const policy = /Permissions-Policy "([^"]*)"/.exec(app)?.[1] ?? ''
const csp = /Content-Security-Policy "([^"]*)"/.exec(app)?.[1] ?? ''

test('DevDash\'s pages may use the microphone (voice mode), and nothing else that policy keeps off', () => {
  assert.ok(policy, 'no Permissions-Policy on the app pages')
  assert.match(policy, /(^|, )microphone=\(self\)(,|$)/, 'voice mode needs microphone=(self): without it browsers never even ask')
  for (const f of ['camera', 'geolocation', 'payment']) assert.match(policy, new RegExp(`(^|, )${f}=\\(\\)(,|$)`), `${f} must stay off`)
})

test('the app\'s CSP stays strict: voice mode needs nothing beyond its own origin', () => {
  // Voice's worklets are same-origin files, its WebSocket is same-origin: no blob: scripts, no wss: wildcards.
  assert.match(csp, /script-src 'self';/)
  assert.match(csp, /connect-src 'self';/)
  assert.doesNotMatch(csp, /blob:[^;]*;\s*$|script-src[^;]*blob:/)
})
