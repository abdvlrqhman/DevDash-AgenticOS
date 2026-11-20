import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followLabel, followLight, followNeedsYou } from './follow-label.ts'

test('a followed session reads as its replies, as Hamasa having told them, or as needing them itself', () => {
  const on = { state: 'on', replies: 2, maxReplies: 5 }
  assert.equal(followLabel(on, 'working'), '2/5 replies')
  assert.equal(followLabel(on, 'idle'), '2/5 replies', 'idle with nothing reported is not "waits for you"')
  assert.equal(followLabel({ ...on, state: 'waiting_you' }, 'idle'), 'Hamasa told you')
  assert.equal(followLabel(on, 'waiting'), 'needs you', 'a question or permission in the session itself')
  assert.equal(followLabel({ ...on, state: 'waiting_you' }, 'error'), 'needs you')
  assert.deepEqual(['waiting', 'error', 'idle', 'working'].map(followNeedsYou), [true, true, false, false])
  assert.deepEqual(['working', 'waiting', 'error', 'idle', 'stopped'].map(followLight), ['live', 'waiting', 'error', 'idle', 'idle'])
})
