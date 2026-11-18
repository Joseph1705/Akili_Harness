/**
 * Invoices: history with search and filters, manual creation, review of drafts, validation and rejection
 * (rule 7: nothing leaves without a human), customer payments, PDF, share links and sending by e-mail.
 * Manual invoices cost no credit: the one-credit rule is for invoices generated from a document (DIRECTIVES §6).
 */
import type { FastifyInstance } from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { RateLimiter } from '../auth/rate-limit.js'
import { now, type Db } from '../db.js'
import { badRequest, HttpError, notFound } from '../errors.js'
import type { ActivityReport } from '../documents/parse-report.js'
import type { ExtractedInvoice } from '../documents/invoice-fields.js'
import { hmac } from '../security/crypto.js'
import { buildInvoice, InvoiceInput } from './build.js'
import { clientById, contractById, createClient, type Client } from './clients.js'
import { formatMoney, parseMoney } from './compute.js'
import { buildDraft, type OrgTaxProfile } from './draft.js'
import { nextNumber } from './numbering.js'
import { idempotent, insertDraft, invoicePdf, loadInvoice, presentInvoice, type InvoiceRow } from './store.js'

const Id = z.object({ id: z.string().uuid() })
const notDraft = () => new HttpError(409, 'not_draft', 'Cette facture a déjà été traitée.')
const PAYMENT_METHODS = ['virement', 'mobile_money', 'especes', 'cheque', 'carte', 'autre'] as const

/** An existing client of this organization, or a new one created now (inside the caller's transaction). */
export async function resolveClient(tx: Db, orgId: string, client: InvoiceInput['client']): Promise<Client> {
  if ('id' in client) {
    const found = await clientById(tx, orgId, client.id)
    if (!found) throw notFound('Client')
    return found
  }
  if (!client.name || client.name.trim().length < 2) throw badRequest('Indiquez le nom du client.')
  return (await clientById(tx, orgId, await createClient(tx, orgId, client)))!
}

export async function taxProfile(db: Db, orgId: string): Promise<OrgTaxProfile> {
  return (await db.get<OrgTaxProfile>('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?', orgId))!
}

function paymentState(total: number, paid: number): { status: 'unpaid' | 'partial' | 'paid' } {
  return { status: paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial' }
}

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer } = app.deps

  app.get('/', async (request) => {
    const org = orgOf(request)
    const q = z.object({
      status: z.enum(['draft', 'validated', 'rejected']).optional(),
      payment: z.enum(['unpaid', 'partial', 'paid']).optional(),
      source: z.enum(['report', 'document', 'manual']).optional(),
      client: z.string().uuid().optional(),
      q: z.string().trim().max(80).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      overdue: z.enum(['1']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(200),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }).parse(request.query)
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null
    const where = `i.org_id = ?
      AND (?::text IS NULL OR i.status = ?::text) AND (?::text IS NULL OR i.payment_status = ?::text) AND (?::text IS NULL OR i.source = ?::text)
      AND (?::uuid IS NULL OR i.client_id = ?::uuid) AND (?::date IS NULL OR i.issue_date >= ?::date) AND (?::date IS NULL OR i.issue_date <= ?::date)
      AND (?::text IS NULL OR i.number ILIKE ?::text OR i.reference ILIKE ?::text OR i.po_number ILIKE ?::text OR c.name ILIKE ?::text)
      AND (?::text IS NULL OR (i.status = 'validated' AND i.payment_status <> 'paid' AND i.due_date < current_date))`
    const params = [org.id, q.status ?? null, q.status ?? null, q.payment ?? null, q.payment ?? null, q.source ?? null, q.source ?? null,
      q.client ?? null, q.client ?? null, q.from ?? null, q.from ?? null, q.to ?? null, q.to ?? null,
      like, like, like, like, like, q.overdue ?? null]
    const rows = await db.all<{ checks: Array<{ status: string }> }>(`SELECT i.id, i.number, i.status, i.source, i.total_cents, i.currency, i.created_at,
      i.decided_at, i.issue_date, i.due_date, i.checks, i.po_number, i.reference, i.payment_status, i.amount_paid_cents,
      c.name AS client_name, a.name AS agent_name, d.filename, d.report_number
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id
      LEFT JOIN agents a ON a.id = i.agent_id AND a.org_id = i.org_id
      LEFT JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE ${where} ORDER BY i.created_at ${q.status === 'draft' ? 'ASC' : 'DESC'}, i.id LIMIT ? OFFSET ?`, ...params, q.limit, q.offset)
    const summary = await db.all(`SELECT i.currency, count(*)::int AS count, COALESCE(SUM(i.total_cents), 0)::bigint AS total_cents,
      COALESCE(SUM(i.total_cents - i.amount_paid_cents) FILTER (WHERE i.status = 'validated'), 0)::bigint AS due_cents
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id WHERE ${where} GROUP BY i.currency`, ...params)
    const today = new Date().toISOString().slice(0, 10)
    return {
      invoices: rows.map(r => ({
        ...r, checks: undefined,
        attention: r.checks.filter(c => c.status === 'warning' || c.status === 'error').length,
        overdue: (r as unknown as { status: string }).status === 'validated' && (r as unknown as { payment_status: string }).payment_status !== 'paid' && String((r as unknown as { due_date: string }).due_date) < today,
      })),
      summary,
    }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, Id.parse(request.params).id)) }
  })

  /** An invoice typed by hand: no document, no credit. */
  app.post('/', async (request) => {
    const org = orgOf(request, CAN.operate)
    return idempotent(db, org.id, request, async () => {
      const input = InvoiceInput.parse(request.body)
      const created = await db.tx(async tx => {
        const client = await resolveClient(tx, org.id, input.client)
        const built = buildInvoice(input, client, await taxProfile(tx, org.id))
        const inv = await insertDraft(tx, {
          orgId: org.id, source: 'manual', clientId: client.id, built, currency: input.currency, issueDate: input.issue_date, dueDate: input.due_date,
          reference: input.reference, poNumber: input.po_number, period: input.period, notes: input.notes, createdBy: request.user!.id,
        })
        await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.created', 'invoice', inv.id, { source: 'manual', number: inv.number })
        return inv
      })
      return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, created.id)) }
    })
  })

  /** Edit a draft that came from a document or was typed by hand. Amounts are recomputed by code. */
  app.put('/:id', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const input = InvoiceInput.parse(request.body)
    await db.tx(async tx => {
      const row = await loadInvoice(tx, org.id, id, true)
      if (row.status !== 'draft') throw notDraft()
      if (row.source === 'report') throw badRequest('Corrigez les quantités de cette facture depuis le rapport (bouton « Corriger »).')
      const client = await resolveClient(tx, org.id, input.client)
      const doc = row.document_id
        ? await tx.get<{ extracted_invoice: ExtractedInvoice | null; ocr_confidence: number | null }>('SELECT extracted_invoice, ocr_confidence FROM documents WHERE id = ? AND org_id = ?', row.document_id, org.id)
        : undefined
      const built = buildInvoice(input, client, await taxProfile(tx, org.id), { extracted: doc?.extracted_invoice ?? null, ocrConfidence: doc?.ocr_confidence ?? null })
      const corrections = [...row.corrections, {
        code: 'facture', before: `${formatMoney(row.total_cents)} ${row.currency}`, after: `${formatMoney(built.totalCents)} ${input.currency}`,
        note: 'Facture modifiée', by: request.user!.id, at: now(),
      }]
      await tx.run(`UPDATE invoices SET client_id = ?, lines = ?, subtotal_cents = ?, discount_cents = ?, vat_rate_bp = ?, vat_cents = ?, total_cents = ?,
        currency = ?, issue_date = ?, due_date = ?, reference = ?, po_number = ?, period = ?, notes = ?, checks = ?, corrections = ? WHERE id = ? AND org_id = ?`,
      client.id, JSON.stringify(built.lines), built.subtotalCents, built.discountCents, built.vatRateBp, built.vatCents, built.totalCents,
      input.currency, input.issue_date, input.due_date, input.reference || null, input.po_number || null, input.period || null, input.notes || null,
      JSON.stringify(built.checks), JSON.stringify(corrections), id, org.id)
      await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.corrected', 'invoice', id, { total_cents: built.totalCents })
    })
    return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
  })

  app.post('/:id/validate', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    return idempotent(db, org.id, request, async () => {
      await db.tx(async tx => {
        const row = await loadInvoice(tx, org.id, id, true)
        if (row.status !== 'draft') throw notDraft()
        const blocking = row.checks.filter(c => c.status === 'error')
        if (blocking.length) throw new HttpError(409, 'blocking_checks', `À corriger avant validation : ${blocking.map(c => c.title).join(', ')}.`)
        const number = await nextNumber(tx, org.id, Number(row.issue_date.slice(0, 4)), 'FAC')
        await tx.run("UPDATE invoices SET status = 'validated', number = ?, decided_by = ?, decided_at = now() WHERE id = ? AND org_id = ?",
          number, request.user!.id, id, org.id)
        await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.validated', 'invoice', id, { number, draft: row.number })
      })
      return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
    })
  })

  app.post('/:id/reject', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indiquez la raison du rejet.').max(500) }).strict().parse(request.body)
    await loadInvoice(db, org.id, id)
    const changed = await db.run("UPDATE invoices SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = now() WHERE id = ? AND org_id = ? AND status = 'draft'",
      reason, request.user!.id, id, org.id)
    if (changed === 0) throw notDraft()
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.rejected', 'invoice', id)
    return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
  })

  /** Quantities of a draft built from an activity report and its contract. */
  app.post('/:id/correct', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const body = z.object({
      lines: z.array(z.object({ code: z.string().max(20), qty: z.string().trim().regex(/^\d{1,9}([.,]\d{1,3})?$/, 'Quantité invalide.') })).min(1).max(200),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body)
    await db.tx(async tx => {
      const row = await loadInvoice(tx, org.id, id, true)
      if (row.status !== 'draft') throw notDraft()
      if (row.source !== 'report' || !row.document_id || !row.contract_id) throw badRequest('Modifiez cette facture avec le formulaire complet.')
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
      const draft = buildDraft(doc.extracted, contract, client, await taxProfile(tx, org.id), overrides)
      await tx.run(`UPDATE invoices SET lines = ?, subtotal_cents = ?, vat_rate_bp = ?, vat_cents = ?, total_cents = ?, checks = ?, corrections = ? WHERE id = ? AND org_id = ?`,
        JSON.stringify(draft.lines), draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, JSON.stringify(draft.checks), JSON.stringify(corrections), id, org.id)
      // Corrections are kept as learning material (directive 6.4); nothing is applied automatically.
      await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.corrected', 'invoice', id, { lines: body.lines.map(l => l.code) })
    })
    return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
  })

  app.get('/:id/pdf', async (request, reply) => {
    const org = orgOf(request)
    const row = await loadInvoice(db, org.id, Id.parse(request.params).id)
    const pdf = await invoicePdf(db, config, row)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.pdf_downloaded', 'invoice', row.id)
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${row.number}.pdf"`)
      .header('cache-control', 'private, no-store')
      .send(pdf)
  })

  // ------------------------------------------------------------ customer payments (money received, not credits)

  app.get('/:id/payments', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    await loadInvoice(db, org.id, id)
    return {
      payments: await db.all(`SELECT p.id, p.amount_cents, p.reversal_of, p.paid_on, p.method, p.note, p.created_at, u.email AS created_by_email,
        EXISTS (SELECT 1 FROM invoice_payments r WHERE r.reversal_of = p.id) AS reversed
        FROM invoice_payments p JOIN users u ON u.id = p.created_by WHERE p.org_id = ? AND p.invoice_id = ? ORDER BY p.created_at`, org.id, id),
    }
  })

  app.post('/:id/payments', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const body = z.object({
      amount: z.string().trim().regex(/^\d{1,12}([.,]\d{1,2})?$/, 'Montant invalide.'),
      paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ.'),
      method: z.enum(PAYMENT_METHODS),
      note: z.string().trim().max(300).nullable().optional(),
    }).strict().parse(request.body)
    return idempotent(db, org.id, request, async () => {
      await db.tx(async tx => {
        const row = await loadInvoice(tx, org.id, id, true)
        if (row.status !== 'validated') throw badRequest('Seule une facture validée peut recevoir un paiement.')
        const amount = parseMoney(body.amount.replace(',', '.'))
        if (amount <= 0) throw badRequest('Le montant doit être supérieur à zéro.')
        const remaining = row.total_cents - row.amount_paid_cents
        if (amount > remaining) throw badRequest(`Le montant dépasse le reste à payer (${formatMoney(remaining)} ${row.currency}).`)
        const paymentId = randomUUID()
        await tx.run('INSERT INTO invoice_payments (id, org_id, invoice_id, amount_cents, paid_on, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          paymentId, org.id, id, amount, body.paid_on, body.method, body.note ?? null, request.user!.id)
        const paid = row.amount_paid_cents + amount
        const { status } = paymentState(row.total_cents, paid)
        await tx.run('UPDATE invoices SET amount_paid_cents = ?, payment_status = ?, paid_at = CASE WHEN ? THEN now() ELSE NULL END WHERE id = ? AND org_id = ?',
          paid, status, status === 'paid', id, org.id)
        await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.payment_recorded', 'invoice', id, { amount_cents: amount, method: body.method, status })
      })
      return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
    })
  })

  /** A payment recorded by mistake is cancelled by a reversal, never deleted. */
  app.post('/:id/payments/:paymentId/reverse', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id, paymentId } = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() }).parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Indiquez la raison.').max(300) }).strict().parse(request.body)
    await db.tx(async tx => {
      const row = await loadInvoice(tx, org.id, id, true)
      const payment = await tx.get<{ amount_cents: number; reversal_of: string | null }>('SELECT amount_cents, reversal_of FROM invoice_payments WHERE id = ? AND invoice_id = ? AND org_id = ?', paymentId, id, org.id)
      if (!payment || payment.reversal_of) throw notFound('Paiement')
      if (await tx.get('SELECT 1 FROM invoice_payments WHERE reversal_of = ?', paymentId)) throw new HttpError(409, 'already_reversed', 'Ce paiement a déjà été annulé.')
      await tx.run('INSERT INTO invoice_payments (id, org_id, invoice_id, amount_cents, reversal_of, paid_on, method, note, created_by) VALUES (?, ?, ?, ?, ?, current_date, NULL, ?, ?)',
        randomUUID(), org.id, id, -payment.amount_cents, paymentId, `Annulation : ${reason}`, request.user!.id)
      const paid = Math.max(0, row.amount_paid_cents - payment.amount_cents)
      const { status } = paymentState(row.total_cents, paid)
      await tx.run('UPDATE invoices SET amount_paid_cents = ?, payment_status = ?, paid_at = CASE WHEN ? THEN paid_at ELSE NULL END WHERE id = ? AND org_id = ?',
        paid, status, status === 'paid', id, org.id)
      await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.payment_reversed', 'invoice', id, { amount_cents: payment.amount_cents, reason })
    })
    return { invoice: await presentInvoice(db, await loadInvoice(db, org.id, id)) }
  })

  // ------------------------------------------------------------ sharing

  const shareKey = Buffer.from(hmac(config.masterKey, 'invoice-share-key-v1'), 'hex')

  app.get('/:id/shares', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    await loadInvoice(db, org.id, id)
    return { shares: await db.all('SELECT id, expires_at, revoked_at, views, created_at FROM invoice_shares WHERE org_id = ? AND invoice_id = ? ORDER BY created_at DESC', org.id, id) }
  })

  /** A link the organization gives to its customer: read-only PDF of a validated invoice, expiring, revocable. */
  app.post('/:id/shares', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const { days } = z.object({ days: z.number().int().min(1).max(90).default(30) }).strict().parse(request.body ?? {})
    const row = await loadInvoice(db, org.id, id)
    if (row.status !== 'validated') throw badRequest('Seule une facture validée peut être partagée.')
    const token = randomBytes(32).toString('base64url')
    const shareId = randomUUID()
    await db.run(`INSERT INTO invoice_shares (id, org_id, invoice_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, now() + make_interval(days => ?), ?)`,
      shareId, org.id, id, hmac(shareKey, token), days, request.user!.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.shared', 'invoice', id, { days })
    // The token is shown once; only its keyed hash is stored.
    return { share: { id: shareId, url: `${config.publicOrigin}/api/public/invoices/${token}/pdf`, expires_in_days: days } }
  })

  app.delete('/:id/shares/:shareId', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id, shareId } = z.object({ id: z.string().uuid(), shareId: z.string().uuid() }).parse(request.params)
    const changed = await db.run('UPDATE invoice_shares SET revoked_at = now() WHERE id = ? AND invoice_id = ? AND org_id = ? AND revoked_at IS NULL', shareId, id, org.id)
    if (changed === 0) throw notFound('Lien')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.share_revoked', 'invoice', id)
    return { ok: true }
  })

  /** Sending is an outbound action: a person clicks it, for a validated invoice only (rule 7). */
  app.post('/:id/send', async (request) => {
    const org = orgOf(request, CAN.validate)
    const { id } = Id.parse(request.params)
    const body = z.object({
      to: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(254).optional(),
      message: z.string().trim().max(2000).optional(),
    }).strict().parse(request.body ?? {})
    if (!mailer.sendMail) {
      throw new HttpError(503, 'mail_unavailable', "L'envoi d'e-mails n'est pas configuré sur ce serveur. Téléchargez le PDF et transmettez-le vous-même.")
    }
    return idempotent(db, org.id, request, async () => {
      const row = await loadInvoice(db, org.id, id)
      if (row.status !== 'validated') throw badRequest('Validez la facture avant de l\'envoyer.')
      const client = (await clientById(db, org.id, row.client_id))!
      const to = body.to ?? client.email
      if (!to) throw badRequest("Ce client n'a pas d'adresse e-mail : indiquez-en une.")
      const orgRow = (await db.get<{ name: string }>('SELECT name FROM organizations WHERE id = ?', org.id))!
      const pdf = await invoicePdf(db, config, row)
      const total = `${formatMoney(row.total_cents)} ${row.currency}`
      try {
        await mailer.sendMail!({
          to, subject: `${orgRow.name} — Facture ${row.number} (${total})`,
          text: [body.message ?? 'Bonjour,', '', `Veuillez trouver ci-joint la facture ${row.number} d'un montant de ${total}, payable au plus tard le ${row.due_date.split('-').reverse().join('/')}.`,
            '', 'Document non fiscal — la facture normalisée DGI est émise par le dispositif homologué de l\'émetteur.', '', orgRow.name].join('\n'),
          replyTo: request.user!.email,
          attachments: [{ filename: `${row.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
        })
      } catch (error) {
        request.log.error({ err: String(error) }, 'invoice e-mail failed')
        throw new HttpError(503, 'mail_failed', "L'e-mail n'a pas pu être envoyé. Réessayez dans quelques minutes.")
      }
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'invoice.sent', 'invoice', id, { to: to.replace(/^(.{2}).*@/, '$1***@') })
      return { ok: true, to }
    })
  })
}

/** The customer opens the shared link: no account, only this one validated invoice, while the link is valid. */
export async function publicInvoiceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const shareKey = Buffer.from(hmac(config.masterKey, 'invoice-share-key-v1'), 'hex')
  const limiter = new RateLimiter()
  app.get('/:token/pdf', async (request, reply) => {
    if (!limiter.take(`share:${request.ip}`, 60, 10 * 60_000)) throw new HttpError(429, 'rate_limited', 'Trop de tentatives. Patientez quelques minutes.')
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.params)
    const share = await db.get<{ id: string; org_id: string; invoice_id: string }>(`SELECT id, org_id, invoice_id FROM invoice_shares
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()`, hmac(shareKey, token))
    if (!share) throw notFound('Lien')
    const row = await db.get<InvoiceRow>("SELECT * FROM invoices WHERE id = ? AND org_id = ? AND status = 'validated'", share.invoice_id, share.org_id)
    if (!row) throw notFound('Lien')
    await db.run('UPDATE invoice_shares SET views = views + 1 WHERE id = ?', share.id)
    await audit(db, { orgId: share.org_id, userId: null }, 'invoice.share_viewed', 'invoice', row.id)
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${row.number}.pdf"`)
      .header('cache-control', 'private, no-store')
      .header('x-robots-tag', 'noindex')
      .send(await invoicePdf(db, config, row))
  })
}
