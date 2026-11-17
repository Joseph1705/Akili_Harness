/**
 * Prepaid document credits (DIRECTIVES §5): one invoice generated from one document = one credit.
 * Balances live in `credit_wallets`, history in the append-only `credit_transactions` (billing/wallet.ts).
 * Organizations cannot credit themselves: credits come from verified payments (SasPay), the sign-up
 * gift and platform operators (allocations, refunds, corrections), each one recorded.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from './audit.js'
import { CAN, orgOf } from './auth/context.js'
import type { Db } from './db.js'
import { applyCredit, balanceOf, getWallet, InsufficientCredits, type CreditType } from './billing/wallet.js'

export async function balance(db: Db, orgId: string): Promise<number> {
  return balanceOf(db, orgId)
}

/** Documents that were waiting for credits go back to the queue. */
export async function resumeWaitingDocuments(db: Db, orgId: string): Promise<void> {
  await db.run("UPDATE documents SET status = 'queued' WHERE org_id = ? AND status = 'waiting_credits'", orgId)
  await db.run("UPDATE jobs SET status = 'pending', run_after = now() WHERE org_id = ? AND type = 'process_document' AND status = 'waiting_credits'", orgId)
}

/** Credits given by the platform (sign-up gift, operator allocation). `operationKey` makes a retry harmless. */
export async function topup(db: Db, orgId: string, credits: number, ref: string, userId: string | null, operationKey = `allocation:${randomUUID()}`): Promise<void> {
  if (!Number.isInteger(credits) || credits <= 0) throw new Error('credits: top-up must be a positive integer')
  await applyCredit(db, {
    orgId, type: 'admin_allocation', amount: credits, operationKey, actorUserId: userId,
    paymentReference: ref === 'BIENVENUE' ? null : ref, reason: ref === 'BIENVENUE' ? 'Crédits de bienvenue' : `Allocation : ${ref}`,
  })
  await resumeWaitingDocuments(db, orgId)
}

/** Charge one credit for this document. True if charged now or already charged; false if the balance is empty. */
export async function consume(db: Db, orgId: string, documentId: string, invoiceId: string | null = null): Promise<boolean> {
  try {
    await applyCredit(db, { orgId, type: 'consumption', amount: -1, operationKey: `document:${documentId}`, documentId, invoiceId })
    return true
  } catch (error) {
    if (error instanceof InsufficientCredits) return false
    throw error
  }
}

export const TYPE_LABEL: Record<CreditType, string> = {
  purchase: 'Achat de crédits', consumption: 'Document traité', refund: 'Remboursement',
  admin_allocation: 'Allocation', admin_correction: 'Correction',
}

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { type, before } = z.object({
      type: z.enum(['purchase', 'consumption', 'refund', 'admin_allocation', 'admin_correction']).optional(),
      before: z.coerce.number().int().positive().optional(),
    }).parse(request.query)
    const wallet = await getWallet(db, org.id)
    const entries = await db.all(`SELECT t.public_id AS id, t.type, t.amount, t.balance_before, t.balance_after, t.payment_reference, t.reason,
      t.document_id, t.invoice_id, t.status, t.created_at, t.id AS seq, d.filename, i.number AS invoice_number
      FROM credit_transactions t
      LEFT JOIN documents d ON d.id = t.document_id AND d.org_id = t.org_id
      LEFT JOIN invoices i ON i.id = t.invoice_id AND i.org_id = t.org_id
      WHERE t.org_id = ? AND (?::text IS NULL OR t.type = ?::text) AND (?::bigint IS NULL OR t.id < ?::bigint)
      ORDER BY t.id DESC LIMIT 100`, org.id, type ?? null, type ?? null, before ?? null, before ?? null)
    return {
      balance: wallet.balance,
      wallet: { ...wallet, low: wallet.balance <= wallet.low_balance_threshold },
      entries,
    }
  })

  /** Documents processed per day (30 days), week (12 weeks) or month (12 months). */
  app.get('/usage', async (request) => {
    const org = orgOf(request)
    const { period } = z.object({ period: z.enum(['day', 'week', 'month']).default('day') }).parse(request.query)
    const span = { day: ['29 days', '1 day'], week: ['11 weeks', '1 week'], month: ['11 months', '1 month'] }[period]
    const rows = await db.all<{ bucket: string; consumed: number; added: number }>(`
      SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
        COALESCE(-SUM(t.amount) FILTER (WHERE t.type = 'consumption'), 0)::int AS consumed,
        COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0)::int AS added
      FROM generate_series(date_trunc(?, now()) - ?::interval, date_trunc(?, now()), ?::interval) AS b(bucket)
      LEFT JOIN credit_transactions t ON t.org_id = ? AND date_trunc(?, t.created_at) = b.bucket
      GROUP BY b.bucket ORDER BY b.bucket`, period, span[0], period, span[1], org.id, period)
    const wallet = await getWallet(db, org.id)
    const recent = rows.slice(-7).reduce((a, r) => a + r.consumed, 0)
    return { period, buckets: rows, balance: wallet.balance, averagePerBucket: rows.length ? recent / Math.min(7, rows.length) : 0 }
  })

  app.patch('/settings', async (request) => {
    const org = orgOf(request, CAN.billing)
    const body = z.object({ low_balance_threshold: z.number().int().min(0).max(100_000) }).strict().parse(request.body)
    await db.run('INSERT INTO credit_wallets (org_id) VALUES (?) ON CONFLICT (org_id) DO NOTHING', org.id)
    await db.run('UPDATE credit_wallets SET low_balance_threshold = ?, updated_at = now() WHERE org_id = ?', body.low_balance_threshold, org.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'credits.settings_updated', 'wallet', org.id, body)
    return { wallet: await getWallet(db, org.id) }
  })
}
