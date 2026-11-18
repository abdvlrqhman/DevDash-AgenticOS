import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followLabel, followLight } from './follow-label.ts'

test('a followed session reads as its replies, or as waiting for the member', () => {
  assert.equal(followLabel({ state: 'on', replies: 2, maxReplies: 5 }), '2/5 replies')
  assert.equal(followLabel({ state: 'waiting_you', replies: 5, maxReplies: 5 }), 'waits for you')
  assert.deepEqual(['working', 'waiting', 'error', 'idle', 'stopped'].map(followLight), ['live', 'waiting', 'error', 'idle', 'idle'])
})
