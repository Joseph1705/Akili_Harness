import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { signWebhook } from '../src/billing/saspay.js'
import { reconcilePayments } from '../src/billing/payments.js'
import { as, createTestApp, login, onboardedOwner, ORIGIN, type TestContext } from './helpers.js'
import { startFakeSasPay, type FakeSasPay } from './fakes/saspay.js'

let t: TestContext | undefined
let sas: FakeSasPay | undefined
afterEach(async () => { await t?.close(); await sas?.close(); t = undefined; sas = undefined })

const SECRET = 'whsec_test_signing_secret'
const OPS = 'ops@akili.example'

async function setup(options: { webhookSecret?: boolean } = {}) {
  sas = await startFakeSasPay()
  t = await createTestApp({
    AKILI_PLATFORM_ADMINS: OPS, SASPAY_API_KEY: sas.apiKey, SASPAY_BASE_URL: sas.url,
    ...(options.webhookSecret === false ? {} : { SASPAY_WEBHOOK_SECRET: SECRET }),
  })
  const ops = as(t, await login(t, OPS))
  const packs = (await ops('GET', '/api/platform/packages')).json().packages
  const hundred = packs.find((p: { credits: number }) => p.credits === 100)
  expect(hundred).toMatchObject({ active: false, price_cents: null })
  const updated = await ops('PUT', `/api/platform/packages/${hundred.id}`, { name: 'Essentiel', credits: 100, price_cents: 2500, currency: 'USD', description: '100 documents', active: true, promotional: false, sort_order: 1 })
  expect(updated.statusCode, updated.body).toBe(200)
  const owner = await onboardedOwner(t, 'owner@example.cd')
  return { ops, owner, packageId: hundred.id as string }
}

async function buy(call: ReturnType<typeof as>, packageId: string, key = randomUUID()) {
  return call('POST', '/api/billing/purchases', { packageId }, { 'idempotency-key': key })
}

async function webhook(body: object, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify(body)
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000)
  return t!.app.inject({
    method: 'POST', url: '/api/webhooks/saspay', payload: raw,
    headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signWebhook(raw, opts.secret ?? SECRET, ts), 'x-webhook-event': (body as { event: string }).event },
  })
}

const balance = async (call: ReturnType<typeof as>) => (await call('GET', '/api/credits')).json().balance as number

describe('credit packages', () => {
  it('lists only active packages to organizations and refuses activation without a price', async () => {
    const { ops, owner } = await setup()
    const packs = (await owner.call('GET', '/api/billing/packages')).json().packages
    expect(packs.map((p: { credits: number }) => p.credits)).toEqual([100])
    const all = (await ops('GET', '/api/platform/packages')).json().packages
    const fiveHundred = all.find((p: { credits: number }) => p.credits === 500)
    const refused = await ops('PUT', `/api/platform/packages/${fiveHundred.id}`, { name: 'Pro', credits: 500, price_cents: null, currency: 'USD', active: true })
    expect(refused.statusCode).toBe(400)
    expect((await owner.call('GET', '/api/platform/packages')).statusCode).toBe(404)
  })
})

describe('buying credits with SasPay', () => {
  it('credits 100 only after SasPay confirms the payment, once, whatever is replayed', async () => {
    const { owner, packageId } = await setup()
    const key = randomUUID()
    const res = await buy(owner.call, packageId, key)
    expect(res.statusCode, res.body).toBe(200)
    const purchase = res.json().purchase
    expect(purchase).toMatchObject({ status: 'pending', credits: 100, amount_cents: 2500, currency: 'USD' })
    expect(purchase.checkout_url).toMatch(/^https:\/\/pay\.saspay\.example\/checkout\//)
    // The amount sent to SasPay comes from the package, as a decimal string.
    const created = sas!.requests.find(r => r.method === 'POST')!
    expect(created.body).toMatchObject({ amount: '25.00', currency: 'USD', customer_email: 'owner@example.cd' })
    expect((created.body as { return_url: string }).return_url).toBe(`${ORIGIN}/credits?paiement=${purchase.id}`)

    // Same Idempotency-Key: same purchase, no second session.
    expect((await buy(owner.call, packageId, key)).json().purchase.id).toBe(purchase.id)
    expect(sas!.sessions.size).toBe(1)

    // Coming back from the payment page before paying: nothing is credited.
    expect((await owner.call('POST', `/api/billing/purchases/${purchase.id}/verify`)).json().purchase.status).toBe('pending')
    expect(await balance(owner.call)).toBe(0)

    // Paid on SasPay; the webhook arrives five times (SasPay retries).
    sas!.pay([...sas!.sessions.keys()][0]!)
    for (let i = 0; i < 5; i++) expect((await webhook({ event: 'transaction.success', data: { status: 'SUCCESS' } })).statusCode).toBe(200)
    await owner.call('POST', `/api/billing/purchases/${purchase.id}/verify`)
    await reconcilePayments(t!.app)
    expect(await balance(owner.call)).toBe(100)
    const credits = (await owner.call('GET', '/api/credits')).json()
    expect(credits.entries.filter((e: { type: string }) => e.type === 'purchase')).toHaveLength(1)
    expect(credits.entries[0]).toMatchObject({ type: 'purchase', amount: 100, balance_before: 0, balance_after: 100 })
    expect(credits.entries[0].payment_reference).toMatch(/^TXN-/)
    expect(credits.wallet.total_purchased).toBe(100)
    expect((await owner.call('GET', '/api/billing/purchases')).json().purchases[0]).toMatchObject({ status: 'succeeded' })
  })

  it('accepts the wrapped {success, data} response form too', async () => {
    const { owner, packageId } = await setup()
    sas!.wrapped = true
    const purchase = (await buy(owner.call, packageId)).json().purchase
    sas!.pay([...sas!.sessions.keys()][0]!)
    expect((await owner.call('POST', `/api/billing/purchases/${purchase.id}/verify`)).json().purchase.status).toBe('succeeded')
    expect(await balance(owner.call)).toBe(100)
  })

  it('rejects webhooks with a bad signature or an old timestamp, and they credit nothing', async () => {
    const { owner, packageId } = await setup()
    await buy(owner.call, packageId)
    sas!.pay([...sas!.sessions.keys()][0]!)
    expect((await webhook({ event: 'transaction.success', data: {} }, { secret: 'wrong' })).statusCode).toBe(403)
    expect((await webhook({ event: 'transaction.success', data: {} }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(403)
    const unsigned = await t!.app.inject({ method: 'POST', url: '/api/webhooks/saspay', payload: '{"event":"transaction.success"}', headers: { 'content-type': 'application/json' } })
    expect(unsigned.statusCode).toBe(403)
    expect(await balance(owner.call)).toBe(0)
  })

  it('credits nothing when SasPay reports a different amount', async () => {
    const { owner, packageId } = await setup()
    const purchase = (await buy(owner.call, packageId)).json().purchase
    sas!.pay([...sas!.sessions.keys()][0]!, { amount: '1.00' })
    const after = (await owner.call('POST', `/api/billing/purchases/${purchase.id}/verify`)).json().purchase
    expect(after.status).toBe('failed')
    expect(await balance(owner.call)).toBe(0)
  })

  it('never simulates a payment when SasPay is not configured, and reports provider errors', async () => {
    t = await createTestApp({ AKILI_PLATFORM_ADMINS: OPS })
    const owner = await onboardedOwner(t, 'owner@example.cd')
    expect((await owner.call('GET', '/api/billing/status')).json().online).toBe(false)
    const res = await owner.call('POST', '/api/billing/purchases', { packageId: randomUUID() }, { 'idempotency-key': randomUUID() })
    expect(res.statusCode).toBe(503)

    await t.close()
    const s = await setup()
    sas!.failCreate = true
    const failed = await buy(s.owner.call, s.packageId)
    expect(failed.statusCode).toBe(502)
    expect((await s.owner.call('GET', '/api/billing/purchases')).json().purchases[0]).toMatchObject({ status: 'failed' })
  })

  it('keeps payments private to their organization and to billing roles', async () => {
    const { owner, packageId } = await setup()
    const purchase = (await buy(owner.call, packageId)).json().purchase
    const other = await onboardedOwner(t!, 'other@example.cd', 'Autre SARL (fictif)')
    expect((await other.call('POST', `/api/billing/purchases/${purchase.id}/verify`)).statusCode).toBe(404)
    expect((await other.call('GET', '/api/billing/purchases')).json().purchases).toHaveLength(0)
    await owner.call('POST', '/api/orgs/current/members', { email: 'op@example.cd', role: 'operator' })
    const op = as(t!, await login(t!, 'op@example.cd'))
    expect((await op('POST', '/api/billing/purchases', { packageId }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403)
  })
})

describe('platform finance tools', () => {
  it('allocates, refunds and corrects with an audit trail, never below zero', async () => {
    const { ops, owner } = await setup()
    expect((await ops('POST', `/api/platform/orgs/${owner.orgId}/credits`, { credits: 20, ref: 'Lancement', promotional: true })).statusCode).toBe(200)
    expect((await ops('POST', `/api/platform/orgs/${owner.orgId}/refunds`, { credits: 2, reason: 'Extraction erronée' })).statusCode).toBe(200)
    expect((await ops('POST', `/api/platform/orgs/${owner.orgId}/corrections`, { amount: -5, reason: 'Double saisie' })).statusCode).toBe(200)
    expect((await ops('POST', `/api/platform/orgs/${owner.orgId}/corrections`, { amount: -500, reason: 'Trop' })).statusCode).toBe(402)
    expect(await balance(owner.call)).toBe(17)
    const tx = (await ops('GET', `/api/platform/transactions?org=${owner.orgId}`)).json().transactions
    expect(tx.map((x: { type: string }) => x.type)).toEqual(['admin_correction', 'refund', 'admin_allocation'])
    expect(tx[0].actor_email).toBe(OPS)
    const auditLog = (await owner.call('GET', '/api/audit')).json().entries.map((e: { action: string }) => e.action)
    expect(auditLog).toEqual(expect.arrayContaining(['credits.topup', 'credits.refunded', 'credits.corrected']))
    // Organizations have no access to any of it.
    expect((await owner.call('POST', `/api/platform/orgs/${owner.orgId}/corrections`, { amount: 100, reason: 'Moi-même' })).statusCode).toBe(404)
  })
})
