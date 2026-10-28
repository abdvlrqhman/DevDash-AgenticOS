// Read-only SQLite queries in the member's own files (DevDash features that look at a project's data, e.g. team roles).
import { DatabaseSync } from 'node:sqlite'

const MAX_ROWS = 200

export function query(path: unknown, sql: unknown) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Use a full path to the database file.')
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('missing sql')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('pragma query_only = on')
    const stmt = db.prepare(sql)
    const fields = stmt.columns().map((c) => c.name)
    const rows: unknown[][] = []
    let total = 0
    for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length < MAX_ROWS) rows.push(fields.map((f) => r[f]))
      if (++total > 10_000) break
    }
    return { fields, rows, total }
  } finally {
    db.close()
  }
}
