import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkEveryN, normalizeRotation, parsePageRanges, reorder, splitByRanges, stampAnchor, withSuffix,
} from './pdf-util.ts'

test('parsePageRanges turns a spec into ordered 0-based indexes', () => {
  assert.deepEqual(parsePageRanges('1-3, 5, 8', 10), [0, 1, 2, 4, 7])
  assert.deepEqual(parsePageRanges('8-', 10), [7, 8, 9]) // open-ended means to the end
  assert.deepEqual(parsePageRanges('-3', 10), [0, 1, 2]) // open start means from page 1
  assert.deepEqual(parsePageRanges('3-1', 10), [2, 1, 0]) // descending ranges reverse
  assert.deepEqual(parsePageRanges('2, 2, 2', 10), [1]) // duplicates collapse
})

test('parsePageRanges rejects out-of-range and junk with friendly errors', () => {
  assert.throws(() => parsePageRanges('', 10), /at least one page/)
  assert.throws(() => parsePageRanges('11', 10), /only has 10 pages/)
  assert.throws(() => parsePageRanges('0', 10), /start at 1/)
  assert.throws(() => parsePageRanges('abc', 10), /isn't a page or range/)
})

test('chunkEveryN splits into consecutive groups', () => {
  assert.deepEqual(chunkEveryN(10, 3), [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]])
  assert.deepEqual(chunkEveryN(4, 2), [[0, 1], [2, 3]])
  assert.deepEqual(chunkEveryN(3, 10), [[0, 1, 2]])
  assert.throws(() => chunkEveryN(5, 0), /1 or more/)
})

test('splitByRanges makes one group per comma range', () => {
  assert.deepEqual(splitByRanges('1-3, 4-6', 6), [[0, 1, 2], [3, 4, 5]])
  assert.deepEqual(splitByRanges('1, 2-3', 3), [[0], [1, 2]])
  assert.throws(() => splitByRanges('', 6), /Enter ranges/)
})

test('reorder moves an item without mutating the source', () => {
  const src = ['a', 'b', 'c', 'd']
  assert.deepEqual(reorder(src, 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(reorder(src, 3, 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(src, ['a', 'b', 'c', 'd']) // unchanged
})

test('normalizeRotation snaps to 0/90/180/270', () => {
  assert.equal(normalizeRotation(90), 90)
  assert.equal(normalizeRotation(-90), 270)
  assert.equal(normalizeRotation(450), 90)
  assert.equal(normalizeRotation(270), 270)
  assert.equal(normalizeRotation(360), 0)
})

test('withSuffix inserts before the pdf extension', () => {
  assert.equal(withSuffix('report.pdf', '-part-1'), 'report-part-1.pdf')
  assert.equal(withSuffix('report.pdf', '-pages', 'pdf'), 'report-pages.pdf')
})

test('stampAnchor positions a stamp by corner', () => {
  const bc = stampAnchor('bottom-center', 600, 800, 24)
  assert.deepEqual(bc, { x: 300, y: 24, align: 'center', top: false })
  const tr = stampAnchor('top-right', 600, 800, 24)
  assert.deepEqual(tr, { x: 576, y: 776, align: 'right', top: true })
})
