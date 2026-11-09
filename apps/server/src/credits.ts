/**
 * Prepaid credits: 1 credit = 1 document turned into a draft invoice (founder decision, 2026-11-09).
 * The ledger is append-only; a unique index guarantees one charge per document.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from './audit.js'
import { CAN, orgOf } from './auth/context.js'
import { now, type Db } from './db.js'

export function balance(db: Db, orgId: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE org_id = ?').get(orgId) as { total: number }
  return row.total
}

export function topup(db: Db, orgId: string, credits: number, ref: string, userId: string | null): void {
  if (!Number.isInteger(credits) || credits <= 0) throw new Error('credits: top-up must be a positive integer')
  db.prepare("INSERT INTO credit_ledger (org_id, kind, amount, ref, user_id, created_at) VALUES (?, 'topup', ?, ?, ?, ?)")
    .run(orgId, credits, ref, userId, now())
}

/** Charge one credit for this document. True if charged now or already charged; false if the balance is empty. */
export function consume(db: Db, orgId: string, documentId: string): boolean {
  return db.tx(() => {
    const already = db.prepare("SELECT 1 FROM credit_ledger WHERE org_id = ? AND document_id = ? AND kind = 'consume'").get(orgId, documentId)
    if (already) return true
    if (balance(db, orgId) < 1) return false
    db.prepare("INSERT INTO credit_ledger (org_id, kind, amount, ref, document_id, created_at) VALUES (?, 'consume', -1, 'document', ?, ?)")
      .run(orgId, documentId, now())
    return true
  })
}

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps

  app.get('/', async (request) => {
    const org = orgOf(request)
    const entries = db.prepare(`SELECT l.id, l.kind, l.amount, l.ref, l.document_id, d.filename, l.created_at FROM credit_ledger l
      LEFT JOIN documents d ON d.id = l.document_id AND d.org_id = l.org_id
      WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 200`).all(org.id)
    return { balance: balance(db, org.id), entries }
  })

  app.post('/topup', async (request) => {
    const org = orgOf(request, CAN.billing)
    const body = z.object({
      credits: z.number().int().min(1).max(100_000),
      ref: z.string().trim().min(3, 'Référence de paiement requise.').max(80),
    }).strict().parse(request.body)
    topup(db, org.id, body.credits, body.ref, request.user!.id)
    audit(db, { orgId: org.id, userId: request.user!.id }, 'credits.topup', 'credits', body.ref, { credits: body.credits })
    // Documents that were waiting for credits can run now.
    db.prepare("UPDATE documents SET status = 'queued' WHERE org_id = ? AND status = 'waiting_credits'").run(org.id)
    db.prepare(`UPDATE jobs SET status = 'pending', run_after = ? WHERE org_id = ? AND type = 'process_document' AND status = 'waiting_credits'`).run(now(), org.id)
    return { balance: balance(db, org.id) }
  })
}
