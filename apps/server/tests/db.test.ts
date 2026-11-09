import { afterEach, describe, expect, it } from 'vitest'
import { testDb, type TestDb } from './helpers.js'

let t: TestDb | undefined
afterEach(async () => { await t?.drop(); t = undefined })

describe('PostgreSQL access layer', () => {
  it('converts ? placeholders, returns numbers for counts and ISO strings for timestamps', async () => {
    t = await testDb()
    const row = await t.db.get<{ n: number; at: string; d: string }>("SELECT count(*) AS n, ?::timestamptz AS at, ?::date AS d", '2026-11-10T08:30:00.000Z', '2026-11-25')
    expect(row).toEqual({ n: 1, at: '2026-11-10T08:30:00.000Z', d: '2026-11-25' })
  })

  it('rolls back a failed transaction completely', async () => {
    t = await testDb()
    await expect(t.db.tx(async tx => {
      await tx.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, now())", '00000000-0000-0000-0000-000000000001', 'a@example.cd')
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await t.db.get('SELECT 1 FROM users')).toBeUndefined()
  })

  it('creates every table of the schema and records the version', async () => {
    t = await testDb()
    const tables = (await t.db.all<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).map(r => r.table_name)
    for (const name of ['users', 'login_codes', 'sessions', 'organizations', 'memberships', 'consents', 'audit_log', 'blobs', 'credit_ledger',
      'agents', 'clients', 'contracts', 'documents', 'document_sessions', 'invoices', 'invoice_counters', 'jobs', 'idempotency', 'chat_sessions', 'chat_events', 'schema_migrations']) {
      expect(tables, name).toContain(name)
    }
    expect((await t.db.get<{ v: number }>('SELECT max(version) AS v FROM schema_migrations'))!.v).toBeGreaterThanOrEqual(1)
  })
})
