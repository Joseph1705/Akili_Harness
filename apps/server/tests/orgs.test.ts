import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { as, createTestApp, login, multipart, onboardedOwner, ORIGIN, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('onboarding', () => {
  it('walks the company onboarding from account type to first steps', async () => {
    t = await createTestApp()
    const call = as(t, await login(t, 'mireille@example.cd'))
    const created = await call('POST', '/api/orgs', { kind: 'company', name: 'Kibala Services SARL (fictif)' })
    expect(created.statusCode).toBe(200)
    expect(created.json().org).toMatchObject({ plan: 'entreprise', role: 'owner' })

    expect((await call('PATCH', '/api/me/profile', { first_name: 'Mireille', last_name: 'Kabange', locale: 'fr' })).statusCode).toBe(200)
    expect((await call('PATCH', '/api/orgs/current', { sector: 'Sous-traitance minière', city: 'Lubumbashi', province: 'Haut-Katanga', currency: 'USD', onboarding_step: 4 })).statusCode).toBe(200)
    expect((await call('PATCH', '/api/orgs/current', { rccm: 'CD/LSH/RCCM/00-B-00000', nif: 'A0000000X', vat_status: 'yes', onboarding_step: 5 })).statusCode).toBe(200)

    const consents = await call('GET', '/api/orgs/current/consents')
    expect(consents.json()).toMatchObject({ terms: false, privacy: false, external_model: false })

    expect((await call('POST', '/api/orgs/current/onboarding/complete', {})).statusCode).toBe(400)
    await call('POST', '/api/orgs/current/consents', { type: 'terms', granted: true })
    await call('POST', '/api/orgs/current/consents', { type: 'privacy', granted: true })
    expect((await call('POST', '/api/orgs/current/onboarding/complete', {})).statusCode).toBe(200)

    const me = (await call('GET', '/api/auth/me')).json()
    expect(me.user).toMatchObject({ first_name: 'Mireille', last_name: 'Kabange' })
    expect(me.org).toMatchObject({ city: 'Lubumbashi', vat_status: 'yes', role: 'owner' })
    expect(me.org.onboarding_done_at).toBeTruthy()
  })

  it('gives an individual account the solo plan', async () => {
    t = await createTestApp()
    const call = as(t, await login(t, 'solo@example.cd'))
    const created = await call('POST', '/api/orgs', { kind: 'individual' })
    expect(created.json().org).toMatchObject({ plan: 'solo', kind: 'individual' })
  })

  it('requires a name for a company and validates fields', async () => {
    t = await createTestApp()
    const call = as(t, await login(t, 'a@example.cd'))
    expect((await call('POST', '/api/orgs', { kind: 'company' })).statusCode).toBe(400)
    await call('POST', '/api/orgs', { kind: 'company', name: 'X SARL' })
    expect((await call('PATCH', '/api/orgs/current', { vat_status: 'peut-être' })).statusCode).toBe(400)
    expect((await call('PATCH', '/api/orgs/current', { plan: 'entreprise', id: 'other' })).statusCode).toBe(400)
  })

  it('records the external model consent separately, off by default', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    expect((await call('GET', '/api/orgs/current/consents')).json().external_model).toBe(false)
    await call('POST', '/api/orgs/current/consents', { type: 'external_model', granted: true })
    expect((await call('GET', '/api/orgs/current/consents')).json().external_model).toBe(true)
    await call('POST', '/api/orgs/current/consents', { type: 'external_model', granted: false })
    expect((await call('GET', '/api/orgs/current/consents')).json().external_model).toBe(false)
  })
})

describe('organization logo', () => {
  it('refuses SVG and non-images', async () => {
    t = await createTestApp()
    const { cookie } = await onboardedOwner(t, 'a@example.cd')
    for (const [filename, bytes] of [['logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')], ['logo.png', Buffer.from('MZ\x90\x00not an image')]] as const) {
      const body = multipart({}, { field: 'file', filename, bytes })
      const res = await t.app.inject({ method: 'POST', url: '/api/orgs/current/logo', headers: { origin: ORIGIN, cookie, ...body.headers }, payload: body.payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('re-encodes the image and strips its metadata', async () => {
    t = await createTestApp()
    const { cookie, call } = await onboardedOwner(t, 'a@example.cd')
    const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#00603A' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-meta-FICTIF' } } }).toBuffer()
    expect(jpeg.includes(Buffer.from('secret-meta-FICTIF'))).toBe(true)
    const body = multipart({}, { field: 'file', filename: 'logo.jpg', bytes: jpeg })
    const res = await t.app.inject({ method: 'POST', url: '/api/orgs/current/logo', headers: { origin: ORIGIN, cookie, ...body.headers }, payload: body.payload })
    expect(res.statusCode).toBe(200)
    const logo = await call('GET', '/api/orgs/current/logo?size=64')
    expect(logo.statusCode).toBe(200)
    expect(logo.headers['content-type']).toBe('image/png')
    expect(logo.rawPayload.includes(Buffer.from('secret-meta-FICTIF'))).toBe(false)
    expect((await sharp(logo.rawPayload).metadata()).width).toBe(64)
  })
})

describe('roles and isolation', () => {
  it('lets an owner invite a reader who cannot change settings', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'owner@example.cd')
    expect((await call('POST', '/api/orgs/current/members', { email: 'lecteur@example.cd', role: 'reader' })).statusCode).toBe(200)
    const reader = as(t, await login(t, 'lecteur@example.cd'))
    expect((await reader('GET', '/api/auth/me')).json().org.role).toBe('reader')
    expect((await reader('PATCH', '/api/orgs/current', { city: 'Kolwezi' })).statusCode).toBe(403)
    expect((await reader('POST', '/api/orgs/current/members', { email: 'x@example.cd', role: 'admin' })).statusCode).toBe(403)
  })

  it('never lets a user enter an organization they do not belong to', async () => {
    t = await createTestApp()
    const a = await onboardedOwner(t, 'a@example.cd', 'A SARL')
    const b = await onboardedOwner(t, 'b@example.cd', 'B SARL')
    expect((await a.call('POST', '/api/orgs/switch', { orgId: b.orgId })).statusCode).toBe(404)
    expect((await a.call('GET', '/api/auth/me')).json().org.id).toBe(a.orgId)
  })

  it('keeps the audit log per organization', async () => {
    t = await createTestApp()
    const a = await onboardedOwner(t, 'a@example.cd', 'A SARL')
    await onboardedOwner(t, 'b@example.cd', 'B SARL')
    const entries = (await a.call('GET', '/api/audit')).json().entries as Array<{ action: string }>
    expect(entries.map(e => e.action)).toContain('org.created')
    expect(entries.length).toBe(entries.filter(() => true).length)
    const orgsSeen = new Set(t.db.prepare('SELECT DISTINCT org_id FROM audit_log WHERE org_id IS NOT NULL').all().map(r => (r as { org_id: string }).org_id))
    expect(orgsSeen.size).toBe(2)
    expect(entries.every(e => JSON.stringify(e).includes('B SARL') === false)).toBe(true)
  })
})
