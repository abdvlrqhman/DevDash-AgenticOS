import { execFile } from 'node:child_process'
import { AppError } from '../../core/http.ts'

type Word = { text: string; x: number; y: number; w: number; h: number }
export type Screen = Word[][]

/** Tesseract TSV includes word boxes, grouped by block, paragraph and line. */
export function screenLines(tsv: string): Screen {
  const lines = new Map<string, Word[]>()
  for (const row of tsv.split('\n')) {
    const [level, page, block, paragraph, line, , left, top, width, height, confidence, ...rest] = row.split('\t')
    const text = rest.join(' ').trim()
    if (level !== '5' || !text || Number(confidence) < 15) continue
    const key = [page, block, paragraph, line].join('/')
    const words = lines.get(key) ?? []
    words.push({ text, x: Number(left), y: Number(top), w: Number(width), h: Number(height) })
    lines.set(key, words)
  }
  return [...lines.values()]
}

export async function readScreen(jpeg: Buffer): Promise<Screen> {
  const tsv = await new Promise<string>((resolve, reject) => {
    const proc = execFile('tesseract', ['stdin', 'stdout', '--psm', '11', 'tsv'], {
      timeout: 12_000, maxBuffer: 2_000_000, env: { ...process.env, OMP_THREAD_LIMIT: '2' },
    }, (err, out) => {
      if (err) reject(new AppError(409, 'browser_ocr', 'Could not read the browser screen. Check that Tesseract OCR is installed on the server.'))
      else resolve(out)
    })
    proc.stdin?.on('error', () => {}) // execFile reports launch and timeout errors through the callback
    proc.stdin?.end(jpeg)
  })
  return screenLines(tsv)
}

export function clickPoint(screen: Screen, label: string) {
  const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
  const wanted = normalize(label.trim()).split(/\s+/)
  const matches = []
  for (const words of screen) {
    for (const [i, first] of words.entries()) {
      if (first.y < 100 || !wanted.every((word, n) => normalize(words[i + n]?.text ?? '') === word)) continue
      const last = words[i + wanted.length - 1]!
      matches.push({ x: Math.round((first.x + last.x + last.w) / 2), y: Math.round(first.y + first.h / 2) })
    }
  }
  if (matches.length !== 1) throw new AppError(409, 'browser_target', matches.length
    ? 'That label appears more than once. Give me a longer visible label to click.'
    : 'I couldn’t find that label on the current page. Use the text visible on the screen.')
  return matches[0]!
}

/** Visible page lines (y >= 100, excluding browser chrome) with clickable center coordinates. */
export function screenSnapshot(screen: Screen): string {
  const rows: { x: number; y: number; text: string }[] = []
  for (const words of screen) {
    const visible = words.filter((w) => w.y >= 100)
    if (!visible.length) continue
    const first = visible[0]!
    const last = visible.at(-1)!
    const top = Math.min(...visible.map((w) => w.y))
    const bottom = Math.max(...visible.map((w) => w.y + w.h))
    rows.push({
      x: Math.round((first.x + last.x + last.w) / 2),
      y: Math.round((top + bottom) / 2),
      text: visible.map((w) => w.text).join(' '),
    })
  }
  rows.sort((a, b) => Math.round(a.y / 16) - Math.round(b.y / 16) || a.x - b.x)
  return rows.slice(0, 150).map((r) => `(${r.x},${r.y}) ${r.text}`).join('\n').slice(0, 10_000)
}
