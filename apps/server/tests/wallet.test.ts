import { afterEach, describe, expect, it } from 'vitest'
import { applyCredit, getWallet, InsufficientCredits } from '../src/billing/wallet.js'
import { createTestApp, type TestContext } from './helpers.js'
import { createOrg } from './fixtures.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('credit wallet and ledger', () => {
  it('records every operation with the balance before and after', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await applyCredit(t.db, { orgId: org, type: 'purchase', amount: 100, operationKey: 'payment:1', paymentReference: 'SAS-1' })
    await applyCredit(t.db, { orgId: org, type: 'consumption', amount: -1, operationKey: 'document:a' })
    await applyCredit(t.db, { orgId: org, type: 'refund', amount: 1, operationKey: 'refund:a', reason: 'Extraction erronée' })
    await applyCredit(t.db, { orgId: org, type: 'admin_allocation', amount: 5, operationKey: 'promo:1', reason: 'Promotion' })
    await applyCredit(t.db, { orgId: org, type: 'admin_correction', amount: -2, operationKey: 'fix:1', reason: 'Erreur de saisie' })
    const wallet = await getWallet(t.db, org)
    expect(wallet).toMatchObject({ balance: 103, total_purchased: 100, total_consumed: 1, total_refunded: 1, total_allocated: 5 })
    const rows = await t.db.all<{ type: string; amount: number; balance_before: number; balance_after: number }>(
      'SELECT type, amount, balance_before, balance_after FROM credit_transactions WHERE org_id = ? ORDER BY id', org)
    expect(rows.map(r => [r.type, r.amount, r.balance_before, r.balance_after])).toEqual([
      ['purchase', 100, 0, 100], ['consumption', -1, 100, 99], ['refund', 1, 99, 100],
      ['admin_allocation', 5, 100, 105], ['admin_correction', -2, 105, 103],
    ])
  })

  it('never charges the same operation twice', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await applyCredit(t.db, { orgId: org, type: 'purchase', amount: 3, operationKey: 'payment:1' })
    const first = await applyCredit(t.db, { orgId: org, type: 'consumption', amount: -1, operationKey: 'document:x' })
    const again = await applyCredit(t.db, { orgId: org, type: 'consumption', amount: -1, operationKey: 'document:x' })
    expect(again.replayed).toBe(true)
    expect(again.transaction.id).toBe(first.transaction.id)
    expect((await getWallet(t.db, org)).balance).toBe(2)
  })

  it('refuses to go below zero and changes nothing', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await expect(applyCredit(t.db, { orgId: org, type: 'consumption', amount: -1, operationKey: 'document:y' })).rejects.toBeInstanceOf(InsufficientCredits)
    expect((await getWallet(t.db, org)).balance).toBe(0)
    expect(await t.db.get('SELECT 1 FROM credit_transactions WHERE org_id = ?', org)).toBeUndefined()
  })

  it('gives the last credit to exactly one of many simultaneous requests', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await applyCredit(t.db, { orgId: org, type: 'purchase', amount: 1, operationKey: 'payment:1' })
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7, 8].map(n =>
      applyCredit(t!.db, { orgId: org, type: 'consumption', amount: -1, operationKey: `document:${n}` })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await getWallet(t.db, org)).balance).toBe(0)
  })

  it('keeps the ledger append-only, even for direct SQL', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await applyCredit(t.db, { orgId: org, type: 'purchase', amount: 10, operationKey: 'payment:1' })
    await expect(t.db.run('UPDATE credit_transactions SET amount = 1000 WHERE org_id = ?', org)).rejects.toThrow(/append-only/)
    await expect(t.db.run('DELETE FROM credit_transactions WHERE org_id = ?', org)).rejects.toThrow(/append-only/)
    await expect(t.db.run('UPDATE credit_wallets SET balance = -5 WHERE org_id = ?', org)).rejects.toThrow()
  })

  it('validates the sign of each type', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await expect(applyCredit(t.db, { orgId: org, type: 'purchase', amount: -5, operationKey: 'k1' })).rejects.toThrow()
    await expect(applyCredit(t.db, { orgId: org, type: 'consumption', amount: 5, operationKey: 'k2' })).rejects.toThrow()
    await expect(applyCredit(t.db, { orgId: org, type: 'admin_correction', amount: 0, operationKey: 'k3' })).rejects.toThrow()
  })
})
