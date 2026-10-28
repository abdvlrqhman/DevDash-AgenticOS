import { fitWithin, mimeForFormat, type ImageFormat } from './image-lib'

/**
 * Canvas-backed image work for the image tools. Decoding uses the browser's own codecs, so whatever the browser can
 * open (PNG, JPEG, WebP, GIF, usually AVIF; HEIC only on Safari) decodes here, and anything it can't fails cleanly.
 */

export type DecodedImage = { bitmap: ImageBitmap; width: number; height: number }

/** Decode a file to an ImageBitmap, honouring EXIF orientation. Throws a readable error on formats the browser can't open. */
export async function decodeImage(file: File): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    const hint = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
      ? " This looks like a HEIC/HEIF photo, which most browsers can't open. Convert it to JPEG on your phone first."
      : ''
    throw new Error(`Couldn't read "${file.name}". It may be corrupt or a format this browser can't decode.${hint}`)
  }
}

/** Encode a canvas to a Blob in the chosen format and quality. Rejects if the browser can't produce that format. */
export function canvasToBlob(canvas: HTMLCanvasElement, format: ImageFormat, quality: number): Promise<Blob> {
  const mime = mimeForFormat(format)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.type === mime) return resolve(blob)
        if (blob && format === 'png') return resolve(blob) // png has no quality arg; type always matches
        if (blob) return reject(new Error(`This browser can't save ${format.toUpperCase()} images.`))
        reject(new Error('Encoding failed — the image may be too large.'))
      },
      mime,
      quality,
    )
  })
}

export type EncodeOptions = {
  format: ImageFormat
  /** 0..1, ignored for PNG. */
  quality: number
  maxW?: number | null
  maxH?: number | null
  /** Resize to an exact size instead of fitting within a box (used by the resizer). */
  exact?: { w: number; h: number }
}

/** The full pipeline: decode -> (resize) -> re-encode. Returns the output blob and its final pixel size. */
export async function processImage(file: File, opts: EncodeOptions): Promise<{ blob: Blob; width: number; height: number }> {
  const img = await decodeImage(file)
  const target = opts.exact
    ? { w: Math.max(1, Math.round(opts.exact.w)), h: Math.max(1, Math.round(opts.exact.h)) }
    : fitWithin(img.width, img.height, opts.maxW, opts.maxH)

  const canvas = document.createElement('canvas')
  canvas.width = target.w
  canvas.height = target.h
  const ctx = canvas.getContext('2d')
  if (!ctx) { img.bitmap.close?.(); throw new Error('This browser blocked the canvas needed to process images.') }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (opts.format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, target.w, target.h) } // JPEG has no alpha
  ctx.drawImage(img.bitmap, 0, 0, target.w, target.h)
  img.bitmap.close?.()

  const blob = await canvasToBlob(canvas, opts.format, opts.quality)
  return { blob, width: target.w, height: target.h }
}

/** Render one square icon at a given edge size, centred with transparent padding. Used by the favicon tool. */
export async function renderIcon(img: DecodedImage, size: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser blocked the canvas needed to process images.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const { w, h } = fitWithin(img.width, img.height, size, size)
  ctx.drawImage(img.bitmap, (size - w) / 2, (size - h) / 2, w, h)
  return canvasToBlob(canvas, 'png', 1)
}
