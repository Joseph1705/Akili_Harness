import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { drainJobs } from '../src/jobs.js'
import { migrate, MIGRATIONS } from '../src/migrations.js'
import { createTestApp, readyOrg, TEST_DATABASE_URL, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('document credits', () => {
  it('keeps the balance when invoice generation fails, then charges once when it succeeds', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 5)
    // A real database failure while the invoice is written.
    await t.db.run(`CREATE FUNCTION fail_invoice() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'disk full'; END $f$`)
    await t.db.run('CREATE TRIGGER fail_invoice BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION fail_invoice()')
    await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    await drainJobs(t.app)
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(5)
    expect((await o.call('GET', '/api/invoices')).json().invoices).toHaveLength(0)

    // The failure is fixed; the retry generates the invoice and charges exactly one credit.
    await t.db.run('DROP TRIGGER fail_invoice ON invoices')
    await t.db.run("UPDATE jobs SET status = 'pending', attempts = 0, run_after = now()")
    await t.db.run("UPDATE documents SET status = 'queued'")
    await drainJobs(t.app)
    await drainJobs(t.app)
    const credits = (await o.call('GET', '/api/credits')).json()
    expect(credits.balance).toBe(4)
    expect(credits.entries.filter((e: { type: string }) => e.type === 'consumption')).toHaveLength(1)
    expect(credits.entries[0]).toMatchObject({ type: 'consumption', amount: -1, balance_before: 5, balance_after: 4 })
    expect(credits.entries[0].invoice_number).toMatch(/^P-/)
  })

  it('reports usage by day and flags a low balance', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 2)
    await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    await drainJobs(t.app)
    const usage = (await o.call('GET', '/api/credits/usage?period=day')).json()
    expect(usage.buckets).toHaveLength(30)
    expect(usage.buckets.at(-1).consumed).toBe(1)
    expect((await o.call('GET', '/api/credits')).json().wallet).toMatchObject({ balance: 1, low: true })
    expect((await o.call('PATCH', '/api/credits/settings', { low_balance_threshold: 0 })).statusCode).toBe(200)
    expect((await o.call('GET', '/api/credits')).json().wallet.low).toBe(false)
  })
})

describe('migration of the first credit ledger', () => {
  it('rebuilds wallets and a ledger with balances from the old journal', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`
    const admin = await openDb(TEST_DATABASE_URL, { migrate: false })
    await admin.run(`CREATE SCHEMA ${schema}`)
    const db = await openDb(TEST_DATABASE_URL, { schema, migrate: false })
    try {
      await db.run('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      await db.run(MIGRATIONS[0]!.sql)
      await db.run("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial schema')")
      const org = randomUUID()
      const doc = randomUUID()
      await db.run("INSERT INTO organizations (id, kind, name, plan) VALUES (?, 'company', 'Ancienne SARL (fictif)', 'entreprise')", org)
      await db.run("INSERT INTO credit_ledger (org_id, kind, amount, ref) VALUES (?, 'topup', 10, 'BIENVENUE')", org)
      await db.run("INSERT INTO credit_ledger (org_id, kind, amount, ref, document_id) VALUES (?, 'consume', -1, 'document', ?)", org, doc)
      await db.run("INSERT INTO credit_ledger (org_id, kind, amount, ref) VALUES (?, 'topup', 50, 'MPESA-77')", org)
      await migrate(db)
      expect(await db.get('SELECT balance, total_consumed, total_allocated FROM credit_wallets WHERE org_id = ?', org))
        .toEqual({ balance: 59, total_consumed: 1, total_allocated: 60 })
      const rows = await db.all('SELECT type, amount, balance_before, balance_after, operation_key, payment_reference FROM credit_transactions WHERE org_id = ? ORDER BY id', org)
      expect(rows).toEqual([
        { type: 'admin_allocation', amount: 10, balance_before: 0, balance_after: 10, operation_key: expect.stringMatching(/^legacy:/), payment_reference: null },
        { type: 'consumption', amount: -1, balance_before: 10, balance_after: 9, operation_key: `document:${doc}`, payment_reference: null },
        { type: 'admin_allocation', amount: 50, balance_before: 9, balance_after: 59, operation_key: expect.stringMatching(/^legacy:/), payment_reference: 'MPESA-77' },
      ])
    } finally {
      await db.close()
      await admin.run(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  })
})
