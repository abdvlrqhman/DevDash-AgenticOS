// Read-only data sources roles can look at. Keys stay on the server: roles get rows and text, never secrets.
import pg from 'pg'
import { AppError } from '../../core/http.ts'

export const SOURCE_KINDS = ['postgres', 'sqlite', 'http', 'page'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
export type SourceConfig = { path?: string; baseUrl?: string; secretIn?: 'header' | 'query'; secretName?: string; url?: string }

const MAX_ROWS = 200
const MAX_TEXT = 30_000
const TIMEOUT_MS = 15_000

/** One read-only statement: SELECT, WITH, EXPLAIN, SHOW, VALUES or TABLE, no second statement after a semicolon. */
export function readOnlySql(sql: string) {
  const s = sql.trim().replace(/;\s*$/, '')
  // Comments could hide a second statement from the checks below.
  if (/--|\/\*/.test(s)) throw new AppError(400, 'bad_sql', 'Leave out SQL comments.')
  if (s.includes(';')) throw new AppError(400, 'bad_sql', 'One statement at a time.')
  if (!/^(select|with|explain|show|values|table)\b/i.test(s)) throw new AppError(400, 'bad_sql', 'Only reading queries (SELECT, WITH, EXPLAIN, SHOW).')
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|attach|pragma)\b/i.test(s.replace(/'(?:[^']|'')*'/g, "''"))) {
    throw new AppError(400, 'bad_sql', 'Only reading queries: no statements that change anything.')
  }
  return s
}

/** Rows as a compact text table: header line, then one JSON array per row; cut at MAX_ROWS rows. */
export function rowsText(fields: string[], rows: unknown[][], total = rows.length) {
  const body = rows.slice(0, MAX_ROWS).map((r) => JSON.stringify(r)).join('\n')
  const more = total > MAX_ROWS ? `\n… ${total - MAX_ROWS} more rows (add a LIMIT or aggregate)` : ''
  return clip(`${JSON.stringify(fields)}\n${body}${more}`)
}
const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… cut at ${MAX_TEXT} characters` : t)

export async function queryPostgres(connectionString: string, sql: string) {
  const client = new pg.Client({ connectionString, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    await client.query('begin transaction read only')
    const r = await client.query({ text: readOnlySql(sql), rowMode: 'array' })
    await client.query('rollback')
    return rowsText(r.fields.map((f) => f.name), r.rows as unknown[][])
  } finally {
    await client.end().catch(() => {})
  }
}

/** GET under the source's base URL only (a role can't send the key anywhere else). */
export async function fetchHttp(config: SourceConfig, secret: string | null, path = '') {
  if (!config.baseUrl) throw new AppError(400, 'bad_source', 'This source has no base URL.')
  const base = new URL(config.baseUrl)
  const url = new URL(path.replace(/^\/+/, ''), base.href.endsWith('/') ? base.href : `${base.href}/`)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/?$/, ''))) {
    throw new AppError(400, 'bad_path', `Stay under ${config.baseUrl}.`)
  }
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' }
  if (secret && config.secretName) {
    if (config.secretIn === 'query') url.searchParams.set(config.secretName, secret)
    else headers[config.secretName] = secret
  }
  return getText(url, headers, secret)
}

/** A public page as plain text (scripts, styles and tags removed). */
export async function fetchPage(config: SourceConfig) {
  if (!config.url) throw new AppError(400, 'bad_source', 'This source has no URL.')
  const html = await getText(new URL(config.url), { accept: 'text/html, */*;q=0.5' }, null)
  return clip(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
}

async function getText(url: URL, headers: Record<string, string>, secret: string | null) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError(400, 'bad_url', 'Use an http(s) URL.')
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  let text = await res.text()
  if (secret) text = text.replaceAll(secret, '[key]') // an API that echoes the key back doesn't leak it
  if (!res.ok) throw new AppError(409, 'source_error', `The source answered ${res.status}: ${text.slice(0, 300)}`)
  try {
    text = JSON.stringify(JSON.parse(text), null, 1)
  } catch {
    // not JSON: as it is
  }
  return clip(text)
}
