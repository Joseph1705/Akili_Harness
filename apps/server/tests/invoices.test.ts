import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { as, createTestApp, login, readyOrg, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

type Org = Awaited<ReturnType<typeof readyOrg>>
const key = () => ({ 'idempotency-key': randomUUID() })
const today = new Date().toISOString().slice(0, 10)
const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)

const manual = (overrides: Record<string, unknown> = {}) => ({
  client: { name: 'Nyota Négoce SARL', nif: 'D4455667E', email: 'compta@nyota.example', vat_applicable: true },
  reference: 'DEV-77', issue_date: today, due_date: inDays(30), currency: 'USD',
  lines: [
    { description: 'Audit de stock', quantity: '2', unit: 'jour', unit_price: '350.00' },
    { description: 'Rapport écrit', quantity: '1', unit_price: '125,50' },
  ],
  vat_rate_bp: 1600, discount: { type: 'percent', value: '10' }, notes: 'Merci pour votre confiance.',
  ...overrides,
})

async function validatedManual(o: Org, overrides: Record<string, unknown> = {}) {
  const created = await o.call('POST', '/api/invoices', manual(overrides), key())
  expect(created.statusCode, created.body).toBe(200)
  const v = await o.call('POST', `/api/invoices/${created.json().invoice.id}/validate`, {}, key())
  expect(v.statusCode, v.body).toBe(200)
  return v.json().invoice
}

describe('manual invoices', () => {
  it('computes lines, discount and VAT in integers, and costs no credit', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 4)
    const res = await o.call('POST', '/api/invoices', manual(), key())
    expect(res.statusCode, res.body).toBe(200)
    // 2 × 350,00 + 125,50 = 825,50 ; −10 % = 82,55 ; base 742,95 ; TVA 16 % = 118,87 (118,872) ; total 861,82
    expect(res.json().invoice).toMatchObject({
      source: 'manual', status: 'draft', subtotal_cents: 82550, discount_cents: 8255, vat_cents: 11887, total_cents: 86182,
      client: { name: 'Nyota Négoce SARL' }, reference: 'DEV-77', notes: 'Merci pour votre confiance.',
    })
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(4)
  })

  it('edits a draft, recomputes it, and keeps the change in its history', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const inv = (await o.call('POST', '/api/invoices', manual(), key())).json().invoice
    const edited = await o.call('PUT', `/api/invoices/${inv.id}`, manual({ client: { id: inv.client.id }, discount: null, lines: [{ description: 'Audit de stock', quantity: '3', unit_price: '350' }] }))
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().invoice).toMatchObject({ subtotal_cents: 105000, discount_cents: 0, vat_cents: 16800, total_cents: 121800 })
    expect(edited.json().invoice.corrections).toHaveLength(1)
  })

  it('blocks validation when VAT is charged by a company that is not VAT-registered', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    await o.call('PATCH', '/api/orgs/current', { vat_status: 'no' })
    const inv = (await o.call('POST', '/api/invoices', manual(), key())).json().invoice
    expect(inv.checks.find((c: { id: string }) => c.id === 'vat').status).toBe('error')
    expect((await o.call('POST', `/api/invoices/${inv.id}/validate`, {}, key())).statusCode).toBe(409)
  })

  it('searches and filters the history', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    await validatedManual(o)
    await o.call('POST', '/api/invoices', manual({ client: { name: 'Autre Client SA', vat_applicable: false }, vat_rate_bp: 0, reference: 'ZZ-1' }), key())
    expect((await o.call('GET', '/api/invoices?q=nyota')).json().invoices).toHaveLength(1)
    expect((await o.call('GET', '/api/invoices?q=ZZ-1')).json().invoices).toHaveLength(1)
    expect((await o.call('GET', '/api/invoices?status=validated&payment=unpaid')).json().invoices).toHaveLength(1)
    expect((await o.call('GET', '/api/invoices?source=manual')).json().invoices).toHaveLength(2)
    expect((await o.call('GET', '/api/invoices?q=%25')).json().invoices).toHaveLength(0) // "%" is a character, not a wildcard
  })
})

describe('customer payments', () => {
  it('records partial then full payment, refuses overpayment, and reverses a mistake', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const inv = await validatedManual(o)
    const pay = (amount: string) => o.call('POST', `/api/invoices/${inv.id}/payments`, { amount, paid_on: today, method: 'mobile_money', note: 'M-Pesa' }, key())
    expect((await pay('500')).json().invoice).toMatchObject({ payment_status: 'partial', amount_paid_cents: 50000, balance_due_cents: 36182 })
    expect((await pay('400')).statusCode).toBe(400)
    const paid = (await pay('361,82')).json().invoice
    expect(paid).toMatchObject({ payment_status: 'paid', balance_due_cents: 0 })
    expect(paid.paid_at).toBeTruthy()
    const payments = (await o.call('GET', `/api/invoices/${inv.id}/payments`)).json().payments
    const reversed = await o.call('POST', `/api/invoices/${inv.id}/payments/${payments[1].id}/reverse`, { reason: 'Saisi deux fois' })
    expect(reversed.json().invoice).toMatchObject({ payment_status: 'partial', amount_paid_cents: 50000 })
    expect((await o.call('POST', `/api/invoices/${inv.id}/payments/${payments[1].id}/reverse`, { reason: 'Encore' })).statusCode).toBe(409)
    expect(await t.db.run('DELETE FROM invoice_payments').catch(e => String(e))).toMatch(/append-only/)
  })

  it('accepts payments on validated invoices only', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const draft = (await o.call('POST', '/api/invoices', manual(), key())).json().invoice
    expect((await o.call('POST', `/api/invoices/${draft.id}/payments`, { amount: '10', paid_on: today, method: 'especes' }, key())).statusCode).toBe(400)
  })
})

describe('sharing and sending', () => {
  it('shares a validated invoice by an expiring, revocable link that needs no account', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const draft = (await o.call('POST', '/api/invoices', manual(), key())).json().invoice
    expect((await o.call('POST', `/api/invoices/${draft.id}/shares`, { days: 7 })).statusCode).toBe(400)
    const inv = await validatedManual(o)
    const share = (await o.call('POST', `/api/invoices/${inv.id}/shares`, { days: 7 })).json().share
    const path = new URL(share.url).pathname
    const open = await t.app.inject({ method: 'GET', url: path })
    expect(open.statusCode).toBe(200)
    expect(open.headers['content-type']).toBe('application/pdf')
    expect(open.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await o.call('GET', `/api/invoices/${inv.id}/shares`)).json().shares[0].views).toBe(1)
    await o.call('DELETE', `/api/invoices/${inv.id}/shares/${share.id}`)
    expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(404)
    expect((await t.app.inject({ method: 'GET', url: '/api/public/invoices/' + 'A'.repeat(43) + '/pdf' })).statusCode).toBe(404)
  })

  it('e-mails a validated invoice with its PDF, and refuses when no mail service exists', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const inv = await validatedManual(o)
    const sent = await o.call('POST', `/api/invoices/${inv.id}/send`, { message: 'Bonjour,' }, key())
    expect(sent.statusCode, sent.body).toBe(200)
    expect(t.mailer.sent).toHaveLength(1)
    expect(t.mailer.sent[0]).toMatchObject({ to: 'compta@nyota.example' })
    expect(t.mailer.sent[0]!.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-')
    delete (t.mailer as { sendMail?: unknown }).sendMail
    expect((await o.call('POST', `/api/invoices/${inv.id}/send`, {}, key())).statusCode).toBe(503)
  })

  it('keeps every invoice action inside its organization and its roles', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const inv = await validatedManual(o)
    const other = await readyOrg(t, 'other@example.cd')
    for (const [method, url, body] of [
      ['GET', `/api/invoices/${inv.id}`, undefined], ['GET', `/api/invoices/${inv.id}/payments`, undefined],
      ['POST', `/api/invoices/${inv.id}/shares`, { days: 1 }], ['POST', `/api/invoices/${inv.id}/send`, {}],
      ['PUT', `/api/invoices/${inv.id}`, manual()],
    ] as const) {
      expect((await other.call(method, url, body, key())).statusCode, url).toBe(404)
    }
    await o.call('POST', '/api/orgs/current/members', { email: 'lecteur@example.cd', role: 'reader' })
    const reader = as(t, await login(t, 'lecteur@example.cd'))
    expect((await reader('GET', `/api/invoices/${inv.id}`)).statusCode).toBe(200)
    expect((await reader('POST', `/api/invoices/${inv.id}/payments`, { amount: '1', paid_on: today, method: 'especes' }, key())).statusCode).toBe(403)
    expect((await reader('POST', '/api/invoices', manual(), key())).statusCode).toBe(403)
  })
})
