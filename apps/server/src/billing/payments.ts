/**
 * Buying credit packages with SasPay (DIRECTIVES §5 E).
 *
 *   1. The organization picks an active package; we create a `payments` row (idempotent per Idempotency-Key)
 *      and a SasPay hosted checkout session for exactly the package price.
 *   2. The customer pays on SasPay (mobile money or card).
 *   3. Credits are added ONLY after our server asks SasPay itself: session PAID, transaction SUCCESS,
 *      same amount and currency. Visiting the return URL proves nothing; a webhook only triggers this check.
 *   4. The credit uses the operation key `payment:<id>`: repeated webhooks, return visits or reconciliations
 *      can never credit twice.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf, userOf } from '../auth/context.js'
import type { Db } from '../db.js'
import { HttpError, notFound } from '../errors.js'
import { resumeWaitingDocuments } from '../credits.js'
import { applyCredit } from './wallet.js'
import { createSasPay, decimalToCents, SasPayError, verifyWebhookSignature, type SasPay } from './saspay.js'

export interface PaymentRow {
  id: string; org_id: string; package_id: string | null; package_name: string; credits: number; amount_cents: number; currency: string
  provider: string; status: 'created' | 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  provider_session_id: string | null; checkout_url: string | null; provider_transaction_id: string | null; provider_reference: string | null
  provider_status: string | null; idempotency_key: string; created_by: string; failure_reason: string | null
  created_at: string; updated_at: string; verified_at: string | null; credited_at: string | null
}

const PUBLIC_FIELDS = `id, package_id, package_name, credits, amount_cents, currency, provider, status, checkout_url, provider_reference,
  failure_reason, created_at, updated_at, verified_at, credited_at`

const unavailable = () => new HttpError(503, 'payment_unavailable',
  "Le paiement en ligne n'est pas encore activé sur ce serveur. Contactez le support pour recharger votre compte.")

export function sasPayFor(app: FastifyInstance): SasPay | undefined {
  const cfg = app.deps.config.saspay
  return cfg ? createSasPay(cfg) : undefined
}

/**
 * Ask SasPay for the real state of one payment and credit it when, and only when, it is paid.
 * Safe to call any number of times, from anywhere.
 */
export async function verifyPayment(app: FastifyInstance, paymentId: string, orgId?: string): Promise<PaymentRow> {
  const { db } = app.deps
  const payment = await db.get<PaymentRow>(`SELECT * FROM payments WHERE id = ?${orgId ? ' AND org_id = ?' : ''}`, ...(orgId ? [paymentId, orgId] : [paymentId]))
  if (!payment) throw notFound('Paiement')
  // A payment closed on our side (expired, cancelled) is still asked about: if SasPay took the money, it is credited.
  if (!REVERIFIABLE.includes(payment.status) || !payment.provider_session_id) return payment
  const saspay = sasPayFor(app)
  if (!saspay) throw unavailable()

  const status = await saspay.getCheckoutStatus(payment.provider_session_id)
  const sessionStatus = String(status.status ?? '').toUpperCase()
  const txStatus = String(status.transaction_status ?? '').toUpperCase()
  await db.run('UPDATE payments SET provider_status = ?, verified_at = now(), updated_at = now() WHERE id = ?', `${sessionStatus}/${txStatus || '-'}`.slice(0, 60), payment.id)

  if (sessionStatus === 'PAID' && txStatus === 'SUCCESS') {
    // Amount and currency come from SasPay, never from the browser.
    const session = await saspay.getCheckoutSession(payment.provider_session_id)
    const paidCents = decimalToCents(session.amount)
    if (paidCents !== payment.amount_cents || String(session.currency).toUpperCase() !== payment.currency) {
      await db.run("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = now() WHERE id = ? AND status = 'pending'",
        `Montant ou devise différents chez SasPay (${session.amount} ${session.currency}). Aucun crédit ajouté ; le support vérifie.`, payment.id)
      await audit(db, { orgId: payment.org_id, userId: null }, 'payment.amount_mismatch', 'payment', payment.id, { expected: payment.amount_cents, currency: payment.currency })
      return (await db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', payment.id))!
    }
    await db.tx(async tx => {
      const changed = await tx.run(`UPDATE payments SET status = 'succeeded', failure_reason = NULL, provider_transaction_id = ?, provider_reference = ?, credited_at = now(), updated_at = now()
        WHERE id = ? AND status IN ('pending', 'expired', 'cancelled')`, status.transaction_id ?? null, status.transaction_reference ?? null, payment.id)
      if (changed === 0) return // another verification won the race; the credit below is idempotent anyway
      await applyCredit(tx, {
        orgId: payment.org_id, type: 'purchase', amount: payment.credits, operationKey: `payment:${payment.id}`,
        paymentId: payment.id, paymentReference: status.transaction_reference ?? payment.provider_session_id,
        actorUserId: payment.created_by, reason: `Achat du paquet ${payment.package_name}`,
      })
      await audit(tx, { orgId: payment.org_id, userId: null }, 'payment.succeeded', 'payment', payment.id, { credits: payment.credits, reference: status.transaction_reference })
    })
    await resumeWaitingDocuments(db, payment.org_id)
  } else if (sessionStatus === 'EXPIRED' || sessionStatus === 'CANCELLED') {
    await db.run('UPDATE payments SET status = ?, failure_reason = ?, updated_at = now() WHERE id = ? AND status = ?',
      sessionStatus === 'EXPIRED' ? 'expired' : 'cancelled', sessionStatus === 'EXPIRED' ? 'Session de paiement expirée.' : 'Paiement annulé.', payment.id, 'pending')
  } else if (txStatus === 'FAILED') {
    // The session stays open: the customer may retry on the SasPay page. Shown, not final.
    await db.run("UPDATE payments SET failure_reason = ?, updated_at = now() WHERE id = ? AND status = 'pending'", 'La dernière tentative de paiement a échoué. Vous pouvez réessayer.', payment.id)
  }
  return (await db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', payment.id))!
}

const REVERIFIABLE: ReadonlyArray<PaymentRow['status']> = ['pending', 'expired', 'cancelled']

/** SasPay stops taking payment on a session after this; we close it on our side later, after a last check. */
export const SESSION_HOURS = 48

/**
 * Check open payments with SasPay (webhook received, periodic reconciliation):
 *   - the most recent first, since a payment made a minute ago matters more than a checkout abandoned yesterday;
 *   - past `maxAgeHours`, one last check before the payment is closed on our side, so money taken by SasPay
 *     is never left uncredited (closed payments can still be re-checked later, see verifyPayment).
 */
export async function reconcilePayments(app: FastifyInstance, maxAgeHours = 72): Promise<number> {
  if (!app.deps.config.saspay) return 0
  const { db } = app.deps
  const recent = await db.all<{ id: string }>(`SELECT id FROM payments WHERE status = 'pending'
    AND created_at > now() - make_interval(hours => ?) ORDER BY created_at DESC LIMIT 150`, maxAgeHours)
  const stale = await db.all<{ id: string }>(`SELECT id FROM payments WHERE status = 'pending'
    AND created_at <= now() - make_interval(hours => ?) ORDER BY created_at LIMIT 50`, maxAgeHours)
  let done = 0
  for (const p of [...recent, ...stale]) {
    try { if ((await verifyPayment(app, p.id)).status === 'succeeded') done++ } catch (error) { app.log.warn({ payment: p.id, err: String(error) }, 'payment reconciliation') }
  }
  // Closed only when that last check, made after the deadline, still found them unpaid (a SasPay outage closes nothing).
  // A session that was never created has nothing to check.
  await db.run(`UPDATE payments SET status = 'expired', failure_reason = 'Session de paiement expirée.', updated_at = now()
    WHERE created_at <= now() - make_interval(hours => ?)
      AND (status = 'created' OR (status = 'pending' AND verified_at >= created_at + make_interval(hours => ?)))`, maxAgeHours, maxAgeHours)
  return done
}

const reconciling = new WeakMap<FastifyInstance, { again: boolean }>()

/**
 * Reconcile in the background, one run at a time per server: SasPay waits at most 15 s for our answer and
 * retries five times, so the webhook answers at once; a burst of webhooks queues at most one more run.
 */
export function reconcileSoon(app: FastifyInstance): void {
  const running = reconciling.get(app)
  if (running) { running.again = true; return }
  const state = { again: true }
  reconciling.set(app, state)
  void (async () => {
    while (state.again) {
      state.again = false
      try { await reconcilePayments(app) } catch (error) { app.log.warn({ err: String(error) }, 'payment reconciliation') }
    }
    reconciling.delete(app)
  })()
}

/**
 * Named as in SasPay's catalogue (docs.saspay.me/api-reference/reference/formats, read 2026-11-18): RDC (CD, CDF)
 * networks airtel_cd, orange_cd, vodacom_cd; global network `card` (Visa/Mastercard, USD only). Whether each one is
 * active on our merchant account is only known from GET /networks/ with the live key: to confirm before selling.
 */
const SASPAY_METHODS = ['Airtel Congo (CDF)', 'Orange Congo (CDF)', 'Vodacom Congo (CDF)', 'Carte Visa ou Mastercard (USD)']

async function listPackages(db: Db, activeOnly: boolean) {
  return db.all(`SELECT id, name, credits, price_cents, currency, description, active, promotional, sort_order, created_at, updated_at
    FROM credit_packages ${activeOnly ? 'WHERE active' : ''} ORDER BY sort_order, credits`)
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  app.get('/status', async (request) => {
    orgOf(request)
    return { online: Boolean(config.saspay), provider: 'SasPay', methods: SASPAY_METHODS }
  })

  app.get('/packages', async (request) => {
    orgOf(request)
    return { packages: await listPackages(db, true) }
  })

  app.get('/purchases', async (request) => {
    const org = orgOf(request, CAN.billing)
    return { purchases: await db.all(`SELECT ${PUBLIC_FIELDS} FROM payments WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`, org.id) }
  })

  app.post('/purchases', async (request) => {
    const org = orgOf(request, CAN.billing)
    const user = userOf(request)
    const key = z.string().uuid('En-tête Idempotency-Key requis.').parse(request.headers['idempotency-key'])
    const { packageId } = z.object({ packageId: z.string().uuid() }).strict().parse(request.body)
    const saspay = sasPayFor(app)
    if (!saspay) throw unavailable()

    const existing = await db.get<PaymentRow>('SELECT * FROM payments WHERE org_id = ? AND created_by = ? AND idempotency_key = ?', org.id, user.id, key)
    if (existing) return { purchase: await db.get(`SELECT ${PUBLIC_FIELDS} FROM payments WHERE id = ?`, existing.id) }

    const pack = await db.get<{ id: string; name: string; credits: number; price_cents: number; currency: string }>(
      'SELECT id, name, credits, price_cents, currency FROM credit_packages WHERE id = ? AND active', packageId)
    if (!pack) throw notFound('Paquet')
    const id = randomUUID()
    const inserted = await db.run(`INSERT INTO payments (id, org_id, package_id, package_name, credits, amount_cents, currency, status, idempotency_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?) ON CONFLICT (org_id, created_by, idempotency_key) DO NOTHING`,
    id, org.id, pack.id, pack.name, pack.credits, pack.price_cents, pack.currency, key, user.id)
    if (inserted === 0) {
      const again = await db.get<{ id: string }>('SELECT id FROM payments WHERE org_id = ? AND created_by = ? AND idempotency_key = ?', org.id, user.id, key)
      return { purchase: await db.get(`SELECT ${PUBLIC_FIELDS} FROM payments WHERE id = ?`, again!.id) }
    }
    try {
      const session = await saspay.createCheckoutSession({
        amountCents: pack.price_cents, currency: pack.currency,
        customerEmail: user.email, customerName: [user.first_name, user.last_name].filter(Boolean).join(' ') || org.name,
        description: `${pack.credits} crédits — paquet ${pack.name}`,
        returnUrl: `${config.publicOrigin}/credits?paiement=${id}`,
        metadata: { payment_id: id }, country: pack.currency === 'CDF' ? 'CD' : undefined,
        expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
      })
      await db.run("UPDATE payments SET status = 'pending', provider_session_id = ?, checkout_url = ?, provider_status = ?, updated_at = now() WHERE id = ?",
        session.id, session.checkout_url, String(session.status ?? 'PENDING').slice(0, 60), id)
    } catch (error) {
      const reason = error instanceof SasPayError ? error.message : 'Erreur inattendue.'
      await db.run("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = now() WHERE id = ?", `SasPay : ${reason}`.slice(0, 300), id)
      request.log.error({ payment: id, err: String(error) }, 'saspay checkout failed')
      throw new HttpError(502, 'payment_provider_error', "Le service de paiement n'a pas pu créer la session. Réessayez dans quelques minutes.")
    }
    await audit(db, { orgId: org.id, userId: user.id }, 'payment.started', 'payment', id, { package: pack.name, credits: pack.credits, amount_cents: pack.price_cents, currency: pack.currency })
    return { purchase: await db.get(`SELECT ${PUBLIC_FIELDS} FROM payments WHERE id = ?`, id) }
  })

  /** Called by the return page: re-checks with SasPay, never trusts the URL. */
  app.post('/purchases/:id/verify', async (request) => {
    const org = orgOf(request, CAN.billing)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const payment = await verifyPayment(app, id, org.id)
    return { purchase: await db.get(`SELECT ${PUBLIC_FIELDS} FROM payments WHERE id = ?`, payment.id) }
  })
}

/** SasPay webhook, outside the browser origin check, raw body kept for the signature. */
export async function sasPayWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body))

  app.post('/saspay', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('')
    const secret = config.saspay?.webhookSecret
    if (!secret) return reply.status(503).send({ error: 'webhook_not_configured' })
    const valid = verifyWebhookSignature(raw, request.headers['x-webhook-timestamp'] as string | undefined, request.headers['x-webhook-signature'] as string | undefined, secret)
    let payload: { event?: string } | null = null
    try { payload = JSON.parse(raw.toString('utf8')) } catch { payload = null }
    const event = typeof payload?.event === 'string' ? payload.event.slice(0, 60) : String(request.headers['x-webhook-event'] ?? '').slice(0, 60)
    if (!valid) {
      // Logged, not stored: anyone on the Internet can call this address, and must not be able to fill the database.
      request.log.warn({ event: event || null }, 'saspay webhook rejected: bad signature or timestamp')
      return reply.status(403).send({ error: 'invalid_signature' })
    }
    let result = 'ignored'
    if (event.startsWith('transaction.')) {
      // The event names no checkout session: every open payment is verified with SasPay, after we answer.
      reconcileSoon(app)
      result = 'reconciliation scheduled'
    }
    await db.run('INSERT INTO payment_events (provider, event_type, signature_valid, payload, result) VALUES (?, ?, true, ?, ?)', 'saspay', event || null, JSON.stringify(payload ?? {}), result)
    return { ok: true }
  })
}
