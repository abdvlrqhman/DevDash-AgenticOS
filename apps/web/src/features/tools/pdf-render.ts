import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// Vite turns this into a hashed asset URL and bundles the worker for production; pdf.js then runs off the main thread.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Thrown when a PDF is encrypted and the password is missing or wrong, so callers can prompt for one. */
export class PdfPasswordError extends Error {
  wrong: boolean
  constructor(wrong: boolean) {
    super(wrong ? 'That password is incorrect.' : 'This PDF is password-protected. Enter its password to continue.')
    this.name = 'PdfPasswordError'
    this.wrong = wrong
  }
}

/** Open a PDF with pdf.js (for rendering, counting pages, or decrypting). Translates password failures into PdfPasswordError. */
export async function loadPdf(data: ArrayBuffer | Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js transfers (and neuters) the buffer; hand it a private copy so the caller's bytes stay usable.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice()
  try {
    return await pdfjs.getDocument({ data: bytes, password }).promise
  } catch (e) {
    const err = e as { name?: string; code?: number }
    if (err?.name === 'PasswordException') {
      throw new PdfPasswordError(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
    }
    throw new Error("Couldn't open this PDF. It may be corrupt or not a PDF at all.")
  }
}

/** Render a page to a fresh canvas at the given scale (1 = 72 DPI). */
export async function renderPageToCanvas(doc: PDFDocumentProxy, pageNumber: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width))
  canvas.height = Math.max(1, Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser blocked the canvas needed to render PDFs.')
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  page.cleanup()
  return canvas
}

/** A small data-URL preview of a page, scaled to fit a max edge (for thumbnails). */
export async function renderThumbnail(doc: PDFDocumentProxy, pageNumber: number, maxEdge = 220): Promise<string> {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = maxEdge / Math.max(base.width, base.height)
  const canvas = await renderPageToCanvas(doc, pageNumber, scale)
  return canvas.toDataURL('image/png')
}

/** Render a page to an image blob at a chosen DPI (used by PDF -> JPG and the lossy compressor). */
export async function renderPageToImage(
  doc: PDFDocumentProxy, pageNumber: number, dpi: number, mime: 'image/jpeg' | 'image/png', quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const canvas = await renderPageToCanvas(doc, pageNumber, dpi / 72)
  if (mime === 'image/jpeg') {
    // JPEG has no transparency; paint white behind the page so edges don't go black.
    const painted = document.createElement('canvas')
    painted.width = canvas.width
    painted.height = canvas.height
    const ctx = painted.getContext('2d')
    if (!ctx) throw new Error('This browser blocked the canvas needed to render PDFs.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, painted.width, painted.height)
    ctx.drawImage(canvas, 0, 0)
    return blobFrom(painted, mime, quality)
  }
  return blobFrom(canvas, mime, quality)
}

function blobFrom(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve({ blob, width: canvas.width, height: canvas.height }) : reject(new Error('Rendering this page failed — it may be too large.')),
      mime, quality,
    )
  })
}

export { pdfjs }
