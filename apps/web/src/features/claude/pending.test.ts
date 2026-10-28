import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcilePending, type PendingChange } from './pending.ts'
import type { PendingRequest } from './data.ts'

const req = (requestId: string, toolName = 'Bash'): PendingRequest => ({ requestId, toolName, input: {} })
const changes = (entries: [string, PendingChange][] = []) => new Map<string, PendingChange>(entries)
const ids = (list: PendingRequest[]) => list.map((r) => r.requestId)

test('info seeds the cards on first load', () => {
  const a = req('a')
  assert.deepEqual(reconcilePending([], [a], changes()), [a])
})

test('a request only in info (the live event was missed) still appears', () => {
  const a = req('a')
  assert.deepEqual(reconcilePending([], [a], changes()), [a])
})

test("a stale info snapshot does not wipe a request a live event just added", () => {
  const a = req('a')
  // Live added `a`; info hasn't caught up (still empty). The card must stay.
  assert.deepEqual(reconcilePending([a], [], changes([['a', 'added']])), [a])
})

test('a live-added request keeps its full live shape even when info lags', () => {
  const live = req('a', 'AskUserQuestion')
  const out = reconcilePending([live], [], changes([['a', 'added']]))
  assert.equal(out[0], live) // same object, not a thinner info copy
})

test('a stale info snapshot does not resurrect a request a live event just removed', () => {
  const a = req('a')
  // Live removed `a`; a stale info snapshot still lists it. It must stay gone.
  assert.deepEqual(reconcilePending([], [a], changes([['a', 'removed']])), [])
})

test('once info agrees it is authoritative again (no shield needed)', () => {
  const a = req('a')
  const b = req('b')
  // Info now carries what live has, and dropping the guard leaves the result unchanged.
  assert.deepEqual(ids(reconcilePending([a], [a, b], changes())), ['a', 'b'])
})

test('a shielded remove does not block other info-only requests', () => {
  const a = req('a')
  const b = req('b')
  assert.deepEqual(ids(reconcilePending([b], [a, b], changes([['a', 'removed']]))), ['b'])
})

test('a shielded add coexists with requests only info knows about', () => {
  const a = req('a')
  const b = req('b')
  // `a` added live but not yet in info; `b` only in info. Both show.
  assert.deepEqual(ids(reconcilePending([a], [b], changes([['a', 'added']]))).sort(), ['a', 'b'])
})

test('keeps the current array identity when nothing changed, to avoid needless re-renders', () => {
  const a = req('a')
  const live = [a]
  assert.equal(reconcilePending(live, [a], changes()), live)
})

test('returns a fresh array when the set changes', () => {
  const a = req('a')
  const live: PendingRequest[] = []
  assert.notEqual(reconcilePending(live, [a], changes()), live)
})
