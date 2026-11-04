#!/usr/bin/env node
// A stand-in ACP agent for the harness tests (harness-acp.test.ts): it answers the way OpenCode does over ACP, with no
// model behind it, so the driver is tested without a provider or the network. A prompt asking to run `<cmd>` makes it
// ask permission for a shell call first. FAKE_ACP_LOG, when set, gets one JSON line per message it receives.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (x) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(x)}\n`)
log({ config: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null })
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
let next = 1000
const waiting = new Map()
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }) })
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const model = { id: 'model', category: 'model', currentValue: 'fake/one', options: [{ value: 'fake/one' }, { value: 'fake/two' }] }

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  'session/new': () => ({ sessionId: 'ses_fake', configOptions: [model] }),
  'session/load': () => ({ configOptions: [model] }),
  'session/set_config_option': (p) => { model.currentValue = p.value; return { configOptions: [model] } },
  'session/delete': () => ({}),
  'session/prompt': async (p) => {
    const text = p.prompt.map((b) => b.text ?? '').join(' ')
    const cmd = /run `([^`]+)`/.exec(text)?.[1]
    if (cmd) {
      const call = `call_${next}`
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: call, name: 'shell', kind: 'execute', status: 'pending', rawInput: { cwd: '/x' } })
      const toolCall = { toolCallId: call, name: 'shell', kind: 'execute', status: 'pending', rawInput: { command: cmd } }
      const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }]
      const r = await ask('session/request_permission', { sessionId: p.sessionId, toolCall, options })
      const ok = r?.outcome?.optionId === 'once'
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: ok ? `ran ${cmd}` : 'declined' } }] })
    }
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: `msg_${next++}`, content: { type: 'text', text: cmd ? 'done' : '4' } })
    update(p.sessionId, { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.01, currency: 'USD' } })
    return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } }
  },
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line)
  if (!m.method) {
    waiting.get(m.id)?.(m.result)
    return void waiting.delete(m.id)
  }
  log({ method: m.method, params: m.params })
  if (m.id === undefined) return // a notification (session/cancel)
  const h = handlers[m.method]
  send(h ? { id: m.id, result: await h(m.params ?? {}) } : { id: m.id, error: { code: -32601, message: `no ${m.method}` } })
}).on('close', () => process.exit(0))
