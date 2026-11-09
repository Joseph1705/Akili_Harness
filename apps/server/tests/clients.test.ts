import { afterEach, describe, expect, it } from 'vitest'
import { as, createTestApp, login, onboardedOwner, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

const contract = {
  reference: 'CT-TSH-2026', po_number: 'BC-0932', currency: 'USD', payment_terms_days: 15,
  rates: [{ code: 'GRU-25', label: 'Location grue mobile 25 t', unit: 'jour', unit_price: '640.00', max_qty: '20' }],
}

describe('clients and contracts', () => {
  it('creates a client with a contract and lists them', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    const client = await call('POST', '/api/clients', { name: 'Tshala Logistique SARL', nif: 'A0987654K', email: 'compta@tshala.example', vat_applicable: true })
    expect(client.statusCode).toBe(200)
    const id = client.json().client.id
    const created = await call('POST', `/api/clients/${id}/contracts`, contract)
    expect(created.statusCode).toBe(200)
    expect(created.json().contract.rates[0]).toMatchObject({ code: 'GRU-25', unit_price: '640.00' })
    const list = (await call('GET', '/api/clients')).json().clients
    expect(list).toHaveLength(1)
    expect(list[0].contracts[0]).toMatchObject({ po_number: 'BC-0932', payment_terms_days: 15 })
  })

  it('refuses a purchase order number already used, whatever the case', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    const id = (await call('POST', '/api/clients', { name: 'Client A' })).json().client.id
    expect((await call('POST', `/api/clients/${id}/contracts`, contract)).statusCode).toBe(200)
    const again = await call('POST', `/api/clients/${id}/contracts`, { ...contract, reference: 'CT-2', po_number: 'bc-0932' })
    expect(again.statusCode).toBe(409)
    expect(again.json().message).toMatch(/BC-0932|bc-0932/)
  })

  it('validates rate cards: prices, unique codes', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    const id = (await call('POST', '/api/clients', { name: 'Client A' })).json().client.id
    expect((await call('POST', `/api/clients/${id}/contracts`, { ...contract, rates: [{ ...contract.rates[0], unit_price: '640,00' }] })).statusCode).toBe(400)
    expect((await call('POST', `/api/clients/${id}/contracts`, { ...contract, rates: [contract.rates[0], contract.rates[0]] })).statusCode).toBe(400)
    expect((await call('POST', `/api/clients/${id}/contracts`, { ...contract, rates: [] })).statusCode).toBe(400)
  })

  it('updates a rate card and keeps other organizations out', async () => {
    t = await createTestApp()
    const a = await onboardedOwner(t, 'a@example.cd', 'A SARL')
    const b = await onboardedOwner(t, 'b@example.cd', 'B SARL')
    const id = (await a.call('POST', '/api/clients', { name: 'Client A' })).json().client.id
    const k = (await a.call('POST', `/api/clients/${id}/contracts`, contract)).json().contract
    const updated = await a.call('PUT', `/api/contracts/${k.id}`, { ...contract, rates: [{ ...contract.rates[0], unit_price: '700.00' }] })
    expect(updated.json().contract.rates[0].unit_price).toBe('700.00')
    expect((await b.call('PUT', `/api/contracts/${k.id}`, contract)).statusCode).toBe(404)
    expect((await b.call('POST', `/api/clients/${id}/contracts`, { ...contract, po_number: 'X-1' })).statusCode).toBe(404)
    expect((await b.call('GET', '/api/clients')).json().clients).toHaveLength(0)
  })

  it('lets only owners and admins manage clients', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    await call('POST', '/api/orgs/current/members', { email: 'op@example.cd', role: 'operator' })
    const op = as(t, await login(t, 'op@example.cd'))
    expect((await op('POST', '/api/clients', { name: 'X' })).statusCode).toBe(403)
    expect((await op('GET', '/api/clients')).statusCode).toBe(200)
  })
})
