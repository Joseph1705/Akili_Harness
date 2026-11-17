/**
 * A local HTTP server that answers like the SasPay API (shapes from docs.saspay.me, 2026-11-17).
 * The application talks to it over real HTTP; tests decide when a session is paid.
 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface FakeSession {
  id: string; slug: string; checkout_url: string; amount: string; currency: string; status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED'
  transaction_status: 'PENDING' | 'SUCCESS' | 'FAILED' | null; transaction_id: string | null; transaction_reference: string | null
  customer_email: string; metadata: Record<string, string>; return_url: string
}

export interface FakeSasPay {
  url: string
  apiKey: string
  sessions: Map<string, FakeSession>
  requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }>
  /** Respond wrapped in {success, data} (quickstart style) instead of bare (OpenAPI style). */
  wrapped: boolean
  failCreate: boolean
  pay(sessionId: string, opts?: { amount?: string }): void
  close(): Promise<void>
}

export async function startFakeSasPay(): Promise<FakeSasPay> {
  const fake: FakeSasPay = {
    url: '', apiKey: 'sk_test_fake_key', sessions: new Map(), requests: [], wrapped: false, failCreate: false,
    pay(id, opts = {}) {
      const s = fake.sessions.get(id)!
      s.status = 'PAID'; s.transaction_status = 'SUCCESS'; s.transaction_id = randomUUID(); s.transaction_reference = `TXN-${s.slug}`
      if (opts.amount) s.amount = opts.amount
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fake.wrapped && status < 400 ? { success: true, data: body, code: status } : body))
  }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/api\/v1/, '')
      const body = raw ? JSON.parse(raw) : undefined
      fake.requests.push({ method: req.method!, path, auth: req.headers.authorization, body })
      if (req.headers.authorization !== `Bearer ${fake.apiKey}`) return send(res, 401, { message: 'Clé API invalide.', code: 'unauthorized' })
      if (req.method === 'POST' && path === '/checkout-sessions/') {
        if (fake.failCreate) return send(res, 422, { message: 'no_route_available', code: 'no_route_available' })
        const id = randomUUID()
        const slug = id.slice(0, 8)
        const s: FakeSession = {
          id, slug, checkout_url: `https://pay.saspay.example/checkout/${slug}`, amount: body.amount, currency: body.currency, status: 'PENDING',
          transaction_status: null, transaction_id: null, transaction_reference: null, customer_email: body.customer_email, metadata: body.metadata, return_url: body.return_url,
        }
        fake.sessions.set(id, s)
        return send(res, 201, { id, slug, checkout_url: s.checkout_url, amount: s.amount, currency: s.currency, status: s.status, metadata: s.metadata })
      }
      const status = /^\/checkout-sessions\/([0-9a-f-]+)\/status\/$/.exec(path)
      if (req.method === 'GET' && status) {
        const s = fake.sessions.get(status[1]!)
        if (!s) return send(res, 404, { message: 'Session introuvable', code: 'not_found' })
        return send(res, 200, { id: s.id, slug: s.slug, status: s.status, transaction_id: s.transaction_id, transaction_status: s.transaction_status, transaction_reference: s.transaction_reference })
      }
      const one = /^\/checkout-sessions\/([0-9a-f-]+)\/$/.exec(path)
      if (req.method === 'GET' && one) {
        const s = fake.sessions.get(one[1]!)
        if (!s) return send(res, 404, { message: 'Session introuvable', code: 'not_found' })
        return send(res, 200, { id: s.id, slug: s.slug, checkout_url: s.checkout_url, amount: s.amount, currency: s.currency, status: s.status })
      }
      send(res, 404, { message: 'not found', code: 'not_found' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  return fake
}
