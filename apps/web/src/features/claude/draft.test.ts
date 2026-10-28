import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftKey, loadDraft, saveDraft } from './draft.ts'

const fakeStore = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

test('drafts are kept per session and cleared when empty', () => {
  const s = fakeStore()
  assert.equal(loadDraft('abc', s), '', 'nothing saved yet')

  saveDraft('abc', 'half a message', s)
  saveDraft('xyz', 'another one', s)
  assert.equal(loadDraft('abc', s), 'half a message')
  assert.equal(loadDraft('xyz', s), 'another one', "one session's draft never leaks into another")
  assert.equal(s.map.get(draftKey('abc')), 'half a message')

  saveDraft('abc', '', s)
  assert.equal(loadDraft('abc', s), '', 'emptying the text drops the stored draft')
  assert.ok(!s.map.has(draftKey('abc')))
  assert.equal(loadDraft('xyz', s), 'another one', 'the other draft is untouched')
})

test('no store (private mode / SSR) is handled, not thrown', () => {
  assert.equal(loadDraft('abc', null), '')
  assert.doesNotThrow(() => saveDraft('abc', 'x', null))
})
