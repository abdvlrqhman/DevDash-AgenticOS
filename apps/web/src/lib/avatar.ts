// Profile pictures: the member picks a square of their photo (features/account/AvatarCrop.tsx), and the browser shrinks
// just that square to a small JPEG before it uploads — a few dozen KB however big the original.

/** Where the square is: its centre in the photo's own pixels, and how far in it's zoomed (1 = the largest square). */
export type Crop = { cx: number; cy: number; zoom: number }
export const MAX_ZOOM = 6

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The side of the square, in the photo's pixels: the photo's short side at zoom 1, smaller as you zoom in. */
export const cropSide = (zoom: number, w: number, h: number) => Math.min(w, h) / zoom

/** Keeps the zoom in range and the square inside the photo. */
export function clampCrop(c: Crop, w: number, h: number): Crop {
  const zoom = clamp(c.zoom, 1, MAX_ZOOM)
  const half = cropSide(zoom, w, h) / 2
  return { zoom, cx: clamp(c.cx, half, w - half), cy: clamp(c.cy, half, h - half) }
}

/** The square a crop keeps, in the photo's pixels. */
export function cropRect(c: Crop, w: number, h: number) {
  const size = cropSide(c.zoom, w, h)
  return { x: c.cx - size / 2, y: c.cy - size / 2, size }
}

/** Opens a chosen file as an image (browsers apply the photo's own orientation). Revoke `url` when done. */
export async function loadPicture(file: File) {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new Error("That file isn't a picture this browser can open.")
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url)
    throw new Error('That picture is empty.')
  }
  return { img, url }
}

/** The chosen square, shrunk to `out` pixels, as a JPEG. */
export function cropToBlob(img: HTMLImageElement, rect: { x: number; y: number; size: number }, out = 256): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = out
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff' // a transparent PNG becomes a picture on white, not on black
  ctx.fillRect(0, 0, out, out)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, rect.x, rect.y, rect.size, rect.size, 0, 0, out, out)
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't prepare the picture."))), 'image/jpeg', 0.88))
}
