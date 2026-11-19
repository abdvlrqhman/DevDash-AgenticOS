import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceBlocker } from './ready.ts'

test('the voice button says why it can\'t start yet, and nothing once it can', () => {
  assert.match(voiceBlocker(undefined)!, /off/)
  assert.match(voiceBlocker({ enabled: false, missing: [], overCap: false })!, /Voice mode is off\. Turn it on and add your keys in Voice settings\./)
  assert.match(voiceBlocker({ enabled: true, missing: ['soniox', 'voice'], overCap: false })!, /keys/)
  assert.match(voiceBlocker({ enabled: true, missing: ['voice'], overCap: false })!, /Pick a voice/)
  assert.match(voiceBlocker({ enabled: true, missing: [], overCap: true })!, /cap/)
  assert.equal(voiceBlocker({ enabled: true, missing: [], overCap: false }), null)
})

test('first setup starts from the browser\'s languages', async () => {
  const { fromBrowser } = await import('./ready.ts')
  assert.deepEqual(fromBrowser(['de-DE', 'ar-EG', 'en-US', 'en', 'xx'], ['ar', 'de', 'en', 'fr'], ['en']), ['en', 'de', 'ar'])
  assert.deepEqual(fromBrowser([], ['en'], ['en']), ['en'])
})

test('a microphone that won\'t open says whose side it is: ours, the browser\'s, the device\'s', async () => {
  const { micError } = await import('./ready.ts')
  const ok = { secure: true, policyAllows: true, hasMediaDevices: true }
  assert.match(micError({ ...ok, secure: false }), /secure/)
  assert.match(micError({ ...ok, policyAllows: false, name: 'NotAllowedError' }), /our side/)
  assert.match(micError({ ...ok, name: 'NotAllowedError' }), /denied.*browser's settings/)
  assert.match(micError({ ...ok, policyAllows: null, name: 'NotAllowedError' }), /denied/) // Safari can't tell: the browser's side
  assert.match(micError({ ...ok, name: 'NotFoundError' }), /No microphone/)
  assert.match(micError({ ...ok, hasMediaDevices: false }), /can't use a microphone/)
  assert.match(micError({ ...ok, hasMediaDevices: false, inApp: true }), /version of the DevDash app.*Update the app/)
  assert.match(micError({ ...ok, name: 'NotAllowedError', inApp: true }), /phone's settings/)
})
