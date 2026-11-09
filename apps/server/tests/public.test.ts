import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('public config', () => {
  it('tells the login page the brand and hosting, without a session', async () => {
    t = await createTestApp({ AKILI_BRAND_NAME: 'Akili', AKILI_HOSTING_LABEL: 'Hébergé en France' })
    const res = await t.app.inject({ method: 'GET', url: '/api/public/config' })
    expect(res.json()).toEqual({ brand: 'Akili', hostingLabel: 'Hébergé en France', version: expect.any(String) })
  })

  it('reports health only when the database answers', async () => {
    t = await createTestApp()
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true })
  })
})
