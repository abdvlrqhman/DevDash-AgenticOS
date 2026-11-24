import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portToSet, servicePort } from './opencode.ts'

test("each member's OpenCode background server gets a port of its own, outside the services' ports; one they set stays", () => {
  const ports = [1000, 1001, 1002, 1003, 1004].map(servicePort)
  assert.deepEqual(ports, [21000, 21001, 21002, 21003, 21004])
  assert.ok(ports.every((p) => p < 20000 || p > 20999), "not DevDash's service ports")
  assert.notEqual(servicePort(1001), 49374, "not OpenCode's own default, which every member would share")

  assert.equal(portToSet('{}\n', 1001), 21001, 'nothing set yet')
  assert.equal(portToSet('{\n  "port": 4000\n}', 1001), null, 'their own choice stays')
  assert.equal(portToSet('Error: something', 1001), null, 'an unclear answer changes nothing')
  assert.equal(portToSet('[]', 1001), null)
})
