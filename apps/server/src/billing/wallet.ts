/**
 * Credit wallet: one row per organization, and a permanent, append-only ledger (credit_transactions).
 *
 * Every change of balance goes through `applyCredit`, inside one database transaction:
 *   1. lock the organization's wallet row (FOR UPDATE): concurrent operations queue up, so two requests
 *      can never spend the same credit;
 *   2. an operation key already recorded returns the first result (idempotency: a retried request,
 *      a replayed webhook or a reprocessed document is never charged or credited twice);
 *   3. the new balance may never be negative (checked here and by database constraints);
 *   4. the wallet and the ledger row are written together; any later failure in the caller's
 *      transaction rolls both back.
 * Mistakes are never deleted: they are fixed with a compensating transaction (refund or correction).
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import { HttpError } from '../errors.js'

export type CreditType = 'purchase' | 'consumption' | 'refund' | 'admin_allocation' | 'admin_correction'

export interface CreditInput {
  orgId: string
  type: CreditType
  /** Signed number of credits: positive adds, negative removes. */
  amount: number
  /** Unique per organization and per operation, e.g. `document:<id>`, `payment:<id>`. */
  operationKey: string
  documentId?: string | null
  invoiceId?: string | null
  paymentId?: string | null
  paymentReference?: string | null
  actorUserId?: string | null
  reason?: string | null
}

export interface CreditTransaction {
  id: number
  public_id: string
  org_id: string
  type: CreditType
  amount: number
  balance_before: number
  balance_after: number
  operation_key: string
  document_id: string | null
  invoice_id: string | null
  payment_id: string | null
  payment_reference: string | null
  actor_user_id: string | null
  reason: string | null
  status: 'completed'
  created_at: string
}

export interface Wallet {
  org_id: string
  balance: number
  total_purchased: number
  total_consumed: number
  total_refunded: number
  total_allocated: number
  total_corrected: number
  low_balance_threshold: number
  updated_at: string
}

export class InsufficientCredits extends HttpError {
  constructor(readonly balance: number, needed: number) {
    super(402, 'insufficient_credits',
      `Crédits insuffisants : il vous reste ${balance} crédit${balance > 1 ? 's' : ''}, il en faut ${needed}. Rechargez votre compte pour continuer.`,
      { balance, needed })
  }
}

const TOTAL_COLUMN: Record<CreditType, keyof Wallet> = {
  purchase: 'total_purchased', consumption: 'total_consumed', refund: 'total_refunded',
  admin_allocation: 'total_allocated', admin_correction: 'total_corrected',
}

function checkSign(type: CreditType, amount: number): void {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new Error(`credits: invalid amount ${amount}`)
  if ((type === 'purchase' || type === 'refund' || type === 'admin_allocation') && amount < 0) throw new Error(`credits: ${type} must add credits`)
  if (type === 'consumption' && amount > 0) throw new Error('credits: a consumption must remove credits')
}

export async function getWallet(db: Db, orgId: string): Promise<Wallet> {
  const row = await db.get<Wallet>('SELECT * FROM credit_wallets WHERE org_id = ?', orgId)
  return row ?? {
    org_id: orgId, balance: 0, total_purchased: 0, total_consumed: 0, total_refunded: 0, total_allocated: 0,
    total_corrected: 0, low_balance_threshold: 10, updated_at: new Date().toISOString(),
  }
}

export async function balanceOf(db: Db, orgId: string): Promise<number> {
  return (await getWallet(db, orgId)).balance
}

export async function applyCredit(db: Db, input: CreditInput): Promise<{ transaction: CreditTransaction; replayed: boolean }> {
  checkSign(input.type, input.amount)
  if (!input.operationKey || input.operationKey.length > 200) throw new Error('credits: operation key required')
  return db.tx(async tx => {
    await tx.run('INSERT INTO credit_wallets (org_id) VALUES (?) ON CONFLICT (org_id) DO NOTHING', input.orgId)
    const wallet = (await tx.get<Wallet>('SELECT * FROM credit_wallets WHERE org_id = ? FOR UPDATE', input.orgId))!
    const existing = await tx.get<CreditTransaction>('SELECT * FROM credit_transactions WHERE org_id = ? AND operation_key = ?', input.orgId, input.operationKey)
    if (existing) {
      if (existing.type !== input.type || existing.amount !== input.amount) {
        throw new HttpError(409, 'operation_conflict', 'Cette opération a déjà été enregistrée avec d\'autres valeurs.')
      }
      return { transaction: existing, replayed: true }
    }
    const after = wallet.balance + input.amount
    if (after < 0) throw new InsufficientCredits(wallet.balance, -input.amount)
    const total = TOTAL_COLUMN[input.type]
    // Consumptions are counted as a positive number of credits used.
    const totalDelta = input.type === 'consumption' ? -input.amount : input.amount
    await tx.run(`UPDATE credit_wallets SET balance = ?, ${total} = ${total} + ?, updated_at = now() WHERE org_id = ?`, after, totalDelta, input.orgId)
    const transaction = (await tx.get<CreditTransaction>(`INSERT INTO credit_transactions (public_id, org_id, type, amount, balance_before, balance_after,
      operation_key, document_id, invoice_id, payment_id, payment_reference, actor_user_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    randomUUID(), input.orgId, input.type, input.amount, wallet.balance, after, input.operationKey,
    input.documentId ?? null, input.invoiceId ?? null, input.paymentId ?? null, input.paymentReference ?? null,
    input.actorUserId ?? null, input.reason ?? null))!
    return { transaction, replayed: false }
  })
}
