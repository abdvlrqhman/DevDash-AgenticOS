import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampCrop, cropRect, cropSide, MAX_ZOOM } from './avatar.ts'

test('the chosen square: the short side at zoom 1, smaller as you zoom in, and never outside the photo', () => {
  // A 4000x3000 landscape photo, centred: the largest square is 3000 wide, in the middle.
  assert.deepEqual(cropRect({ cx: 2000, cy: 1500, zoom: 1 }, 4000, 3000), { x: 500, y: 0, size: 3000 })
  assert.equal(cropSide(2, 4000, 3000), 1500)
  // Dragged past the edge: pulled back so the square stays inside.
  assert.deepEqual(clampCrop({ cx: -500, cy: 9999, zoom: 1 }, 4000, 3000), { cx: 1500, cy: 1500, zoom: 1 })
  assert.deepEqual(cropRect(clampCrop({ cx: 9999, cy: -1, zoom: 2 }, 4000, 3000), 4000, 3000), { x: 2500, y: 0, size: 1500 })
  // Zoom stays between 1 and the maximum.
  assert.equal(clampCrop({ cx: 0, cy: 0, zoom: 0.2 }, 100, 100).zoom, 1)
  assert.equal(clampCrop({ cx: 0, cy: 0, zoom: 99 }, 100, 100).zoom, MAX_ZOOM)
  // A portrait photo: the square can move up and down, not sideways, at zoom 1.
  assert.deepEqual(clampCrop({ cx: 0, cy: 0, zoom: 1 }, 1080, 1920), { cx: 540, cy: 540, zoom: 1 })
  assert.deepEqual(clampCrop({ cx: 0, cy: 5000, zoom: 1 }, 1080, 1920), { cx: 540, cy: 1380, zoom: 1 })
})
