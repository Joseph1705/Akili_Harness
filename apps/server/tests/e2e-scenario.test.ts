/**
 * The acceptance scenario of DIRECTIVES §9, end to end through the HTTP API:
 * a company buys 100 credits through SasPay; the payment is verified; it receives 100 credits;
 * it uploads a scanned document; the system extracts its information and generates an invoice;
 * exactly one credit is deducted (99 left); the transaction appears in its history;
 * if invoice generation fails, the company keeps its balance.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { signWebhook } from '../src/billing/saspay.js'
import { shutdownOcr } from '../src/documents/ocr.js'
import { drainJobs } from '../src/jobs.js'
import { as, createTestApp, importFixtureClients, login, onboardedOwner, multipart, ORIGIN, documentsDir, type TestContext } from './helpers.js'
import { startFakeSasPay, type FakeSasPay } from './fakes/saspay.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let t: TestContext | undefined
let sas: FakeSasPay | undefined
afterEach(async () => { await t?.close(); await sas?.close(); t = undefined; sas = undefined })
afterAll(shutdownOcr)

const SECRET = 'whsec_scenario'

describe('acceptance scenario: 100 credits bought with SasPay, one scanned document, 99 left', () => {
  it('runs the whole journey, and a failed generation keeps the balance', async () => {
    sas = await startFakeSasPay()
    t = await createTestApp({ AKILI_PLATFORM_ADMINS: 'ops@akili.example', SASPAY_API_KEY: sas.apiKey, SASPAY_BASE_URL: sas.url, SASPAY_WEBHOOK_SECRET: SECRET })

    // Our team prices the 100-credit package (no code change: administration screen).
    const ops = as(t, await login(t, 'ops@akili.example'))
    const pack = (await ops('GET', '/api/platform/packages')).json().packages.find((p: { credits: number }) => p.credits === 100)
    await ops('PUT', `/api/platform/packages/${pack.id}`, { name: 'Essentiel', credits: 100, price_cents: 2500, currency: 'USD', description: null, active: true, promotional: false, sort_order: 1 })

    // The company signs up and buys 100 credits.
    const company = await onboardedOwner(t, 'gerant@kibala.example')
    await importFixtureClients(company.call)
    const call = company.call
    const purchase = (await call('POST', '/api/billing/purchases', { packageId: pack.id }, { 'idempotency-key': randomUUID() })).json().purchase
    expect(purchase.status).toBe('pending')
    expect((await call('GET', '/api/credits')).json().balance).toBe(0)

    // It pays on SasPay; SasPay notifies us; our server verifies with SasPay before crediting.
    sas.pay([...sas.sessions.keys()][0]!)
    const raw = JSON.stringify({ event: 'transaction.success', data: { status: 'SUCCESS' } })
    const ts = Math.floor(Date.now() / 1000)
    const hook = await t.app.inject({ method: 'POST', url: '/api/webhooks/saspay', payload: raw, headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signWebhook(raw, SECRET, ts) } })
    expect(hook.statusCode).toBe(200)
    expect((await call('GET', '/api/credits')).json().balance).toBe(100)

    // It uploads a scanned document.
    const agent = (await call('POST', '/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })).json().agent
    const body = multipart({ agentId: agent.id }, { field: 'file', filename: 'Scan_BL-2026-118_Tshala.pdf', bytes: readFileSync(join(documentsDir, 'Scan_BL-2026-118_Tshala.pdf')) })
    const up = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: company.cookie, ...body.headers }, payload: body.payload })
    const documentId = up.json().documents[0].id
    await drainJobs(t.app)
    const { document, review } = (await call('GET', `/api/documents/${documentId}`)).json()
    expect(document).toMatchObject({ status: 'needs_review', ocr_used: true })
    expect((await call('GET', '/api/credits')).json().balance).toBe(100)

    // First attempt fails in the middle of the generation (the database refuses the invoice): balance kept.
    await t.db.run(`CREATE FUNCTION scenario_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'disk full'; END $f$`)
    await t.db.run('CREATE TRIGGER scenario_fail BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION scenario_fail()')
    const failed = await call('POST', `/api/documents/${documentId}/invoice`, review.suggestion, { 'idempotency-key': randomUUID() })
    expect(failed.statusCode).toBe(500)
    expect((await call('GET', '/api/credits')).json().balance).toBe(100)
    expect((await call('GET', `/api/documents/${documentId}`)).json().document.status).toBe('needs_review')
    await t.db.run('DROP TRIGGER scenario_fail ON invoices')

    // The person retries: the invoice is generated and exactly one credit is deducted.
    const generated = await call('POST', `/api/documents/${documentId}/invoice`, review.suggestion, { 'idempotency-key': randomUUID() })
    expect(generated.statusCode, generated.body).toBe(200)
    const invoice = generated.json().invoice
    expect(invoice).toMatchObject({ source: 'document', total_cents: 154280, client: { name: 'Tshala Logistique SARL' } })

    const credits = (await call('GET', '/api/credits')).json()
    expect(credits.balance).toBe(99)
    expect(credits.wallet).toMatchObject({ total_purchased: 100, total_consumed: 1 })
    expect(credits.entries.map((e: { type: string; amount: number }) => [e.type, e.amount])).toEqual([['consumption', -1], ['purchase', 100]])
    expect(credits.entries[0]).toMatchObject({ balance_before: 100, balance_after: 99, invoice_number: invoice.number })
    expect(credits.entries[1].payment_reference).toMatch(/^TXN-/)
  })
})
