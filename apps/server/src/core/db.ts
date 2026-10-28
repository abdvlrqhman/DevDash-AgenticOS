import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)

export type Db = DatabaseSync

/** Opens the database and applies pending migrations (migrations/NNN_name.sql, tracked by PRAGMA user_version). */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on; pragma synchronous = normal;')

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
  const current = Number((db.prepare('pragma user_version').get() as { user_version: number }).user_version)
  for (let i = current; i < files.length; i++) {
    db.exec('begin')
    try {
      db.exec(readFileSync(new URL(files[i]!, MIGRATIONS_DIR), 'utf8'))
      db.exec(`pragma user_version = ${i + 1}`)
      db.exec('commit')
    } catch (err) {
      db.exec('rollback')
      throw new Error(`migration ${files[i]} failed: ${(err as Error).message}`)
    }
  }
  return db
}

export const now = () => Math.floor(Date.now() / 1000)

/** Runs fn in one transaction (node:sqlite has no helper). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('begin')
  try {
    const r = fn()
    db.exec('commit')
    return r
  } catch (err) {
    db.exec('rollback')
    throw err
  }
}
