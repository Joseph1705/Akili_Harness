import { afterEach, describe, expect, it } from 'vitest'
import { balance, consume, topup } from '../src/credits.js'
import { as, createTestApp, login, onboardedOwner, type TestContext } from './helpers.js'
import { createOrg } from './fixtures.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('credits: 1 credit = 1 document', () => {
  it('tops up and consumes one credit per document, once', async () => {
    t = await createTestApp()
    const org = createOrg(t.db)
    topup(t.db, org, 2, 'FICTIF-PAY-1', null)
    expect(consume(t.db, org, 'doc-1')).toBe(true)
    expect(consume(t.db, org, 'doc-1')).toBe(true) // same document: not charged twice
    expect(balance(t.db, org)).toBe(1)
    expect(consume(t.db, org, 'doc-2')).toBe(true)
    expect(consume(t.db, org, 'doc-3')).toBe(false)
    expect(balance(t.db, org)).toBe(0)
  })

  it('keeps balances per organization', async () => {
    t = await createTestApp()
    const a = createOrg(t.db, 'A')
    const b = createOrg(t.db, 'B')
    topup(t.db, a, 5, 'FICTIF-PAY-A', null)
    expect(balance(t.db, b)).toBe(0)
    expect(consume(t.db, b, 'doc')).toBe(false)
  })

  it('lets the owner top up with a payment reference; an operator cannot', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'owner@example.cd')
    expect((await call('POST', '/api/credits/topup', { credits: 100, ref: 'MPESA-FICTIF-0001' })).statusCode).toBe(200)
    expect((await call('POST', '/api/credits/topup', { credits: 0, ref: 'X' })).statusCode).toBe(400)
    const state = (await call('GET', '/api/credits')).json()
    expect(state.balance).toBe(100)
    expect(state.entries[0]).toMatchObject({ kind: 'topup', amount: 100, ref: 'MPESA-FICTIF-0001' })

    await call('POST', '/api/orgs/current/members', { email: 'op@example.cd', role: 'operator' })
    const operator = as(t, await login(t, 'op@example.cd'))
    expect((await operator('POST', '/api/credits/topup', { credits: 100, ref: 'FREE-MONEY' })).statusCode).toBe(403)
    expect((await operator('GET', '/api/credits')).json().balance).toBe(100)
  })
})
