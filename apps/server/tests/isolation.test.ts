import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { createTestApp, readyOrg, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('organization isolation (directive 4.3)', () => {
  it('never shows organization B data to organization A', async () => {
    t = await createTestApp()
    const a = await readyOrg(t, 'a@example.cd')
    const b = await readyOrg(t, 'b@example.cd')
    await b.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    await drainJobs(t.app)
    const bDoc = (await b.call('GET', '/api/documents')).json().documents[0]
    for (const url of [
      `/api/documents/${bDoc.id}`, `/api/documents/${bDoc.id}/file`, `/api/invoices/${bDoc.invoice_id}`,
      `/api/invoices/${bDoc.invoice_id}/pdf`, `/api/agents/${b.agent.id}`,
    ]) {
      expect((await a.call('GET', url)).statusCode, url).toBe(404)
    }
    expect((await a.call('POST', `/api/invoices/${bDoc.invoice_id}/validate`, {}, { 'idempotency-key': '9f1c2b8e-3a5d-4e7f-9a1b-2c3d4e5f6a7b' })).statusCode).toBe(404)
    expect((await a.call('GET', '/api/documents')).json().documents).toHaveLength(0)
    expect((await a.call('GET', '/api/invoices')).json().invoices).toHaveLength(0)
    // Uploading with B's agent id from A is refused.
    const { multipart, ORIGIN } = await import('./helpers.js')
    const body = multipart({ agentId: b.agent.id }, { field: 'file', filename: 'x.csv', bytes: Buffer.from('a;b\nc;d\n') })
    const res = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: a.cookie, ...body.headers }, payload: body.payload })
    expect(res.statusCode).toBe(404)
  })
})
