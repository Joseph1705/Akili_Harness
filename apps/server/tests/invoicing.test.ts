import { describe, expect, it } from 'vitest'
import { computeInvoice, parseMoney, parseQty, formatMoney } from '../src/invoicing/compute.js'

describe('invoice arithmetic (code decides, rule 6)', () => {
  it('reproduces the design example exactly', () => {
    const t = computeInvoice([
      { qtyMilli: parseQty('12'), unitCents: parseMoney('640.00') },
      { qtyMilli: parseQty('96'), unitCents: parseMoney('35.00') },
      { qtyMilli: parseQty('1'), unitCents: parseMoney('1720.00') },
    ], 1600)
    expect(t.lineCents).toEqual([768000, 336000, 172000])
    expect(t.subtotalCents).toBe(1276000)
    expect(t.vatCents).toBe(204160)
    expect(t.totalCents).toBe(1480160)
    expect(formatMoney(t.totalCents)).toBe('14 801,60')
  })

  it('rounds half a cent up and handles decimals', () => {
    expect(computeInvoice([{ qtyMilli: parseQty('1240.5'), unitCents: parseMoney('42.50') }], 1600).lineCents).toEqual([5272125])
    expect(computeInvoice([{ qtyMilli: parseQty('0.5'), unitCents: 1 }], 0).lineCents).toEqual([1])
    expect(computeInvoice([{ qtyMilli: parseQty('1'), unitCents: parseMoney('0.03') }], 1600).vatCents).toBe(0)
    expect(computeInvoice([{ qtyMilli: parseQty('1'), unitCents: parseMoney('0.04') }], 1600).vatCents).toBe(1)
  })

  it('applies no VAT when the rate is zero', () => {
    const t = computeInvoice([{ qtyMilli: parseQty('124'), unitCents: parseMoney('28.00') }], 0)
    expect(t).toMatchObject({ subtotalCents: 347200, vatCents: 0, totalCents: 347200 })
  })

  it('refuses malformed amounts and quantities', () => {
    expect(() => parseQty('-3')).toThrow()
    expect(() => parseQty('1.2345')).toThrow()
    expect(() => parseMoney('12,345')).toThrow()
    expect(() => parseQty('1e9')).toThrow()
  })
})
