/**
 * SasPay client (https://docs.saspay.me, read 2026-11-17). Only operations the official documentation
 * and OpenAPI file describe are used:
 *   POST /checkout-sessions/              hosted payment page (catalogue, read 2026-11-18: RDC networks airtel_cd,
 *                                         orange_cd, vodacom_cd in CDF; `card` Visa/Mastercard in USD only)
 *   GET  /checkout-sessions/{id}/         session details (amount, currency, status)
 *   GET  /checkout-sessions/{id}/status/  status re-checked with the gateway: PAID + transaction_status SUCCESS
 * Webhooks: HMAC-SHA256 of "{X-Webhook-Timestamp}.{raw body}" with the webhook signing secret,
 * lowercase hex in X-Webhook-Signature, timestamps older than 300 s refused.
 *
 * The documentation shows responses both bare and wrapped in {success, data, code}: both are accepted.
 * A webhook never credits by itself: it only triggers a server-side verification (payments.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SasPayConfig {
  baseUrl: string
  apiKey: string
  /** Signing secret of the webhook created in the SasPay dashboard. */
  webhookSecret: string | undefined
}

export interface CheckoutSession {
  id: string
  checkout_url: string
  status: string
  amount: string
  currency: string
}

export interface CheckoutStatus {
  id: string
  status: string
  transaction_id: string | null
  transaction_status: string | null
  transaction_reference: string | null
}

export class SasPayError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

const TIMEOUT_MS = 20_000

export function createSasPay(config: SasPayConfig, fetchImpl: typeof fetch = fetch) {
  const base = config.baseUrl.replace(/\/+$/, '')

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (error) {
      throw new SasPayError(0, `SasPay injoignable (${(error as Error).name})`)
    }
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* non-JSON error page */ }
    if (!res.ok || json.success === false) {
      const err = (json.error && typeof json.error === 'object' ? json.error : json) as { message?: unknown; code?: unknown }
      const message = typeof err.message === 'string' ? err.message : `HTTP ${res.status}`
      throw new SasPayError(res.status, message.slice(0, 300), typeof err.code === 'string' ? err.code : undefined)
    }
    // Wrapped ({success, data}) or bare resource.
    return (json.success === true && json.data && typeof json.data === 'object' ? json.data : json) as T
  }

  return {
    async createCheckoutSession(input: {
      amountCents: number; currency: string; customerEmail: string; customerName: string
      description: string; returnUrl: string; metadata: Record<string, string>; country?: string
      /** When SasPay stops accepting payment on this session (OpenAPI: `expires_at`, string, date-time). */
      expiresAt?: Date
    }): Promise<CheckoutSession> {
      const session = await call<CheckoutSession>('POST', '/checkout-sessions/', {
        amount: centsToDecimal(input.amountCents),
        currency: input.currency,
        customer_email: input.customerEmail,
        customer_name: input.customerName.slice(0, 120),
        description: input.description.slice(0, 200),
        return_url: input.returnUrl,
        metadata: input.metadata,
        ...(input.country ? { country: input.country } : {}),
        ...(input.expiresAt ? { expires_at: input.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
      })
      if (!session.id || !session.checkout_url) throw new SasPayError(502, 'Réponse SasPay incomplète (id ou checkout_url manquant).')
      return session
    },
    getCheckoutSession: (id: string) => call<CheckoutSession>('GET', `/checkout-sessions/${encodeURIComponent(id)}/`),
    getCheckoutStatus: (id: string) => call<CheckoutStatus>('GET', `/checkout-sessions/${encodeURIComponent(id)}/status/`),
  }
}

export type SasPay = ReturnType<typeof createSasPay>

/** "2500.00" from 250000 cents. Amounts are decimal strings in the SasPay API. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** Cents from "2500.00", "2500" or "2500.5"; NaN when not a plain decimal. */
export function decimalToCents(value: unknown): number {
  const s = String(value ?? '').trim()
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return Number.NaN
  const [int, dec = ''] = s.split('.')
  return Number(int) * 100 + Number(dec.padEnd(2, '0'))
}

export const WEBHOOK_TOLERANCE_SECONDS = 300

/** Constant-time check of a SasPay webhook signature over the raw body. */
export function verifyWebhookSignature(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest()
  const given = Buffer.from(signature.toLowerCase(), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Test helper and documentation of the scheme. */
export function signWebhook(rawBody: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}
