import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, onboardedOwner, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('public config and demo reports', () => {
  it('tells the login page the brand, hosting and demo mode without a session', async () => {
    t = await createTestApp({ AKILI_BRAND_NAME: 'Akili' })
    const res = await t.app.inject({ method: 'GET', url: '/api/public/config' })
    expect(res.json()).toEqual({ brand: 'Akili', hostingLabel: 'Serveur local — démonstration', demoMode: true, version: expect.any(String) })
  })

  it('serves a fictitious report by exact name only, in demo mode only', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    const ok = await call('GET', '/api/demo/reports/RA-2026-10-014_Tshala_Kipushi.pdf')
    expect(ok.statusCode).toBe(200)
    expect(ok.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await call('GET', '/api/demo/reports/..%2F..%2Fapps%2Fserver%2Fpackage.json')).statusCode).toBe(404)
    expect((await call('GET', '/api/demo/reports/contracts.json')).statusCode).toBe(404)
  })
})
