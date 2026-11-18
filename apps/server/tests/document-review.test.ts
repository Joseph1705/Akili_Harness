import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { shutdownOcr } from '../src/documents/ocr.js'
import { drainJobs } from '../src/jobs.js'
import { grantCredits, readyOrg, createTestApp, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })
afterAll(shutdownOcr)

type Org = Awaited<ReturnType<typeof readyOrg>>

async function reviewed(o: Org, name: string) {
  const up = await o.uploadDoc(name)
  expect(up.statusCode, up.body).toBe(200)
  await drainJobs(t!.app)
  const id = up.json().documents[0].id as string
  const res = (await o.call('GET', `/api/documents/${id}`)).json()
  return { id, document: res.document, review: res.review }
}

const generate = (o: Org, id: string, body: unknown, key = randomUUID()) =>
  o.call('POST', `/api/documents/${id}/invoice`, body, { 'idempotency-key': key })

const balance = async (o: Org) => (await o.call('GET', '/api/credits')).json().balance as number

describe('a scanned delivery note becomes an invoice after review', () => {
  it('reads it by OCR, proposes the known client, and charges one credit only when the invoice is generated', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 5)
    const { id, document, review } = await reviewed(o, 'Scan_BL-2026-118_Tshala.pdf')
    expect(document).toMatchObject({ status: 'needs_review', ocr_used: true, kind: 'pdf' })
    expect(document.ocr_confidence).toBeGreaterThan(70)
    expect(await balance(o)).toBe(5) // reading costs nothing
    expect(review.matchedClient.name).toBe('Tshala Logistique SARL')
    expect(review.suggestion).toMatchObject({ reference: 'BL-2026-118', currency: 'USD', vat_rate_bp: 1600 })
    expect(review.suggestion.lines).toEqual([
      { description: 'Gravier concassé 0/31,5', quantity: '40', unit: null, unit_price: '22.00' },
      { description: 'Sable lavé', quantity: '25', unit: null, unit_price: '18.00' },
    ])
    expect(review.checks.find((c: { id: string }) => c.id === 'total_read')).toMatchObject({ status: 'ok' })

    const key = randomUUID()
    const res = await generate(o, id, review.suggestion, key)
    expect(res.statusCode, res.body).toBe(200)
    const invoice = res.json().invoice
    expect(invoice).toMatchObject({ status: 'draft', source: 'document', subtotal_cents: 133000, vat_cents: 21280, total_cents: 154280, reference: 'BL-2026-118' })
    expect(invoice.number).toMatch(/^P-\d{4}-\d{4}$/)
    expect(res.json().balance).toBe(4)

    // Retried (network cut): same invoice, no second charge — with the same key or a new one.
    expect((await generate(o, id, review.suggestion, key)).json().invoice.id).toBe(invoice.id)
    expect((await generate(o, id, review.suggestion)).json().invoice.id).toBe(invoice.id)
    expect(await balance(o)).toBe(4)
    const credits = (await o.call('GET', '/api/credits')).json()
    expect(credits.entries.filter((e: { type: string }) => e.type === 'consumption')).toHaveLength(1)
    expect(credits.entries[0]).toMatchObject({ type: 'consumption', amount: -1, invoice_number: invoice.number })
    expect((await o.call('GET', `/api/documents/${id}`)).json().document.status).toBe('done')

    // The validated invoice gets its official number.
    const validated = await o.call('POST', `/api/invoices/${invoice.id}/validate`, {}, { 'idempotency-key': randomUUID() })
    expect(validated.json().invoice.number).toMatch(/^FAC-/)
  })

  it('creates the client when the document names a new one (photo of a quote)', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const { id, review } = await reviewed(o, 'Photo_Devis_D-2026-031.jpg')
    expect(review.matchedClient).toBeNull()
    expect(review.suggestion.client).toMatchObject({ name: 'Bakwanga Mining SARL', nif: 'B1122334C' })
    const res = await generate(o, id, review.suggestion)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().invoice).toMatchObject({ total_cents: 220400, client: { name: 'Bakwanga Mining SARL' } })
    const clients = (await o.call('GET', '/api/clients')).json().clients.map((c: { name: string }) => c.name)
    expect(clients).toContain('Bakwanga Mining SARL')
  })

  it('reads Word and text documents; a client without VAT is invoiced without VAT', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const word = await reviewed(o, 'Commande_Lualaba_BC-LM-0471.docx')
    expect(word.review.matchedClient.name).toBe('Lualaba Minerals SARL')
    expect(word.review.suggestion).toMatchObject({ vat_rate_bp: 0, po_number: 'BC-LM-0471' })
    expect((await generate(o, word.id, word.review.suggestion)).json().invoice).toMatchObject({ total_cents: 326000, vat_cents: 0 })

    const text = await reviewed(o, 'Demande_facturation_Kalembe.txt')
    expect(text.review.matchedClient.name).toBe('Kalembe Mining SA')
    expect(text.review.suggestion.lines).toHaveLength(2)
  })

  it('flags instructions hidden in a document and keeps them out of the invoice', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const { review } = await reviewed(o, 'Facture_piegee_Mwanga.pdf')
    expect(review.extracted.suspicious_instructions).toBe(true)
    expect(review.checks.map((c: { id: string }) => c.id)).toContain('instructions')
    expect(JSON.stringify(review.suggestion)).not.toMatch(/50 000|agent ia/i)
  })
})

describe('failures and missing credits never cost a credit', () => {
  it('marks an unreadable photo as failed', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 3)
    const { document } = await reviewed(o, 'Photo_floue.png')
    expect(document.status).toBe('failed')
    expect(document.error).toMatch(/n'a pas pu être lu.*Aucun crédit/)
    expect(await balance(o)).toBe(3)
  })

  it('refuses to generate without credit, keeps the document, and resumes after a purchase', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 1)
    const a = await reviewed(o, 'Demande_facturation_Kalembe.txt')
    const b = await reviewed(o, 'Commande_Lualaba_BC-LM-0471.docx')
    const [ra, rb] = await Promise.all([generate(o, a.id, a.review.suggestion), generate(o, b.id, b.review.suggestion)])
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 402])
    const refused = ra.statusCode === 402 ? ra : rb
    expect(refused.json()).toMatchObject({ error: 'insufficient_credits', balance: 0 })
    expect(await balance(o)).toBe(0)
    expect((await o.call('GET', '/api/invoices')).json().invoices).toHaveLength(1)
    const waitingId = refused === ra ? a.id : b.id
    expect((await o.call('GET', `/api/documents/${waitingId}`)).json().document.status).toBe('needs_review')

    // No credit left: a new upload is accepted but not processed until credits arrive.
    const up = await o.uploadDoc('Photo_Devis_D-2026-031.jpg')
    expect(up.json().credits).toEqual({ balance: 0, waiting: true })
    await drainJobs(t.app)
    const newId = up.json().documents[0].id
    expect((await o.call('GET', `/api/documents/${newId}`)).json().document.status).toBe('waiting_credits')
    await grantCredits(t, o.orgId, 2)
    await drainJobs(t.app)
    expect((await o.call('GET', `/api/documents/${newId}`)).json().document.status).toBe('needs_review')
    expect(await balance(o)).toBe(2)
  })

  it('lets a person dismiss a document without any charge', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 2)
    const { id, review } = await reviewed(o, 'Demande_facturation_Kalembe.txt')
    expect((await o.call('POST', `/api/documents/${id}/dismiss`, { reason: 'Déjà facturé à la main' })).statusCode).toBe(200)
    expect((await generate(o, id, review.suggestion)).statusCode).toBe(409)
    expect(await balance(o)).toBe(2)
  })

  it('validates the reviewed fields on the server', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 2)
    const { id, review } = await reviewed(o, 'Demande_facturation_Kalembe.txt')
    const bad = { ...review.suggestion, lines: [{ description: 'X', quantity: '-1', unit_price: '10' }] }
    expect((await generate(o, id, bad)).statusCode).toBe(400)
    const zero = { ...review.suggestion, lines: [{ description: 'X', quantity: '0', unit_price: '10' }] }
    expect((await generate(o, id, zero)).statusCode).toBe(400)
    const backwards = { ...review.suggestion, due_date: '2020-01-01' }
    expect((await generate(o, id, backwards)).statusCode).toBe(400)
    expect(await balance(o)).toBe(2)
  })
})
