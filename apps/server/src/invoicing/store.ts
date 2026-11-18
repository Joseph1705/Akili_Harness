/** Invoice rows: loading, presenting, creating, rendering to PDF. Shared by every way an invoice is born. */
import type { FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { notFound } from '../errors.js'
import { getBlob } from '../storage/blobs.js'
import type { BuiltInvoice } from './build.js'
import { clientById, contractById } from './clients.js'
import type { Check, InvoiceLine } from './draft.js'
import { nextNumber } from './numbering.js'
import { renderInvoicePdf } from './pdf.js'

export interface Correction { code: string; before: string; after: string; note: string | null; by: string; at: string }

export interface InvoiceRow {
  id: string; org_id: string; document_id: string | null; agent_id: string | null; client_id: string; contract_id: string | null; number: string
  status: 'draft' | 'validated' | 'rejected'; source: 'report' | 'document' | 'manual'; currency: string; lines: InvoiceLine[]
  subtotal_cents: number; discount_cents: number; vat_rate_bp: number; vat_cents: number; total_cents: number
  issue_date: string; due_date: string; po_number: string | null; reference: string | null; period: string | null; notes: string | null
  checks: Check[]; decided_by: string | null; decided_at: string | null; reject_reason: string | null; corrections: Correction[]
  payment_status: 'unpaid' | 'partial' | 'paid'; amount_paid_cents: number; paid_at: string | null
  created_by: string | null; created_at: string
}

export async function loadInvoice(db: Db, orgId: string, id: string, lock = false): Promise<InvoiceRow> {
  const row = await db.get<InvoiceRow>(`SELECT * FROM invoices WHERE id = ? AND org_id = ?${lock ? ' FOR UPDATE' : ''}`, id, orgId)
  if (!row) throw notFound('Facture')
  return row
}

export async function presentInvoice(db: Db, row: InvoiceRow) {
  const client = await clientById(db, row.org_id, row.client_id)
  const contract = row.contract_id ? await contractById(db, row.org_id, row.contract_id) : undefined
  const document = row.document_id ? await db.get('SELECT id, filename, report_number, kind FROM documents WHERE id = ? AND org_id = ?', row.document_id, row.org_id) : null
  const agent = row.agent_id ? await db.get('SELECT id, name FROM agents WHERE id = ? AND org_id = ?', row.agent_id, row.org_id) : null
  const decidedBy = row.decided_by ? await db.get('SELECT email, first_name, last_name FROM users WHERE id = ?', row.decided_by) : null
  const today = new Date().toISOString().slice(0, 10)
  return {
    ...row,
    client, contract: contract ? { id: contract.id, reference: contract.reference, payment_terms_days: contract.payment_terms_days } : null,
    document: document ?? null, agent: agent ?? null, decided_by_user: decidedBy ?? null,
    balance_due_cents: Math.max(0, row.total_cents - row.amount_paid_cents),
    overdue: row.status === 'validated' && row.payment_status !== 'paid' && row.due_date < today,
  }
}

/** Replays return the first answer: an action retried after a network cut never runs twice (directive 4.11). */
export async function idempotent<T>(db: Db, orgId: string, request: FastifyRequest, run: () => Promise<T>): Promise<T> {
  const key = z.string().uuid('En-tête Idempotency-Key requis.').parse(request.headers['idempotency-key'])
  const userId = request.user!.id
  const stored = await db.get<{ body: T }>('SELECT body FROM idempotency WHERE org_id = ? AND user_id = ? AND key = ?', orgId, userId, key)
  if (stored) return stored.body
  const body = await run()
  await db.run('INSERT INTO idempotency (org_id, user_id, key, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', orgId, userId, key, JSON.stringify(body))
  return body
}

export interface NewInvoice {
  orgId: string
  source: 'document' | 'manual'
  clientId: string
  built: BuiltInvoice
  currency: string
  issueDate: string
  dueDate: string
  reference?: string | null
  poNumber?: string | null
  period?: string | null
  notes?: string | null
  documentId?: string | null
  agentId?: string | null
  createdBy: string
}

/** A draft invoice (P-YYYY-NNNN). Its official number (FAC-…) is given at validation, without gaps. */
export async function insertDraft(tx: Db, n: NewInvoice): Promise<{ id: string; number: string }> {
  const id = randomUUID()
  const number = await nextNumber(tx, n.orgId, Number(n.issueDate.slice(0, 4)), 'P')
  await tx.run(`INSERT INTO invoices (id, org_id, document_id, agent_id, client_id, contract_id, number, status, source, currency, lines,
    subtotal_cents, discount_cents, vat_rate_bp, vat_cents, total_cents, issue_date, due_date, po_number, reference, period, notes, checks, created_by)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, n.orgId, n.documentId ?? null, n.agentId ?? null, n.clientId, number, n.source, n.currency, JSON.stringify(n.built.lines),
  n.built.subtotalCents, n.built.discountCents, n.built.vatRateBp, n.built.vatCents, n.built.totalCents, n.issueDate, n.dueDate,
  n.poNumber || null, n.reference || null, n.period || null, n.notes || null, JSON.stringify(n.built.checks), n.createdBy)
  return { id, number }
}

export async function invoicePdf(db: Db, config: Config, row: InvoiceRow): Promise<Buffer> {
  const provider = (await db.get<{ name: string; address: string | null; rccm: string | null; nif: string | null; id_nat: string | null; bank_details: string | null; logo_blob_id: string | null }>(
    'SELECT name, address, rccm, nif, id_nat, bank_details, logo_blob_id FROM organizations WHERE id = ?', row.org_id))!
  const client = (await clientById(db, row.org_id, row.client_id))!
  const logo = provider.logo_blob_id ? (await getBlob(db, config, row.org_id, provider.logo_blob_id)).bytes : null
  return renderInvoicePdf({
    status: row.status, number: row.number, issueDate: row.issue_date, dueDate: row.due_date, poNumber: row.po_number, reference: row.reference,
    period: row.period, currency: row.currency, lines: row.lines, subtotalCents: row.subtotal_cents, discountCents: row.discount_cents,
    vatRateBp: row.vat_rate_bp, vatCents: row.vat_cents, totalCents: row.total_cents, checks: row.checks, logoPng: logo, notes: row.notes,
    paymentStatus: row.payment_status, amountPaidCents: row.amount_paid_cents,
    provider: { name: provider.name, address: provider.address, rccm: provider.rccm, nif: provider.nif, idNat: provider.id_nat, bank: provider.bank_details },
    client: { name: client.name, address: client.address, nif: client.nif },
  })
}
