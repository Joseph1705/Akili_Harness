/** Invoice arithmetic in integers: cents for money, thousandths for quantities. Half a cent rounds up. */

export function parseQty(raw: string): number {
  const s = raw.trim().replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) throw new RangeError(`quantité invalide : ${raw}`)
  const [int, dec = ''] = s.split('.')
  return Number(int) * 1000 + Number(dec.padEnd(3, '0'))
}

export function parseMoney(raw: string): number {
  const s = raw.trim()
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) throw new RangeError(`montant invalide : ${raw}`)
  const [int, dec = ''] = s.split('.')
  return Number(int) * 100 + Number(dec.padEnd(2, '0'))
}

export function formatQty(milli: number): string {
  const int = Math.floor(milli / 1000)
  const dec = String(milli % 1000).padStart(3, '0').replace(/0+$/, '')
  return dec ? `${int},${dec}` : String(int)
}

/** French grouping: 14 801,60 (narrow no-break spaces avoided for PDF fonts). */
export function formatMoney(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${negative ? '-' : ''}${int},${String(abs % 100).padStart(2, '0')}`
}

function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

export interface Totals {
  lineCents: number[]
  subtotalCents: number
  discountCents: number
  /** Subtotal minus discount: the base VAT is computed on. */
  taxableCents: number
  vatCents: number
  totalCents: number
}

/** Lines, then an invoice-level discount, then VAT on what remains. Every value in integers. */
export function computeInvoice(lines: Array<{ qtyMilli: number; unitCents: number }>, vatRateBp: number, discountCents = 0): Totals {
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) throw new RangeError(`taux de TVA invalide : ${vatRateBp}`)
  const lineCents = lines.map(l => Number(divRoundHalfUp(BigInt(l.qtyMilli) * BigInt(l.unitCents), 1000n)))
  const subtotal = lineCents.reduce((a, b) => a + b, 0)
  if (!Number.isInteger(discountCents) || discountCents < 0 || discountCents > subtotal) throw new RangeError('remise supérieure au total des lignes')
  const taxable = subtotal - discountCents
  const vat = Number(divRoundHalfUp(BigInt(taxable) * BigInt(vatRateBp), 10_000n))
  return { lineCents, subtotalCents: subtotal, discountCents, taxableCents: taxable, vatCents: vat, totalCents: taxable + vat }
}

/** A discount given as an amount ("150.00") or a percentage ("5", "2.5") of the subtotal, in cents. */
export function discountCents(subtotalCents: number, discount: { type: 'amount' | 'percent'; value: string } | null | undefined): number {
  if (!discount) return 0
  const value = discount.value.trim().replace(',', '.')
  if (discount.type === 'amount') return parseMoney(value)
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) throw new RangeError(`pourcentage invalide : ${discount.value}`)
  const [int, dec = ''] = value.split('.')
  const bp = Number(int) * 100 + Number(dec.padEnd(2, '0'))
  if (bp > 10_000) throw new RangeError('remise supérieure à 100 %')
  return Number(divRoundHalfUp(BigInt(subtotalCents) * BigInt(bp), 10_000n))
}
