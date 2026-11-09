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

interface Correction { code: string; before: string; after: string; note: string | null; by: string; at: string }
interface InvoiceRow {
  id: string; org_id: string; document_id: string; agent_id: string; client_id: string; contract_id: string; number: string
  status: 'draft' | 'validated' | 'rejected'; currency: string; lines: InvoiceLine[]; subtotal_cents: number; vat_rate_bp: number
  vat_cents: number; total_cents: number; issue_date: string; due_date: string; po_number: string; period: string | null
  checks: Check[]; decided_by: string | null; decided_at: string | null; reject_reason: string | null; corrections: Correction[]; created_at: string
}

async function load(db: Db, orgId: string, id: string): Promise<InvoiceRow> {
  const row = await db.get<InvoiceRow>('SELECT * FROM invoices WHERE id = ? AND org_id = ?', id, orgId)
  if (!row) throw notFound('Facture')
  return row
}

async function present(db: Db, row: InvoiceRow) {
  const client = await clientById(db, row.org_id, row.client_id)
  const contract = await contractById(db, row.org_id, row.contract_id)
  const document = await db.get('SELECT id, filename, report_number FROM documents WHERE id = ? AND org_id = ?', row.document_id, row.org_id)
  const agent = await db.get('SELECT id, name FROM agents WHERE id = ? AND org_id = ?', row.agent_id, row.org_id)
  const decidedBy = row.decided_by ? await db.get('SELECT email, first_name, last_name FROM users WHERE id = ?', row.decided_by) : null
  return {
    ...row,
    client, contract: contract && { id: contract.id, reference: contract.reference, payment_terms_days: contract.payment_terms_days },
    document, agent, decided_by_user: decidedBy,
  }
}

/** Replays return the first answer: a validation retried after a network cut never runs twice (directive 4.11). */
async function idempotent(db: Db, org: OrgContext, request: FastifyRequest, run: () => Promise<unknown>): Promise<unknown> {
  const key = z.string().uuid('En-tête Idempotency-Key requis.').parse(request.headers['idempotency-key'])
  const userId = request.user!.id
  const stored = await db.get<{ body: unknown }>('SELECT body FROM idempotency WHERE org_id = ? AND user_id = ? AND key = ?', org.id, userId, key)
  if (stored) return stored.body
  const body = await run()
  await db.run('INSERT INTO idempotency (org_id, user_id, key, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', org.id, userId, key, JSON.stringify(body))
  return body
}

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const Id = z.object({ id: z.string().uuid() })
  const notDraft = () => new HttpError(409, 'not_draft', 'Cette facture a déjà été traitée.')

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.enum(['draft', 'validated', 'rejected']).optional() }).parse(request.query)
    const rows = await db.all<{ checks: Check[] }>(`SELECT i.id, i.number, i.status, i.total_cents, i.currency, i.created_at, i.decided_at, i.checks, i.po_number,
      c.name AS client_name, a.name AS agent_name, d.filename, d.report_number
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id JOIN agents a ON a.id = i.agent_id AND a.org_id = i.org_id
      JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE i.org_id = ? AND (?::text IS NULL OR i.status = ?::text) ORDER BY i.created_at ASC LIMIT 200`, org.id, status ?? null, status ?? null)
    return { invoices: rows.map(r => ({ ...r, checks: undefined, attention: r.checks.filter(c => c.status === 'warning' || c.status === 'error').length })) }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    return { invoice: await present(db, await load(db, org.id, Id.parse(request.params).id)) }
  })

  app.post('/:id/validate', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    return idempotent(db, org, request, async () => {
      await db.tx(async tx => {
        const row = await tx.get<InvoiceRow>('SELECT * FROM invoices WHERE id = ? AND org_id = ? FOR UPDATE', id, org.id)
        if (!row) throw notFound('Facture')
        if (row.status !== 'draft') throw notDraft()
        const blocking = row.checks.filter(c => c.status === 'error')
        if (blocking.length) throw new HttpError(409, 'blocking_checks', `À corriger avant validation : ${blocking.map(c => c.title).join(', ')}.`)
        const number = await nextNumber(tx, org.id, Number(row.issue_date.slice(0, 4)), 'FAC')
        await tx.run("UPDATE invoices SET status = 'validated', number = ?, decided_by = ?, decided_at = now() WHERE id = ? AND org_id = ?",
          number, request.user!.id, id, org.id)
        await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.validated', 'invoice', id, { number, draft: row.number })
      })
      return { invoice: await present(db, await load(db, org.id, id)) }
    })
  })

  app.post('/:id/reject', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indiquez la raison du rejet.').max(500) }).strict().parse(request.body)
    await load(db, org.id, id)
    const changed = await db.run("UPDATE invoices SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = now() WHERE id = ? AND org_id = ? AND status = 'draft'",
      reason, request.user!.id, id, org.id)
    if (changed === 0) throw notDraft()
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.rejected', 'invoice', id)
    return { invoice: await present(db, await load(db, org.id, id)) }
  })

  app.post('/:id/correct', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const body = z.object({
      lines: z.array(z.object({ code: z.string().max(20), qty: z.string().trim().regex(/^\d{1,9}([.,]\d{1,3})?$/, 'Quantité invalide.') })).min(1).max(200),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body)
    await db.tx(async tx => {
      const row = await tx.get<InvoiceRow>('SELECT * FROM invoices WHERE id = ? AND org_id = ? FOR UPDATE', id, org.id)
      if (!row) throw notFound('Facture')
      if (row.status !== 'draft') throw notDraft()
      const doc = (await tx.get<{ extracted: ActivityReport }>('SELECT extracted FROM documents WHERE id = ? AND org_id = ?', row.document_id, org.id))!
      const overrides: Record<string, string> = Object.fromEntries(row.lines.map(l => [l.code, l.qty]))
      const corrections = [...row.corrections]
      for (const change of body.lines) {
        const line = row.lines.find(l => l.code === change.code)
        if (!line) throw notFound(`Ligne ${change.code}`)
        const qty = change.qty.replace(',', '.')
        if (qty === line.qty) continue
        corrections.push({ code: change.code, before: line.qty, after: qty, note: body.note ?? null, by: request.user!.id, at: now() })
        overrides[change.code] = qty
      }
      const contract = (await contractById(tx, org.id, row.contract_id))!
      const client = (await clientById(tx, org.id, row.client_id))!
      const profile = (await tx.get<OrgTaxProfile>('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?', org.id))!
      const draft = buildDraft(doc.extracted, contract, client, profile, overrides)
      await tx.run(`UPDATE invoices SET lines = ?, subtotal_cents = ?, vat_rate_bp = ?, vat_cents = ?, total_cents = ?, checks = ?, corrections = ? WHERE id = ? AND org_id = ?`,
        JSON.stringify(draft.lines), draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, JSON.stringify(draft.checks), JSON.stringify(corrections), id, org.id)
      // Corrections are kept as learning material (directive 6.4); nothing is applied automatically.
      await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.corrected', 'invoice', id, { lines: body.lines.map(l => l.code) })
    })
    return { invoice: await present(db, await load(db, org.id, id)) }
  })

  app.get('/:id/pdf', async (request, reply) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const row = await load(db, org.id, id)
    const provider = (await db.get<{ name: string; address: string | null; rccm: string | null; nif: string | null; id_nat: string | null; bank_details: string | null; logo_blob_id: string | null }>(
      'SELECT name, address, rccm, nif, id_nat, bank_details, logo_blob_id FROM organizations WHERE id = ?', org.id))!
    const client = (await clientById(db, org.id, row.client_id))!
    const logo = provider.logo_blob_id ? (await getBlob(db, config, org.id, provider.logo_blob_id)).bytes : null
    const pdf = await renderInvoicePdf({
      status: row.status, number: row.number, issueDate: row.issue_date, dueDate: row.due_date, poNumber: row.po_number, period: row.period,
      currency: row.currency, lines: row.lines, subtotalCents: row.subtotal_cents, vatRateBp: row.vat_rate_bp,
      vatCents: row.vat_cents, totalCents: row.total_cents, checks: row.checks, logoPng: logo,
      provider: { name: provider.name, address: provider.address, rccm: provider.rccm, nif: provider.nif, idNat: provider.id_nat, bank: provider.bank_details },
      client: { name: client.name, address: client.address, nif: client.nif },
    })
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.pdf_downloaded', 'invoice', id)
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${row.number}.pdf"`)
      .header('cache-control', 'private, no-store')
      .send(pdf)
  })
}
