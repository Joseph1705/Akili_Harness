/**
 * Platform administration (our team: AKILI_PLATFORM_ADMINS). Organizations and balances, credit packages
 * and prices, payments, the credit ledger, promotional allocations, refunds and corrections.
 * Organizations cannot credit themselves. Every financial action is written to the audit log,
 * and corrections are compensating transactions: nothing is ever deleted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { audit } from './audit.js'
import { platformAdminOf } from './auth/context.js'
import { resumeWaitingDocuments } from './credits.js'
import { HttpError, notFound } from './errors.js'
import { applyCredit } from './billing/wallet.js'
import { verifyPayment } from './billing/payments.js'

const priceRequired = () => new HttpError(400, 'price_required', 'Fixez un prix avant de mettre ce paquet en vente.')
const Reason = z.string().trim().min(3, 'Indiquez le motif.').max(300)

const PackageInput = z.object({
  name: z.string().trim().min(2).max(60),
  credits: z.number().int().min(1).max(1_000_000),
  price_cents: z.number().int().min(1).max(1_000_000_000).nullable(),
  currency: z.enum(['USD', 'CDF']),
  description: z.string().trim().max(300).nullable().optional(),
  active: z.boolean(),
  promotional: z.boolean().default(false),
  sort_order: z.number().int().min(0).max(1000).default(0),
}).strict()

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const admin = (request: FastifyRequest) => platformAdminOf(request, config)
  /** The operator may send an Idempotency-Key so a double click never allocates twice. */
  const opKey = (request: FastifyRequest, prefix: string) => {
    const key = request.headers['idempotency-key']
    return `${prefix}:${typeof key === 'string' && /^[0-9a-f-]{36}$/i.test(key) ? key : randomUUID()}`
  }
  const orgExists = async (id: string) => { if (!await db.get('SELECT 1 FROM organizations WHERE id = ?', id)) throw notFound('Organisation') }
  const Id = z.object({ id: z.string().uuid() })

  app.get('/orgs', async (request) => {
    admin(request)
    return {
      orgs: await db.all(`SELECT o.id, o.name, o.kind, o.plan, o.city, o.created_at, o.onboarding_done_at,
        COALESCE(w.balance, 0) AS balance, COALESCE(w.total_purchased, 0) AS total_purchased, COALESCE(w.total_consumed, 0) AS total_consumed,
        COALESCE(w.low_balance_threshold, 10) AS low_balance_threshold,
        (SELECT count(*) FROM memberships m WHERE m.org_id = o.id) AS members,
        (SELECT count(*) FROM documents d WHERE d.org_id = o.id) AS documents,
        (SELECT count(*) FROM documents d WHERE d.org_id = o.id AND d.processed_at >= now() - interval '30 days' AND d.status = 'done') AS documents_30d,
        (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_email
        FROM organizations o LEFT JOIN credit_wallets w ON w.org_id = o.id ORDER BY o.created_at DESC LIMIT 500`),
    }
  })

  /** Promotional or commercial allocation (e.g. payment received outside SasPay). */
  app.post('/orgs/:id/credits', async (request) => {
    const user = admin(request)
    const { id } = Id.parse(request.params)
    const body = z.object({
      credits: z.number().int().min(1).max(100_000),
      ref: z.string().trim().min(3, 'Référence ou motif requis.').max(80),
      promotional: z.boolean().optional(),
    }).strict().parse(request.body)
    await orgExists(id)
    const { transaction } = await applyCredit(db, {
      orgId: id, type: 'admin_allocation', amount: body.credits, operationKey: opKey(request, 'allocation'), actorUserId: user.id,
      paymentReference: body.promotional ? null : body.ref, reason: body.promotional ? `Promotion : ${body.ref}` : `Allocation : ${body.ref}`,
    })
    await resumeWaitingDocuments(db, id)
    await audit(db, { orgId: id, userId: user.id }, 'credits.topup', 'credits', transaction.public_id, { credits: body.credits, ref: body.ref, by: 'platform', promotional: Boolean(body.promotional) })
    return { ok: true, transaction }
  })

  app.post('/orgs/:id/refunds', async (request) => {
    const user = admin(request)
    const { id } = Id.parse(request.params)
    const body = z.object({ credits: z.number().int().min(1).max(100_000), reason: Reason, transactionId: z.string().uuid().optional() }).strict().parse(request.body)
    await orgExists(id)
    if (body.transactionId && !await db.get('SELECT 1 FROM credit_transactions WHERE public_id = ? AND org_id = ?', body.transactionId, id)) throw notFound('Transaction')
    const { transaction } = await applyCredit(db, {
      orgId: id, type: 'refund', amount: body.credits, actorUserId: user.id, reason: body.reason,
      operationKey: body.transactionId ? `refund:${body.transactionId}` : opKey(request, 'refund'),
    })
    await resumeWaitingDocuments(db, id)
    await audit(db, { orgId: id, userId: user.id }, 'credits.refunded', 'credits', transaction.public_id, { credits: body.credits, reason: body.reason, of: body.transactionId ?? null })
    return { ok: true, transaction }
  })

  app.post('/orgs/:id/corrections', async (request) => {
    const user = admin(request)
    const { id } = Id.parse(request.params)
    const body = z.object({ amount: z.number().int().min(-100_000).max(100_000).refine(n => n !== 0, 'Montant non nul.'), reason: Reason }).strict().parse(request.body)
    await orgExists(id)
    const { transaction } = await applyCredit(db, { orgId: id, type: 'admin_correction', amount: body.amount, actorUserId: user.id, reason: body.reason, operationKey: opKey(request, 'correction') })
    if (body.amount > 0) await resumeWaitingDocuments(db, id)
    await audit(db, { orgId: id, userId: user.id }, 'credits.corrected', 'credits', transaction.public_id, body)
    return { ok: true, transaction }
  })

  app.get('/transactions', async (request) => {
    admin(request)
    const q = z.object({
      org: z.string().uuid().optional(),
      type: z.enum(['purchase', 'consumption', 'refund', 'admin_allocation', 'admin_correction']).optional(),
    }).parse(request.query)
    return {
      transactions: await db.all(`SELECT t.public_id AS id, t.org_id, o.name AS org_name, t.type, t.amount, t.balance_before, t.balance_after,
        t.operation_key, t.document_id, t.invoice_id, t.payment_id, t.payment_reference, t.reason, t.status, t.created_at, u.email AS actor_email
        FROM credit_transactions t JOIN organizations o ON o.id = t.org_id LEFT JOIN users u ON u.id = t.actor_user_id
        WHERE (?::uuid IS NULL OR t.org_id = ?::uuid) AND (?::text IS NULL OR t.type = ?::text)
        ORDER BY t.id DESC LIMIT 300`, q.org ?? null, q.org ?? null, q.type ?? null, q.type ?? null),
    }
  })

  app.get('/packages', async (request) => {
    admin(request)
    return { packages: await db.all('SELECT * FROM credit_packages ORDER BY sort_order, credits') }
  })

  app.post('/packages', async (request) => {
    const user = admin(request)
    const body = PackageInput.parse(request.body)
    if (body.active && body.price_cents === null) throw priceRequired()
    const id = randomUUID()
    await db.run(`INSERT INTO credit_packages (id, name, credits, price_cents, currency, description, active, promotional, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, body.name, body.credits, body.price_cents, body.currency, body.description ?? null, body.active, body.promotional, body.sort_order)
    await audit(db, { orgId: null, userId: user.id }, 'platform.package_created', 'package', id, body)
    return { package: await db.get('SELECT * FROM credit_packages WHERE id = ?', id) }
  })

  app.put('/packages/:id', async (request) => {
    const user = admin(request)
    const { id } = Id.parse(request.params)
    const body = PackageInput.parse(request.body)
    if (body.active && body.price_cents === null) throw priceRequired()
    const before = await db.get('SELECT * FROM credit_packages WHERE id = ?', id)
    if (!before) throw notFound('Paquet')
    await db.run(`UPDATE credit_packages SET name = ?, credits = ?, price_cents = ?, currency = ?, description = ?, active = ?, promotional = ?, sort_order = ?, updated_at = now()
      WHERE id = ?`, body.name, body.credits, body.price_cents, body.currency, body.description ?? null, body.active, body.promotional, body.sort_order, id)
    // Payments already started keep the price they were created with (stored on the payment).
    await audit(db, { orgId: null, userId: user.id }, 'platform.package_updated', 'package', id, { before, after: body })
    return { package: await db.get('SELECT * FROM credit_packages WHERE id = ?', id) }
  })

  app.get('/payments', async (request) => {
    admin(request)
    const { status } = z.object({ status: z.enum(['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired']).optional() }).parse(request.query)
    return {
      payments: await db.all(`SELECT p.id, p.org_id, o.name AS org_name, p.package_name, p.credits, p.amount_cents, p.currency, p.status, p.provider,
        p.provider_session_id, p.provider_reference, p.provider_status, p.failure_reason, p.created_at, p.verified_at, p.credited_at, u.email AS created_by_email
        FROM payments p JOIN organizations o ON o.id = p.org_id JOIN users u ON u.id = p.created_by
        WHERE (?::text IS NULL OR p.status = ?::text) ORDER BY p.created_at DESC LIMIT 300`, status ?? null, status ?? null),
      events: await db.all('SELECT id, provider, event_type, signature_valid, result, received_at FROM payment_events ORDER BY id DESC LIMIT 50'),
    }
  })

  app.post('/payments/:id/verify', async (request) => {
    const user = admin(request)
    const { id } = Id.parse(request.params)
    const payment = await verifyPayment(app, id)
    await audit(db, { orgId: payment.org_id, userId: user.id }, 'platform.payment_verified', 'payment', id, { status: payment.status })
    return { payment }
  })

  /** Document processing per organization, last 30 days. */
  app.get('/usage', async (request) => {
    admin(request)
    return {
      days: await db.all(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS documents,
        -SUM(amount)::int AS credits FROM credit_transactions WHERE type = 'consumption' AND created_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`),
      totals: await db.get(`SELECT COALESCE(SUM(balance), 0)::int AS outstanding, COALESCE(SUM(total_purchased), 0)::int AS purchased,
        COALESCE(SUM(total_consumed), 0)::int AS consumed FROM credit_wallets`),
      revenue: await db.all(`SELECT currency, SUM(amount_cents)::bigint AS amount_cents, count(*)::int AS payments
        FROM payments WHERE status = 'succeeded' GROUP BY currency`),
    }
  })

  /** Our own operating cost of AI (internal; never shown to customers as a price): by day, model and organization. */
  app.get('/ai', async (request) => {
    admin(request)
    const since = "created_at >= now() - interval '30 days'"
    return {
      days: await db.all(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs,
        COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens, COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost_micro_usd, count(*) FILTER (WHERE status IN ('error', 'blocked'))::int AS errors,
        COALESCE(round(avg(duration_ms)), 0)::int AS avg_ms FROM ai_runs WHERE ${since} GROUP BY 1 ORDER BY 1`),
      models: await db.all(`SELECT provider, model, count(*)::int AS runs, COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost_micro_usd,
        COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens FROM ai_runs WHERE ${since} AND model IS NOT NULL GROUP BY provider, model ORDER BY cost_micro_usd DESC`),
      orgs: await db.all(`SELECT r.org_id, o.name, count(*)::int AS runs, COALESCE(SUM(r.cost_micro_usd), 0)::bigint AS cost_micro_usd,
        count(*) FILTER (WHERE r.purpose = 'extraction')::int AS extractions FROM ai_runs r JOIN organizations o ON o.id = r.org_id
        WHERE r.${since} GROUP BY r.org_id, o.name ORDER BY cost_micro_usd DESC LIMIT 50`),
      errors: await db.all(`SELECT id, org_id, purpose, provider, model, status, error, created_at FROM ai_runs WHERE ${since} AND status IN ('error', 'blocked')
        ORDER BY created_at DESC LIMIT 50`),
      evals: await db.all('SELECT id, org_id, suite, method, cases, score, created_at FROM ai_evals ORDER BY created_at DESC LIMIT 20'),
    }
  })

  /** Measure document reading on the fictitious documents (local reading, or an organization's model). */
  app.post('/evals/extraction', async (request) => {
    const user = admin(request)
    const body = z.object({ method: z.enum(['local', 'model']), orgId: z.string().uuid().optional() }).strict().parse(request.body)
    if (body.method === 'model' && !body.orgId) throw new HttpError(400, 'bad_request', "Choisissez l'organisation dont le modèle est évalué.")
    const { evaluate } = await import('./ai/evals.js')
    const result = await evaluate(app, FIXTURES_DIR, body.method, body.orgId ?? null, user.id)
    await audit(db, { orgId: body.orgId ?? null, userId: user.id }, 'platform.eval_run', 'eval', result.id, { method: body.method, score: result.score })
    return result
  })
}

const FIXTURES_DIR = process.env.AKILI_FIXTURES_DIR ?? fileURLToPath(new URL('../../../fixtures', import.meta.url))
