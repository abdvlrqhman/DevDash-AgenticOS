// Pure, dependency-free logic for the developer tools. Everything here runs in the browser (and in node for tests):
// no React, no DOM. Keep each function small, correct and independently testable.

/* ------------------------------------------------------------------ JSON ---- */

/** Pretty-print or minify JSON, with a helpful message (and line/column) when it doesn't parse. */
export function formatJson(input: string, { indent = 2, minify = false }: { indent?: number; minify?: boolean } = {}): string {
  const value = parseJson(input)
  return JSON.stringify(value, null, minify ? undefined : indent)
}

/** Parse JSON, turning the browser's terse error into one that points at the offending line and column. */
export function parseJson(input: string): unknown {
  const text = input.trim()
  if (!text) throw new Error('Nothing to parse yet.')
  try {
    return JSON.parse(text)
  } catch (e) {
    const msg = (e as Error).message
    const at = /position (\d+)/.exec(msg)
    if (at) {
      const pos = Number(at[1])
      const before = text.slice(0, pos)
      const line = before.split('\n').length
      const col = pos - before.lastIndexOf('\n')
      throw new Error(`${msg.replace(/ in JSON.*/, '')} (line ${line}, column ${col})`)
    }
    throw new Error(msg)
  }
}

/* ------------------------------------------------------------------ YAML ---- */
// A compact YAML implementation covering the common subset: nested mappings and sequences (by indentation),
// inline/flow collections, comments, and scalars (string/number/bool/null). Not a full YAML 1.2 parser
// (no anchors, tags, multi-document, block scalars), which is plenty for config snippets.

export function jsonToYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return yamlScalar(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((v) => {
      const body = jsonToYaml(v, indent + 1)
      return isCollection(v) ? `${pad}-\n${body}` : `${pad}- ${body}`
    }).join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries.map(([k, v]) => {
      const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
      if (isCollection(v) && (Array.isArray(v) ? v.length : Object.keys(v as object).length)) {
        return `${pad}${key}:\n${jsonToYaml(v, indent + 1)}`
      }
      return `${pad}${key}: ${jsonToYaml(v, indent + 1).trimStart()}`
    }).join('\n')
  }
  return String(value)
}

const isCollection = (v: unknown) => v !== null && typeof v === 'object'

function yamlScalar(s: string): string {
  if (s === '') return "''"
  // Quote anything that could be misread as another type or that contains structural characters.
  if (/^[\s]|[\s]$|[:#\[\]{}&*!|>'"%@`,]|^[-?]|^(true|false|null|~|yes|no|on|off)$/i.test(s) || /^[+-]?[\d.]/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

export function yamlToJson(input: string): unknown {
  const lines: { indent: number; text: string }[] = []
  for (const raw of input.split('\n')) {
    const noComment = stripComment(raw)
    if (!noComment.trim()) continue
    lines.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() })
  }
  const firstLine = lines[0]
  if (!firstLine) return null
  let i = 0
  const parseBlock = (): unknown => {
    const first = lines[i]
    if (!first) return null
    const indent = first.indent
    if (first.text.startsWith('- ') || first.text === '-') {
      const arr: unknown[] = []
      for (let cur = lines[i]; cur && cur.indent === indent && (cur.text.startsWith('- ') || cur.text === '-'); cur = lines[i]) {
        const rest = cur.text === '-' ? '' : cur.text.slice(2).trim()
        i++
        if (!rest) {
          const next = lines[i]
          arr.push(next && next.indent > indent ? parseBlock() : null)
        } else if (/^[^:\s][^:]*:(\s|$)/.test(rest) && !isFlow(rest)) {
          // A sequence item that starts a mapping: re-feed it as a synthetic line at a deeper indent.
          lines.splice(i, 0, { indent: indent + 2, text: rest })
          arr.push(parseBlock())
        } else {
          arr.push(parseScalar(rest))
        }
      }
      return arr
    }
    const obj: Record<string, unknown> = {}
    for (let cur = lines[i]; cur && cur.indent === indent; cur = lines[i]) {
      const line = cur.text
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?):\s*(.*)$/.exec(line)
      if (!m || m[1] === undefined) throw new Error(`Can't parse line: ${line}`)
      const key = String(parseScalar(m[1]))
      const value = m[2] ?? ''
      i++
      if (value === '') {
        const next = lines[i]
        obj[key] = next && next.indent > indent ? parseBlock() : null
      } else {
        obj[key] = parseScalar(value)
      }
    }
    return obj
  }
  return parseBlock()
}

const stripComment = (line: string): string => {
  let inS = false, inD = false
  for (let j = 0; j < line.length; j++) {
    const c = line[j]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === '#' && !inS && !inD && (j === 0 || /\s/.test(line[j - 1] ?? ''))) return line.slice(0, j)
  }
  return line
}

const isFlow = (s: string) => /^[[{]/.test(s.trim())

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return s === '' ? '' : null
  if (s === 'true' || s === 'True') return true
  if (s === 'false' || s === 'False') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s) || /^-?\d+[eE][+-]?\d+$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s)
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('[') || s.startsWith('{')) {
    // Flow collections: coax into JSON (bare keys/values get quoted) and parse.
    try { return JSON.parse(flowToJson(s)) } catch { return s }
  }
  return s
}

function flowToJson(s: string): string {
  // Quote bare words that aren't numbers/bools/null, inside [ ] and { } flow collections.
  return s.replace(/([{[,:]\s*)([A-Za-z_][\w -]*?)(\s*[,:}\]])/g, (_m, a, word, b) => {
    const w = word.trim()
    const keep = w === 'true' || w === 'false' || w === 'null' || /^-?\d/.test(w)
    return `${a}${keep ? w : JSON.stringify(w)}${b}`
  })
}

/* ---------------------------------------------------------------- base 64 --- */

export function encodeBase64(text: string, urlSafe = false): string {
  const b64 = bytesToBase64(new TextEncoder().encode(text))
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64
}

export function decodeBase64(text: string): string {
  return new TextDecoder().decode(base64ToBytes(text))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0)
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const norm = b64.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ URL ----- */

export const encodeUrl = (s: string) => encodeURIComponent(s)
export const decodeUrl = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '))
export const encodeUrlFull = (s: string) => encodeURI(s)
export const decodeUrlFull = (s: string) => decodeURI(s)

/* ------------------------------------------------------------- HTML entities */

const NAMED: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }
export function encodeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${NAMED[c]};`)
}
export function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, n) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n as string] ?? _m)
}

/* ---------------------------------------------------------------- numbers --- */

export function parseInBase(value: string, base: number): bigint {
  const s = value.trim().toLowerCase().replace(/[\s_]+/g, '')
  if (!s) throw new Error('Enter a number.')
  const neg = s.startsWith('-')
  const body = (neg ? s.slice(1) : s).replace(/^0[xbo]/, '')
  if (!body) throw new Error('Enter a number.')
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  const b = BigInt(base)
  let acc = 0n
  for (const ch of body) {
    const d = digits.indexOf(ch)
    if (d < 0 || d >= base) throw new Error(`"${ch}" isn't a valid digit in base ${base}.`)
    acc = acc * b + BigInt(d)
  }
  return neg ? -acc : acc
}

export function toBase(n: bigint, base: number): string {
  if (n === 0n) return '0'
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  const neg = n < 0n
  let x = neg ? -n : n
  const b = BigInt(base)
  let out = ''
  while (x > 0n) { out = digits[Number(x % b)] + out; x /= b }
  return neg ? `-${out}` : out
}

export const convertBase = (value: string, from: number, to: number): string => toBase(parseInBase(value, from), to)

/* ------------------------------------------------------------------ case ---- */

export type CaseKind = 'camel' | 'pascal' | 'snake' | 'kebab' | 'constant' | 'title' | 'sentence' | 'dot' | 'path' | 'upper' | 'lower'

export function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\\/\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function toCase(input: string, kind: CaseKind): string {
  if (kind === 'upper') return input.toUpperCase()
  if (kind === 'lower') return input.toLowerCase()
  const words = splitWords(input).map((w) => w.toLowerCase())
  switch (kind) {
    case 'camel': return words.map((w, i) => (i ? cap(w) : w)).join('')
    case 'pascal': return words.map(cap).join('')
    case 'snake': return words.join('_')
    case 'kebab': return words.join('-')
    case 'constant': return words.join('_').toUpperCase()
    case 'dot': return words.join('.')
    case 'path': return words.join('/')
    case 'title': return words.map(cap).join(' ')
    case 'sentence': return words.map((w, i) => (i ? w : cap(w))).join(' ')
  }
}

/* ----------------------------------------------------------------- slugify -- */

export function slugify(input: string, sep = '-'): string {
  const e = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`${e}{2,}`, 'g'), sep)
    .replace(new RegExp(`^${e}+|${e}+$`, 'g'), '')
}

/* ------------------------------------------------------------------ color --- */

export type Rgb = { r: number; g: number; b: number; a: number }

export function parseColor(input: string): Rgb {
  const s = input.trim().toLowerCase()
  const hexM = /^#?([0-9a-f]{3,8})$/.exec(s)
  if (hexM?.[1]) {
    const h = hexM[1]
    const g = (idx: number) => h[idx] ?? '0'
    if (h.length === 3) return { r: dup(g(0)), g: dup(g(1)), b: dup(g(2)), a: 1 }
    if (h.length === 4) return { r: dup(g(0)), g: dup(g(1)), b: dup(g(2)), a: dup(g(3)) / 255 }
    if (h.length === 6) return { r: hx(h, 0), g: hx(h, 2), b: hx(h, 4), a: 1 }
    if (h.length === 8) return { r: hx(h, 0), g: hx(h, 2), b: hx(h, 4), a: hx(h, 6) / 255 }
  }
  const rgbM = /^rgba?\(([^)]+)\)$/.exec(s)
  if (rgbM?.[1]) {
    const p = rgbM[1].split(/[,/\s]+/).filter(Boolean)
    return { r: clampByte(num(p[0])), g: clampByte(num(p[1])), b: clampByte(num(p[2])), a: p[3] != null ? pct(p[3]) : 1 }
  }
  const hslM = /^hsla?\(([^)]+)\)$/.exec(s)
  if (hslM?.[1]) {
    const p = hslM[1].split(/[,/\s]+/).filter(Boolean)
    return { ...hslToRgb(num(p[0]), pctOf(p[1]), pctOf(p[2])), a: p[3] != null ? pct(p[3]) : 1 }
  }
  throw new Error('Unrecognised colour. Try #3b82f6, rgb(59 130 246) or hsl(217 91% 60%).')
}

const dup = (c: string) => parseInt(c + c, 16)
const hx = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16)
const num = (s: string | undefined) => Number(s ?? NaN)
const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
const pct = (s: string | undefined) => (s?.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s ?? '0'))
const pctOf = (s: string | undefined) => parseFloat(s ?? '0') / 100

export const toHex = ({ r, g, b, a }: Rgb): string => {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(Math.round(a * 255)) : ''}`
}

export const toRgbString = ({ r, g, b, a }: Rgb): string =>
  a < 1 ? `rgba(${r}, ${g}, ${b}, ${round(a, 2)})` : `rgb(${r}, ${g}, ${b})`

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  let h = 0, s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0)
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) }
}

export const toHslString = (rgb: Rgb): string => {
  const { h, s, l } = rgbToHsl(rgb)
  return rgb.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${round(rgb.a, 2)})` : `hsl(${h}, ${s}%, ${l}%)`
}

const round = (n: number, p: number) => Math.round(n * 10 ** p) / 10 ** p

/* ------------------------------------------------------------- timestamps --- */

export function unixToDate(input: string): { iso: string; local: string; utc: string; relative: string } {
  const n = Number(input.trim())
  if (!input.trim() || Number.isNaN(n)) throw new Error('Enter a Unix timestamp (seconds or milliseconds).')
  const ms = Math.abs(n) < 1e12 ? n * 1000 : n // treat < ~2001-in-ms as seconds
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) throw new Error('That timestamp is out of range.')
  return {
    iso: d.toISOString(),
    local: d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' }),
    utc: d.toUTCString(),
    relative: relativeTime(d.getTime() - Date.now()),
  }
}

export function dateToUnix(input: string): { seconds: number; millis: number } {
  const d = input.trim() ? new Date(input) : new Date()
  if (Number.isNaN(d.getTime())) throw new Error('Enter a date like 2025-01-31 14:30 or an ISO string.')
  return { seconds: Math.floor(d.getTime() / 1000), millis: d.getTime() }
}

export function relativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs)
  const units: [number, string][] = [[31536e6, 'year'], [2592e6, 'month'], [864e5, 'day'], [36e5, 'hour'], [6e4, 'minute'], [1e3, 'second']]
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const v = Math.round(deltaMs / ms)
      const n = Math.abs(v)
      return v <= 0 ? `${n} ${name}${n === 1 ? '' : 's'} ago` : `in ${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return 'just now'
}

/* ----------------------------------------------------------------- lines ---- */

export type LineOp = { op: 'same' | 'add' | 'remove'; left?: string; right?: string }

/** Classic LCS line diff — the shape the two-pane diff view renders. */
export function diffLines(a: string, b: string): LineOp[] {
  const A = a.split('\n'), B = b.split('\n')
  const n = A.length, m = B.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const at = (y: number, x: number) => dp[y]?.[x] ?? 0
  for (let y = n - 1; y >= 0; y--) {
    const row = dp[y]!
    for (let x = m - 1; x >= 0; x--) row[x] = A[y] === B[x] ? at(y + 1, x + 1) + 1 : Math.max(at(y + 1, x), at(y, x + 1))
  }
  const out: LineOp[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: 'same', left: A[i], right: B[j] }); i++; j++ }
    else if (at(i + 1, j) >= at(i, j + 1)) { out.push({ op: 'remove', left: A[i] }); i++ }
    else { out.push({ op: 'add', right: B[j] }); j++ }
  }
  while (i < n) out.push({ op: 'remove', left: A[i++] })
  while (j < m) out.push({ op: 'add', right: B[j++] })
  return out
}

export function transformLines(text: string, opts: { trim?: boolean; dedup?: boolean; sort?: 'asc' | 'desc' | 'none'; removeEmpty?: boolean; caseInsensitive?: boolean }): string {
  let lines = text.split('\n')
  if (opts.trim) lines = lines.map((l) => l.trim())
  if (opts.removeEmpty) lines = lines.filter((l) => l.trim() !== '')
  if (opts.dedup) {
    const seen = new Set<string>()
    lines = lines.filter((l) => { const k = opts.caseInsensitive ? l.toLowerCase() : l; if (seen.has(k)) return false; seen.add(k); return true })
  }
  if (opts.sort && opts.sort !== 'none') {
    lines.sort((x, y) => (opts.caseInsensitive ? x.toLowerCase().localeCompare(y.toLowerCase()) : x.localeCompare(y)))
    if (opts.sort === 'desc') lines.reverse()
  }
  return lines.join('\n')
}

export function countText(text: string): { chars: number; charsNoSpaces: number; words: number; lines: number; bytes: number } {
  return {
    chars: [...text].length,
    charsNoSpaces: [...text.replace(/\s/g, '')].length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    lines: text === '' ? 0 : text.split('\n').length,
    bytes: new TextEncoder().encode(text).length,
  }
}

/* ------------------------------------------------------------------- JWT ---- */

export type Jwt = { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string; expired: boolean | null; expiresAt: string | null; issuedAt: string | null }

export function decodeJwt(token: string): Jwt {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('A JWT has three parts separated by dots (header.payload.signature).')
  const json = (seg: string) => {
    try { return JSON.parse(decodeBase64(seg)) } catch { throw new Error('This doesn\'t look like a valid base64url JWT segment.') }
  }
  const header = json(parts[0] ?? '')
  const payload = json(parts[1] ?? '')
  const exp = typeof payload.exp === 'number' ? payload.exp : null
  const iat = typeof payload.iat === 'number' ? payload.iat : null
  return {
    header, payload, signature: parts[2] ?? '',
    expired: exp === null ? null : exp * 1000 < Date.now(),
    expiresAt: exp === null ? null : new Date(exp * 1000).toISOString(),
    issuedAt: iat === null ? null : new Date(iat * 1000).toISOString(),
  }
}

/* -------------------------------------------------------- query <-> JSON ---- */

export function queryToJson(query: string): Record<string, unknown> {
  const params = new URLSearchParams(query.replace(/^[?#]/, ''))
  const out: Record<string, unknown> = {}
  for (const [k, v] of params) {
    if (k in out) out[k] = Array.isArray(out[k]) ? [...(out[k] as unknown[]), v] : [out[k], v]
    else out[k] = v
  }
  return out
}

export function jsonToQuery(input: string): string {
  const obj = parseJson(input)
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Provide a JSON object of key/value pairs.')
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)))
    else params.append(k, v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return params.toString()
}

/* ------------------------------------------------------------ passwords ----- */

const SETS = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!@#$%^&*-_=+?' }
export function randomString(length: number, opts: { lower?: boolean; upper?: boolean; digits?: boolean; symbols?: boolean }): string {
  let pool = ''
  if (opts.lower) pool += SETS.lower
  if (opts.upper) pool += SETS.upper
  if (opts.digits) pool += SETS.digits
  if (opts.symbols) pool += SETS.symbols
  if (!pool) throw new Error('Pick at least one character set.')
  const buf = new Uint32Array(length)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < length; i++) out += pool[(buf[i] ?? 0) % pool.length] ?? ''
  return out
}

/* --------------------------------------------------------------- lorem ------ */

const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna ' +
  'aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure ' +
  'reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui ' +
  'officia deserunt mollit anim id est laborum').split(' ')

export function lorem(count: number, unit: 'words' | 'sentences' | 'paragraphs'): string {
  const word = () => LOREM[Math.floor(Math.random() * LOREM.length)]
  const sentence = () => {
    const len = 6 + Math.floor(Math.random() * 10)
    const s = Array.from({ length: len }, word).join(' ')
    return cap(s) + '.'
  }
  const paragraph = () => Array.from({ length: 3 + Math.floor(Math.random() * 3) }, sentence).join(' ')
  if (unit === 'words') return cap(Array.from({ length: count }, word).join(' '))
  if (unit === 'sentences') return Array.from({ length: count }, sentence).join(' ')
  return Array.from({ length: count }, paragraph).join('\n\n')
}

/* ----------------------------------------------------------------- cron ----- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}

type CronField = { values: Set<number>; star: boolean; raw: string }
export type Cron = { minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField }

function parseCronField(raw: string, min: number, max: number, names?: string[]): CronField {
  const star = raw === '*' // a *pure* wildcard; "*/n" is a restriction, not a wildcard
  const values = new Set<number>()
  const nameIdx = (t: string): number => {
    const i = names ? names.indexOf(t.toLowerCase()) : -1
    const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : Number(t)
    if (Number.isNaN(n)) throw new Error(`"${t}" isn't valid here.`)
    return n
  }
  for (const part of raw.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/')
    const range = rangeRaw ?? '*'
    const step = stepRaw ? Number(stepRaw) : 1
    if (!step || step < 1) throw new Error(`Bad step "/${stepRaw}".`)
    let lo: number, hi: number
    if (range === '*') { lo = min; hi = max }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = nameIdx(a ?? ''); hi = nameIdx(b ?? '') }
    else { lo = nameIdx(range); hi = stepRaw ? max : lo }
    for (let v = lo; v <= hi; v += step) {
      let n = v
      if (names === DAYS && n === 7) n = 0
      if (n < min || n > max) throw new Error(`Value ${n} is out of range (${min}-${max}).`)
      values.add(n)
    }
  }
  return { values, star, raw }
}

export function parseCron(expr: string): Cron {
  const trimmed = expr.trim()
  const normalised = ALIASES[trimmed.toLowerCase()] ?? trimmed
  const parts = normalised.split(/\s+/)
  const [mi, ho, dm, mo, dw] = parts
  if (parts.length !== 5 || !mi || !ho || !dm || !mo || !dw) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week.')
  return {
    minute: parseCronField(mi, 0, 59),
    hour: parseCronField(ho, 0, 23),
    dom: parseCronField(dm, 1, 31),
    month: parseCronField(mo, 1, 12, MONTHS),
    dow: parseCronField(dw, 0, 6, DAYS),
  }
}

function cronMatches(c: Cron, d: Date): boolean {
  const minOk = c.minute.values.has(d.getMinutes())
  const hourOk = c.hour.values.has(d.getHours())
  const monthOk = c.month.values.has(d.getMonth() + 1)
  const domOk = c.dom.values.has(d.getDate())
  const dowOk = c.dow.values.has(d.getDay())
  // Standard crontab rule: when both day-of-month and day-of-week are restricted, either may match.
  const dayOk = c.dom.star || c.dow.star ? domOk && dowOk : domOk || dowOk
  return minOk && hourOk && monthOk && dayOk
}

export function nextCronRuns(c: Cron, from: Date = new Date(), count = 5): Date[] {
  const out: Date[] = []
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let guard = 0; guard < 366 * 24 * 60 && out.length < count; guard++) {
    if (cronMatches(c, d)) out.push(new Date(d.getTime()))
    d.setMinutes(d.getMinutes() + 1)
  }
  return out
}

function describeField(f: CronField, unit: string, point: (n: number) => string): string {
  const step = /^\*\/(\d+)$/.exec(f.raw)
  if (step) return `every ${step[1]} ${unit}s`
  if (f.star) return `every ${unit}`
  const vals = [...f.values].sort((a, b) => a - b)
  if (vals.length === 1 && vals[0] !== undefined) return point(vals[0])
  return vals.map(point).join(', ')
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function describeCron(expr: string): string {
  const c = parseCron(expr)
  // Time of day.
  let time: string
  if (c.minute.star && c.hour.star) time = 'Every minute'
  else if (!c.minute.star && c.hour.star) {
    const stepM = /^\*\/(\d+)$/.exec(c.minute.raw)
    time = stepM ? `Every ${stepM[1]} minutes` : `At ${describeField(c.minute, 'minute', (n) => `minute ${n}`)} of every hour`
  } else if (c.minute.star && !c.hour.star) time = `Every minute during ${describeField(c.hour, 'hour', (n) => `${pad2(n)}:00`)}`
  else {
    const mins = [...c.minute.values]
    const hours = [...c.hour.values]
    const mm = mins[0] ?? 0
    if (mins.length === 1 && hours.length <= 4) time = `At ${hours.sort((a, b) => a - b).map((h) => `${pad2(h)}:${pad2(mm)}`).join(', ')}`
    else time = `At minute ${describeField(c.minute, 'minute', (n) => String(n))} past ${describeField(c.hour, 'hour', (n) => `${pad2(n)}:00`)}`
  }
  // Day.
  const parts: string[] = []
  if (!c.dom.star) parts.push(`on day-of-month ${describeField(c.dom, 'day', (n) => String(n))}`)
  if (!c.month.star) parts.push(`in ${describeField(c.month, 'month', (n) => MONTH_NAMES[n - 1] ?? String(n))}`)
  if (!c.dow.star) parts.push(`on ${describeField(c.dow, 'day', (n) => DAY_NAMES[n] ?? String(n))}`)
  return parts.length ? `${time}, ${parts.join(', ')}.` : `${time}.`
}
