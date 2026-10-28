import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extForFormat, fitWithin, formatLabel, formatUsesQuality, mimeForFormat, percentSaved, renameExt, scaleByPercent,
  withSuffix,
} from './image-lib.ts'

test('format metadata maps to mime, extension and label', () => {
  assert.equal(mimeForFormat('png'), 'image/png')
  assert.equal(mimeForFormat('jpeg'), 'image/jpeg')
  assert.equal(mimeForFormat('webp'), 'image/webp')
  assert.equal(extForFormat('jpeg'), 'jpg')
  assert.equal(extForFormat('png'), 'png')
  assert.equal(formatLabel('jpeg'), 'JPEG')
  assert.equal(formatLabel('webp'), 'WEBP')
  assert.equal(formatUsesQuality('png'), false)
  assert.equal(formatUsesQuality('jpeg'), true)
})

test('fitWithin scales down to a box but never enlarges', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1000, null), { w: 1000, h: 750 })
  assert.deepEqual(fitWithin(3000, 4000, null, 1000), { w: 750, h: 1000 })
  // Constrained by whichever bound bites first.
  assert.deepEqual(fitWithin(4000, 2000, 1000, 1000), { w: 1000, h: 500 })
  // Already smaller: untouched.
  assert.deepEqual(fitWithin(800, 600, 1000, 1000), { w: 800, h: 600 })
  // No bounds: untouched.
  assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600 })
  // Never drops below 1px.
  assert.deepEqual(fitWithin(1000, 10, 5, null), { w: 5, h: 1 })
})

test('scaleByPercent scales both sides', () => {
  assert.deepEqual(scaleByPercent(1000, 500, 50), { w: 500, h: 250 })
  assert.deepEqual(scaleByPercent(1000, 500, 100), { w: 1000, h: 500 })
  assert.deepEqual(scaleByPercent(1000, 500, 200), { w: 2000, h: 1000 })
  assert.deepEqual(scaleByPercent(3, 3, 10), { w: 1, h: 1 }) // rounds up to at least 1
})

test('filename helpers swap and suffix extensions', () => {
  assert.equal(renameExt('photo.HEIC', 'jpg'), 'photo.jpg')
  assert.equal(renameExt('no-extension', 'png'), 'no-extension.png')
  assert.equal(renameExt('archive.tar.gz', 'webp'), 'archive.tar.webp')
  assert.equal(withSuffix('photo.png', '-small'), 'photo-small.png')
  assert.equal(withSuffix('noext', '-small'), 'noext-small')
})

test('percentSaved reports signed savings', () => {
  assert.equal(percentSaved(1000, 250), 75)
  assert.equal(percentSaved(1000, 1200), -20) // re-encode grew the file
  assert.equal(percentSaved(0, 100), 0)
})
