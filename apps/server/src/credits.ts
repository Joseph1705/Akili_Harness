/**
 * Prepaid credits: 1 credit = 1 document turned into a draft invoice (founder decision, 2026-11-09).
 * The ledger is append-only. Organizations cannot credit themselves: credits come from the sign-up
 * gift and from the platform operators (until payment is integrated).
 */
import type { FastifyInstance } from 'fastify'
import { orgOf } from './auth/context.js'
import type { Db } from './db.js'

export async function balance(db: Db, orgId: string): Promise<number> {
  const row = await db.get<{ total: number }>('SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM credit_ledger WHERE org_id = ?', orgId)
  return row!.total
}

export async function topup(db: Db, orgId: string, credits: number, ref: string, userId: string | null): Promise<void> {
  if (!Number.isInteger(credits) || credits <= 0) throw new Error('credits: top-up must be a positive integer')
  await db.run("INSERT INTO credit_ledger (org_id, kind, amount, ref, user_id) VALUES (?, 'topup', ?, ?, ?)", orgId, credits, ref, userId)
  // Documents that were waiting for credits can run now.
  await db.run("UPDATE documents SET status = 'queued' WHERE org_id = ? AND status = 'waiting_credits'", orgId)
  await db.run("UPDATE jobs SET status = 'pending', run_after = now() WHERE org_id = ? AND type = 'process_document' AND status = 'waiting_credits'", orgId)
}

/** Charge one credit for this document. True if charged now or already charged; false if the balance is empty. */
export async function consume(db: Db, orgId: string, documentId: string): Promise<boolean> {
  return db.tx(async tx => {
    // One charge at a time per organization: two documents racing for the last credit cannot both win.
    await tx.run('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', `credits:${orgId}`)
    const already = await tx.get("SELECT 1 FROM credit_ledger WHERE org_id = ? AND document_id = ? AND kind = 'consume'", orgId, documentId)
    if (already) return true
    if (await balance(tx, orgId) < 1) return false
    await tx.run("INSERT INTO credit_ledger (org_id, kind, amount, ref, document_id) VALUES (?, 'consume', -1, 'document', ?)", orgId, documentId)
    return true
  })
}

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps
  app.get('/', async (request) => {
    const org = orgOf(request)
    const entries = await db.all(`SELECT l.id, l.kind, l.amount, l.ref, l.document_id, d.filename, l.created_at FROM credit_ledger l
      LEFT JOIN documents d ON d.id = l.document_id AND d.org_id = l.org_id
      WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 200`, org.id)
    return { balance: await balance(db, org.id), entries }
  })
}
