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
  vatCents: number
  totalCents: number
}

export function computeInvoice(lines: Array<{ qtyMilli: number; unitCents: number }>, vatRateBp: number): Totals {
  const lineCents = lines.map(l => Number(divRoundHalfUp(BigInt(l.qtyMilli) * BigInt(l.unitCents), 1000n)))
  const subtotal = lineCents.reduce((a, b) => a + b, 0)
  const vat = Number(divRoundHalfUp(BigInt(subtotal) * BigInt(vatRateBp), 10_000n))
  return { lineCents, subtotalCents: subtotal, vatCents: vat, totalCents: subtotal + vat }
}
