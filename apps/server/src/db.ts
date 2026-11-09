/** SQLite through Node's built-in driver. Access goes through this module so PostgreSQL can replace it (phase 1). */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations.js'

export interface Db extends DatabaseSync {
  /** Run `fn` in one transaction; rolled back if it throws. */
  tx<T>(fn: () => T): T
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path) as Db
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  let depth = 0
  db.tx = <T>(fn: () => T): T => {
    if (depth > 0) return fn()
    db.exec('BEGIN IMMEDIATE')
    depth++
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      depth--
    }
  }
  migrate(db)
  return db
}

export function now(): string {
  return new Date().toISOString()
}
