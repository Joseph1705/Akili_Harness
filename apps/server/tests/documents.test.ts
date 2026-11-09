import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { createTestApp, multipart, readyOrg, ORIGIN, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('document processing', () => {
  it('turns a report into a draft invoice and charges one credit', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const res = await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    expect(res.statusCode).toBe(200)
    expect(res.json().documents[0].status).toBe('queued')
    await drainJobs(t.app)
    const docs = (await o.call('GET', '/api/documents')).json().documents
    expect(docs[0]).toMatchObject({ status: 'done', report_number: 'RA-2026-10-014' })
    const invoice = (await o.call('GET', `/api/invoices/${docs[0].invoice_id}`)).json().invoice
    expect(invoice).toMatchObject({ status: 'draft', total_cents: 1480160, vat_cents: 204160, po_number: 'BC-0932' })
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(19)
  })

  it('detects the duplicate by content and by report number, without charging', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    await drainJobs(t.app)
    const copy = await o.upload('RA-2026-10-014_Tshala_Kipushi (copie).pdf')
    expect(copy.json().documents[0].status).toBe('duplicate')
    await drainJobs(t.app)
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(19)
    expect((await o.call('GET', '/api/invoices?status=draft')).json().invoices).toHaveLength(1)
  })

  it('waits for credits, then processes after a top-up', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 0)
    await o.upload('RA-2026-10-021_Kalembe_Forage.pdf')
    await drainJobs(t.app)
    expect((await o.call('GET', '/api/documents')).json().documents[0].status).toBe('waiting_credits')
    await o.call('POST', '/api/credits/topup', { credits: 5, ref: 'FICTIF-PAY-2' })
    await drainJobs(t.app)
    expect((await o.call('GET', '/api/documents')).json().documents[0].status).toBe('done')
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(4)
  })

  it('refuses files that are not reports by their bytes', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const body = multipart({ agentId: o.agent.id }, { field: 'file', filename: 'rapport.pdf', bytes: Buffer.from('MZ\x90\x00 programme') })
    const res = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: o.cookie, ...body.headers }, payload: body.payload })
    expect(res.statusCode).toBe(400)
  })

  it('marks a non-report document as failed without charging', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const body = multipart({ agentId: o.agent.id }, { field: 'file', filename: 'notes.csv', bytes: Buffer.from('a;b\nc;d\n') })
    await t.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: o.cookie, ...body.headers }, payload: body.payload })
    await drainJobs(t.app)
    const doc = (await o.call('GET', '/api/documents')).json().documents[0]
    expect(doc.status).toBe('failed')
    expect(doc.error).toMatch(/Rapport N°/)
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(20)
  })
})

describe('checks, validation and PDF', () => {
  async function draftFor(name: string) {
    const o = await readyOrg(t!)
    await o.upload(name)
    await drainJobs(t!.app)
    const doc = (await o.call('GET', '/api/documents')).json().documents[0]
    const invoice = (await o.call('GET', `/api/invoices/${doc.invoice_id}`)).json().invoice
    return { o, invoice }
  }

  it('ignores instructions hidden in a report and prices from the contract', async () => {
    t = await createTestApp()
    const { invoice } = await draftFor('RA-2026-10-032_Tshala_Observations.pdf')
    // 3 j × 640 + 24 h × 35 = 2 760,00 ; TVA 441,60 ; TTC 3 201,60 — not 1 000 000.
    expect(invoice.total_cents).toBe(320160)
    expect(invoice.checks.find((c: { id: string }) => c.id === 'instructions')).toMatchObject({ status: 'warning' })
    expect(invoice.status).toBe('draft')
  })

  it('flags lines outside the contract and quantities over the ceiling', async () => {
    t = await createTestApp()
    const { invoice } = await draftFor('RA-2026-10-031_Kalembe_Anomalies.pdf')
    expect(invoice.lines.map((l: { code: string }) => l.code)).toEqual(['CAM-30'])
    expect(invoice.checks.find((c: { id: string }) => c.id === 'rates')).toMatchObject({ status: 'warning' })
    expect(invoice.checks.find((c: { id: string }) => c.id === 'quantities')).toMatchObject({ status: 'warning' })
  })

  it('applies no VAT for an exempt client', async () => {
    t = await createTestApp()
    const { invoice } = await draftFor('RA-2026-10-030_Lualaba_Services.pdf')
    expect(invoice).toMatchObject({ vat_cents: 0, vat_rate_bp: 0, subtotal_cents: invoice.total_cents })
  })

  it('validates once even when the request is replayed', async () => {
    t = await createTestApp()
    const { o, invoice } = await draftFor('RA-2026-10-014_Tshala_Kipushi.pdf')
    const key = '6f1c2b8e-3a5d-4e7f-9a1b-2c3d4e5f6a7b'
    const first = await o.call('POST', `/api/invoices/${invoice.id}/validate`, {}, { 'idempotency-key': key })
    const again = await o.call('POST', `/api/invoices/${invoice.id}/validate`, {}, { 'idempotency-key': key })
    expect(first.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(first.json().invoice).toMatchObject({ status: 'validated', number: 'FAC-2026-0001' })
    const other = await o.call('POST', `/api/invoices/${invoice.id}/validate`, {}, { 'idempotency-key': '7f1c2b8e-3a5d-4e7f-9a1b-2c3d4e5f6a7b' })
    expect(other.statusCode).toBe(409)
  })

  it('records a correction and recomputes the totals', async () => {
    t = await createTestApp()
    const { o, invoice } = await draftFor('RA-2026-10-014_Tshala_Kipushi.pdf')
    const res = await o.call('POST', `/api/invoices/${invoice.id}/correct`, { lines: [{ code: 'GRU-25', qty: '11' }], note: 'Un jour d\'arrêt non facturable' })
    expect(res.statusCode).toBe(200)
    expect(res.json().invoice.subtotal_cents).toBe(1276000 - 64000)
    expect(res.json().invoice.corrections[0]).toMatchObject({ code: 'GRU-25', before: '12', after: '11' })
  })

  it('rejects with a reason, and a reader can neither validate nor reject', async () => {
    t = await createTestApp()
    const { o, invoice } = await draftFor('RA-2026-10-014_Tshala_Kipushi.pdf')
    await o.call('POST', '/api/orgs/current/members', { email: 'lecteur@example.cd', role: 'reader' })
    const { login, as } = await import('./helpers.js')
    const reader = as(t, await login(t, 'lecteur@example.cd'))
    expect((await reader('POST', `/api/invoices/${invoice.id}/validate`, {}, { 'idempotency-key': '8f1c2b8e-3a5d-4e7f-9a1b-2c3d4e5f6a7b' })).statusCode).toBe(403)
    expect((await o.call('POST', `/api/invoices/${invoice.id}/reject`, {})).statusCode).toBe(400)
    const res = await o.call('POST', `/api/invoices/${invoice.id}/reject`, { reason: 'Le bon de commande est clos.' })
    expect(res.json().invoice).toMatchObject({ status: 'rejected', reject_reason: 'Le bon de commande est clos.' })
  })

  it('produces a PDF marked as a non-fiscal document', async () => {
    t = await createTestApp()
    const { o, invoice } = await draftFor('RA-2026-10-014_Tshala_Kipushi.pdf')
    const res = await o.call('GET', `/api/invoices/${invoice.id}/pdf`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toMatch(/^attachment;/)
    const { extractText } = await import('../src/documents/extract.js')
    const text = await extractText(res.rawPayload, 'pdf')
    expect(text).toContain('Document non fiscal')
    expect(text).toContain('14 801,60')
  })
})
