/**
 * Pure, DOM-free helpers for the image tools. The actual pixel work (decode, draw, encode) happens on a <canvas> in
 * tools-image.tsx; everything here is maths and naming that we can unit-test in Node.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export const IMAGE_FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp']

/** The MIME type a canvas needs to encode a given format. */
export function mimeForFormat(f: ImageFormat): string {
  return f === 'jpeg' ? 'image/jpeg' : f === 'webp' ? 'image/webp' : 'image/png'
}

/** The file extension we give an output of a given format (JPEG keeps the familiar ".jpg"). */
export function extForFormat(f: ImageFormat): string {
  return f === 'jpeg' ? 'jpg' : f
}

/** A short upper-case label for the UI. */
export function formatLabel(f: ImageFormat): string {
  return f === 'jpeg' ? 'JPEG' : f.toUpperCase()
}

/** Whether a format's encoder honours the quality slider. PNG is lossless, so quality does nothing for it. */
export function formatUsesQuality(f: ImageFormat): boolean {
  return f === 'jpeg' || f === 'webp'
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Scale a width/height down to fit inside an optional max box, keeping the aspect ratio. Never enlarges — a smaller
 * image passes through untouched. Either bound may be left out. Returns whole pixels, at least 1.
 */
export function fitWithin(w: number, h: number, maxW?: number | null, maxH?: number | null): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) }
  let scale = 1
  if (maxW && maxW > 0) scale = Math.min(scale, maxW / w)
  if (maxH && maxH > 0) scale = Math.min(scale, maxH / h)
  if (scale >= 1) return { w: Math.round(w), h: Math.round(h) }
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/** Scale by a percentage of the original (100 = unchanged). Rounds to whole pixels, at least 1. */
export function scaleByPercent(w: number, h: number, percent: number): { w: number; h: number } {
  const p = Math.max(0, percent) / 100
  return { w: Math.max(1, Math.round(w * p)), h: Math.max(1, Math.round(h * p)) }
}

/** Swap a filename's extension (or append one if it has none). Keeps everything before the last dot. */
export function renameExt(name: string, ext: string): string {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.${ext}`
}

/** Add a suffix before the extension: ("photo.png", "-small") -> "photo-small.png". */
export function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}${suffix}`
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
}

/**
 * How much smaller (or larger) the output is, as a signed percentage. Positive means we saved space; negative means the
 * re-encode grew the file (which can happen, e.g. a photo saved as PNG). Returns 0 when there's nothing to compare.
 */
export function percentSaved(before: number, after: number): number {
  if (before <= 0) return 0
  return Math.round(((before - after) / before) * 100)
}
