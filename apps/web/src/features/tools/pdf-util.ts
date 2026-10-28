/**
 * Pure, DOM-free helpers for the PDF tools. The structural edits run on pdf-lib and rendering on pdf.js
 * (see pdf-render.ts); everything here is parsing, naming and list maths we can unit-test in Node.
 *
 * Pages are 1-based in anything a person types; the arrays these functions return are 0-based page indexes, ready to
 * hand to pdf-lib's copyPages.
 */

/**
 * Parse a page-range spec like "1-3, 5, 8-" against a document of `total` pages. Returns 0-based indexes in the order
 * written, with duplicates removed (first win). "8-" means "8 to the end". Throws a readable error on anything invalid.
 */
export function parsePageRanges(spec: string, total: number): number[] {
  if (total <= 0) throw new Error('This PDF has no pages.')
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('Enter at least one page, e.g. 1-3, 5, 8.')
  const out: number[] = []
  const seen = new Set<number>()
  const add = (p: number) => {
    if (!seen.has(p)) { seen.add(p); out.push(p) }
  }
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim()
    if (!part) continue
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part)
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : 1
      const end = m[2] ? Number(m[2]) : total
      if (start < 1 || end < 1) throw new Error('Pages start at 1.')
      if (start > total || end > total) throw new Error(`This PDF only has ${total} page${total === 1 ? '' : 's'}.`)
      if (start <= end) for (let p = start; p <= end; p++) add(p - 1)
      else for (let p = start; p >= end; p--) add(p - 1)
      continue
    }
    if (/^\d+$/.test(part)) {
      const p = Number(part)
      if (p < 1) throw new Error('Pages start at 1.')
      if (p > total) throw new Error(`This PDF only has ${total} page${total === 1 ? '' : 's'}.`)
      add(p - 1)
      continue
    }
    throw new Error(`"${part}" isn't a page or range. Try 1-3, 5, 8.`)
  }
  if (out.length === 0) throw new Error('Enter at least one page, e.g. 1-3, 5, 8.')
  return out
}

/**
 * Split a document into groups of at most `n` consecutive pages: (10 pages, every 3) -> [[0,1,2],[3,4,5],[6,7,8],[9]].
 * Returns arrays of 0-based indexes.
 */
export function chunkEveryN(total: number, n: number): number[][] {
  if (total <= 0) throw new Error('This PDF has no pages.')
  if (!Number.isInteger(n) || n < 1) throw new Error('Pages per file must be a whole number of 1 or more.')
  const groups: number[][] = []
  for (let i = 0; i < total; i += n) {
    groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k))
  }
  return groups
}

/**
 * Split a document into one group per comma-separated range: "1-3, 4-6" -> [[0,1,2],[3,4,5]]. Each range is validated
 * the same way parsePageRanges validates a single run.
 */
export function splitByRanges(spec: string, total: number): number[][] {
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('Enter ranges, e.g. 1-3, 4-6.')
  const groups: number[][] = []
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim()
    if (!part) continue
    groups.push(parsePageRanges(part, total))
  }
  if (groups.length === 0) throw new Error('Enter ranges, e.g. 1-3, 4-6.')
  return groups
}

/** Move an item from one position to another, returning a new array (used for drag-to-reorder). */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice()
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** Normalise any degree value to one of 0 / 90 / 180 / 270. */
export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/** Add a suffix before a filename's extension: ("doc.pdf", "-part-1") -> "doc-part-1.pdf". */
export function withSuffix(name: string, suffix: string, ext = 'pdf'): string {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'document'}${suffix}.${ext}`
}

export type PageNumberPosition = 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left'

/** Where a stamp sits on the page, as fractions of width/height, plus how to anchor the text there. */
export function stampAnchor(pos: PageNumberPosition, w: number, h: number, margin: number): {
  x: number; y: number; align: 'left' | 'center' | 'right'; top: boolean
} {
  const top = pos.startsWith('top')
  const y = top ? h - margin : margin
  if (pos.endsWith('left')) return { x: margin, y, align: 'left', top }
  if (pos.endsWith('right')) return { x: w - margin, y, align: 'right', top }
  return { x: w / 2, y, align: 'center', top }
}
