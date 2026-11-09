/** Draft invoices: read, correct, validate, reject (rule 7: nothing leaves without a human), PDF. */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf, type OrgContext } from '../auth/context.js'
import { now, type Db } from '../db.js'
import { HttpError, notFound } from '../errors.js'
import type { ActivityReport } from '../documents/parse-report.js'
import { getBlob } from '../storage/blobs.js'
import { clientById, contractById } from './clients.js'
import { buildDraft, type Check, type InvoiceLine, type OrgTaxProfile } from './draft.js'
import { nextNumber } from './numbering.js'
import { renderInvoicePdf } from './pdf.js'

interface InvoiceRow {
  id: string; org_id: string; document_id: string; agent_id: string; client_id: string; contract_id: string; number: string
  status: 'draft' | 'validated' | 'rejected'; currency: string; lines: string; subtotal_cents: number; vat_rate_bp: number
  vat_cents: number; total_cents: number; issue_date: string; due_date: string; po_number: string; period: string | null
  checks: string; decided_by: string | null; decided_at: string | null; reject_reason: string | null; corrections: string | null; created_at: string
}

function load(db: Db, orgId: string, id: string): InvoiceRow {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ? AND org_id = ?').get(id, orgId) as InvoiceRow | undefined
  if (!row) throw notFound('Facture')
  return row
}

function present(db: Db, row: InvoiceRow) {
  const client = clientById(db, row.org_id, row.client_id)
  const contract = contractById(db, row.org_id, row.contract_id)
  const doc = db.prepare('SELECT id, filename, report_number FROM documents WHERE id = ? AND org_id = ?').get(row.document_id, row.org_id)
  const agent = db.prepare('SELECT id, name FROM agents WHERE id = ? AND org_id = ?').get(row.agent_id, row.org_id)
  const decidedBy = row.decided_by ? db.prepare('SELECT email, first_name, last_name FROM users WHERE id = ?').get(row.decided_by) : null
  return {
    ...row,
    lines: JSON.parse(row.lines) as InvoiceLine[],
    checks: JSON.parse(row.checks) as Check[],
    corrections: row.corrections ? JSON.parse(row.corrections) : [],
    client, contract: contract && { id: contract.id, reference: contract.reference, payment_terms_days: contract.payment_terms_days },
    document: doc, agent, decided_by_user: decidedBy,
  }
}

function idempotent(db: Db, org: OrgContext, request: FastifyRequest, run: () => unknown): unknown {
  const key = z.string().uuid('En-tête Idempotency-Key requis.').parse(request.headers['idempotency-key'])
  const userId = request.user!.id
  const stored = db.prepare('SELECT body FROM idempotency WHERE org_id = ? AND user_id = ? AND key = ?').get(org.id, userId, key) as { body: string } | undefined
  if (stored) return JSON.parse(stored.body)
  const body = run()
  db.prepare('INSERT INTO idempotency (key, org_id, user_id, status, body, created_at) VALUES (?, ?, ?, 200, ?, ?)').run(key, org.id, userId, JSON.stringify(body), now())
  return body
}

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const Id = z.object({ id: z.string().uuid() })
  const notDraft = () => new HttpError(409, 'not_draft', 'Cette facture a déjà été traitée.')

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.enum(['draft', 'validated', 'rejected']).optional() }).parse(request.query)
    const rows = db.prepare(`SELECT i.id, i.number, i.status, i.total_cents, i.currency, i.created_at, i.decided_at, i.checks, i.po_number,
      c.name AS client_name, a.name AS agent_name, d.filename, d.report_number
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id JOIN agents a ON a.id = i.agent_id AND a.org_id = i.org_id
      JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE i.org_id = ? AND (? IS NULL OR i.status = ?) ORDER BY i.created_at ASC LIMIT 200`).all(org.id, status ?? null, status ?? null) as Array<{ checks: string }>
    return {
      invoices: rows.map(r => {
        const checks = JSON.parse(r.checks) as Check[]
        return { ...r, checks: undefined, attention: checks.filter(c => c.status === 'warning' || c.status === 'error').length }
      }),
    }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    return { invoice: present(db, load(db, org.id, Id.parse(request.params).id)) }
  })

  app.post('/:id/validate', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    return idempotent(db, org, request, () => {
      const row = load(db, org.id, id)
      if (row.status !== 'draft') throw notDraft()
      const blocking = (JSON.parse(row.checks) as Check[]).filter(c => c.status === 'error')
      if (blocking.length) throw new HttpError(409, 'blocking_checks', `À corriger avant validation : ${blocking.map(c => c.title).join(', ')}.`)
      const number = nextNumber(db, org.id, Number(row.issue_date.slice(0, 4)), 'FAC')
      db.prepare("UPDATE invoices SET status = 'validated', number = ?, decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ?")
        .run(number, request.user!.id, now(), id, org.id)
      audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.validated', 'invoice', id, { number, draft: row.number })
      return { invoice: present(db, load(db, org.id, id)) }
    })
  })

  app.post('/:id/reject', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indiquez la raison du rejet.').max(500) }).strict().parse(request.body)
    const row = load(db, org.id, id)
    if (row.status !== 'draft') throw notDraft()
    db.prepare("UPDATE invoices SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ?")
      .run(reason, request.user!.id, now(), id, org.id)
    audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.rejected', 'invoice', id)
    return { invoice: present(db, load(db, org.id, id)) }
  })

  app.post('/:id/correct', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const body = z.object({
      lines: z.array(z.object({ code: z.string().max(20), qty: z.string().trim().regex(/^\d{1,9}([.,]\d{1,3})?$/, 'Quantité invalide.') })).min(1).max(200),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body)
    const row = load(db, org.id, id)
    if (row.status !== 'draft') throw notDraft()
    const docRow = db.prepare('SELECT extracted FROM documents WHERE id = ? AND org_id = ?').get(row.document_id, org.id) as { extracted: string }
    const report = JSON.parse(docRow.extracted) as ActivityReport
    const current = JSON.parse(row.lines) as InvoiceLine[]
    const overrides: Record<string, string> = Object.fromEntries(current.map(l => [l.code, l.qty]))
    const corrections = row.corrections ? JSON.parse(row.corrections) as unknown[] : []
    for (const change of body.lines) {
      const line = current.find(l => l.code === change.code)
      if (!line) throw notFound(`Ligne ${change.code}`)
      const qty = change.qty.replace(',', '.')
      if (qty === line.qty) continue
      corrections.push({ code: change.code, before: line.qty, after: qty, note: body.note ?? null, by: request.user!.id, at: now() })
      overrides[change.code] = qty
    }
    const contract = contractById(db, org.id, row.contract_id)!
    const client = clientById(db, org.id, row.client_id)!
    const profile = db.prepare('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?').get(org.id) as unknown as OrgTaxProfile
    const draft = buildDraft(report, contract, client, profile, overrides)
    db.prepare(`UPDATE invoices SET lines = ?, subtotal_cents = ?, vat_rate_bp = ?, vat_cents = ?, total_cents = ?, checks = ?, corrections = ? WHERE id = ? AND org_id = ?`)
      .run(JSON.stringify(draft.lines), draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, JSON.stringify(draft.checks), JSON.stringify(corrections), id, org.id)
    // Corrections are kept as learning material (directive 6.4); nothing is applied automatically.
    audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.corrected', 'invoice', id, { lines: body.lines.map(l => l.code) })
    return { invoice: present(db, load(db, org.id, id)) }
  })

  app.get('/:id/pdf', async (request, reply) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const row = load(db, org.id, id)
    const provider = db.prepare('SELECT name, address, rccm, nif, id_nat, bank_details, logo_blob_id FROM organizations WHERE id = ?').get(org.id) as
      { name: string; address: string | null; rccm: string | null; nif: string | null; id_nat: string | null; bank_details: string | null; logo_blob_id: string | null }
    const client = clientById(db, org.id, row.client_id)!
    const logo = provider.logo_blob_id ? getBlob(db, config, org.id, provider.logo_blob_id).bytes : null
    const pdf = await renderInvoicePdf({
      status: row.status, number: row.number, issueDate: row.issue_date, dueDate: row.due_date, poNumber: row.po_number, period: row.period,
      currency: row.currency, lines: JSON.parse(row.lines), subtotalCents: row.subtotal_cents, vatRateBp: row.vat_rate_bp,
      vatCents: row.vat_cents, totalCents: row.total_cents, checks: JSON.parse(row.checks), logoPng: logo,
      provider: { name: provider.name, address: provider.address, rccm: provider.rccm, nif: provider.nif, idNat: provider.id_nat, bank: provider.bank_details },
      client: { name: client.name, address: client.address, nif: client.nif },
    })
    audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.pdf_downloaded', 'invoice', id)
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${row.number}.pdf"`)
      .header('cache-control', 'private, no-store')
      .send(pdf)
  })
}
