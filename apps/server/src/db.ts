/**
 * PostgreSQL access. SQL is written with `?` placeholders (converted to $1…$n) so queries stay readable.
 * Counts come back as numbers, timestamps as ISO strings, dates as YYYY-MM-DD.
 * Inside `tx(fn)` every query must go through the `tx` handle passed to `fn`.
 */
import pg from 'pg'
import { migrate } from './migrations.js'

pg.types.setTypeParser(20, (v: string) => Number(v)) // int8: counts, sums, identities (all far below 2^53)
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString()) // timestamptz
pg.types.setTypeParser(1114, (v: string) => new Date(`${v}Z`).toISOString()) // timestamp
pg.types.setTypeParser(1082, (v: string) => v) // date

type Param = string | number | boolean | null | undefined

export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined>
  /** Returns the number of affected rows. */
  run(sql: string, ...params: Param[]): Promise<number>
  /** One transaction; rolled back if `fn` throws. Nested calls reuse the same transaction. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** `?` → `$n`, skipping quoted strings. */
export function toPg(sql: string): string {
  let n = 0
  let out = ''
  let quote: string | null = null
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue }
    out += ch === '?' ? `$${++n}` : ch
  }
  return out
}

type Queryable = pg.Pool | pg.PoolClient

function handle(q: Queryable, pool: pg.Pool | null): Db {
  const query = async (sql: string, params: Param[]) => q.query(toPg(sql), params.map(p => (p === undefined ? null : p)))
  const db: Db = {
    async all(sql, ...params) { return (await query(sql, params)).rows },
    async get(sql, ...params) { return (await query(sql, params)).rows[0] },
    async run(sql, ...params) { return (await query(sql, params)).rowCount ?? 0 },
    async tx(fn) {
      if (!pool) return fn(db) // already inside a transaction
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(handle(client, null))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    async close() { if (pool) await pool.end() },
  }
  return db
}

export interface OpenOptions {
  /** Run pending migrations (default true). */
  migrate?: boolean
  /** Use this schema (tests isolate each run in its own schema). */
  schema?: string
  max?: number
}

export async function openDb(url: string, options: OpenOptions = {}): Promise<Db> {
  if (options.schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema)) throw new Error('db: invalid schema name')
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  })
  pool.on('error', (error) => console.error('[db] idle client error:', error.message))
  const db = handle(pool, pool)
  if (options.migrate !== false) await migrate(db)
  return db
}

export function now(): string {
  return new Date().toISOString()
}
