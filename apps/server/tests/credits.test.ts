import { afterEach, describe, expect, it } from 'vitest'
import { balance, consume, topup } from '../src/credits.js'
import { as, createTestApp, login, onboardedOwner, type TestContext } from './helpers.js'
import { createOrg } from './fixtures.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('credits: 1 credit = 1 document', () => {
  it('tops up and consumes one credit per document, once', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await topup(t.db, org, 2, 'PAY-1', null)
    const doc = (n: number) => `00000000-0000-0000-0000-00000000000${n}`
    expect(await consume(t.db, org, doc(1))).toBe(true)
    expect(await consume(t.db, org, doc(1))).toBe(true) // same document: not charged twice
    expect(await balance(t.db, org)).toBe(1)
    expect(await consume(t.db, org, doc(2))).toBe(true)
    expect(await consume(t.db, org, doc(3))).toBe(false)
    expect(await balance(t.db, org)).toBe(0)
  })

  it('gives the last credit to only one of many simultaneous documents', async () => {
    t = await createTestApp()
    const org = await createOrg(t.db)
    await topup(t.db, org, 1, 'PAY-1', null)
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(n => consume(t!.db, org, `00000000-0000-0000-0000-00000000001${n}`)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await balance(t.db, org)).toBe(0)
  })

  it('keeps balances per organization', async () => {
    t = await createTestApp()
    const a = await createOrg(t.db, 'A')
    const b = await createOrg(t.db, 'B')
    await topup(t.db, a, 5, 'PAY-A', null)
    expect(await balance(t.db, b)).toBe(0)
    expect(await consume(t.db, b, '00000000-0000-0000-0000-000000000099')).toBe(false)
  })

  it('does not let an organization credit itself', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'owner@example.cd')
    expect((await call('POST', '/api/credits/topup', { credits: 100, ref: 'FREE-MONEY' })).statusCode).toBe(404)
    expect((await call('GET', '/api/credits')).json().balance).toBe(0)
  })
})

describe('platform administration', () => {
  it('lets a platform admin credit an organization after payment; nobody else sees the area', async () => {
    t = await createTestApp({ AKILI_PLATFORM_ADMINS: 'ops@akili.example' })
    const owner = await onboardedOwner(t, 'owner@example.cd')
    expect((await owner.call('GET', '/api/platform/orgs')).statusCode).toBe(404)
    expect((await owner.call('POST', `/api/platform/orgs/${owner.orgId}/credits`, { credits: 100, ref: 'X-123' })).statusCode).toBe(404)

    const ops = as(t, await login(t, 'ops@akili.example'))
    expect((await ops('GET', '/api/auth/me')).json().platformAdmin).toBe(true)
    const orgs = (await ops('GET', '/api/platform/orgs')).json().orgs
    expect(orgs).toHaveLength(1)
    expect(orgs[0]).toMatchObject({ id: owner.orgId, owner_email: 'owner@example.cd', balance: 0 })
    expect((await ops('POST', `/api/platform/orgs/${owner.orgId}/credits`, { credits: 100, ref: 'MPESA-0001' })).statusCode).toBe(200)
    expect((await owner.call('GET', '/api/credits')).json().balance).toBe(100)
  })
})
