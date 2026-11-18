/**
 * Invoices typed by a person (manual) or reviewed from a document (DIRECTIVES §4, §6): the input is what
 * the human confirmed; every amount, the discount and the VAT are recomputed here by code (rule 6),
 * and the checks tell the reviewer what still looks wrong.
 */
import { z } from 'zod'
import type { ExtractedInvoice } from '../documents/invoice-fields.js'
import { normalizeNif } from '../documents/invoice-fields.js'
import { badRequest } from '../errors.js'
import { ClientInput, type Client } from './clients.js'
import { computeInvoice, discountCents, formatMoney, parseMoney, parseQty } from './compute.js'
import type { Check, InvoiceLine, OrgTaxProfile } from './draft.js'
import { VAT_STANDARD_BP } from './tax.js'

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ.')

export const LineInput = z.object({
  description: z.string().trim().min(1, 'Désignation requise.').max(300),
  quantity: z.string().trim().regex(/^\d{1,9}([.,]\d{1,3})?$/, 'Quantité : nombre positif, 3 décimales au plus.'),
  unit: z.string().trim().max(30).nullable().optional(),
  unit_price: z.string().trim().regex(/^\d{1,12}([.,]\d{1,2})?$/, 'Prix unitaire : nombre avec 2 décimales au plus.'),
}).strict()
export type LineInput = z.infer<typeof LineInput>

export const InvoiceInput = z.object({
  /** An existing client, or a new one created with the invoice. */
  client: z.union([z.object({ id: z.string().uuid() }).strict(), ClientInput]),
  reference: z.string().trim().max(60).nullable().optional(),
  po_number: z.string().trim().max(60).nullable().optional(),
  period: z.string().trim().max(80).nullable().optional(),
  issue_date: Day,
  due_date: Day,
  currency: z.enum(['USD', 'CDF']),
  lines: z.array(LineInput).min(1, 'Ajoutez au moins une ligne.').max(200),
  vat_rate_bp: z.number().int().min(0).max(10_000),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.string().trim().min(1).max(20) }).strict().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict().refine(i => i.due_date >= i.issue_date, { message: "L'échéance ne peut pas précéder la date de la facture.", path: ['due_date'] })
export type InvoiceInput = z.infer<typeof InvoiceInput>

/** Above this, an amount is a typing mistake (and would exceed exact integer arithmetic). */
const MAX_LINE_CENTS = 10_000_000_000_000 // 100 billion
const MAX_TOTAL_CENTS = 100_000_000_000_000

export interface BuiltInvoice {
  lines: InvoiceLine[]
  subtotalCents: number
  discountCents: number
  vatRateBp: number
  vatCents: number
  totalCents: number
  checks: Check[]
}

export interface BuildContext {
  /** Fields read from the source document, to compare with what the human confirmed. */
  extracted?: ExtractedInvoice | null
  ocrConfidence?: number | null
  today?: string
}

const NIF_FORMAT = /^[A-Z]\d{7}[A-Z]$/

export function buildInvoice(input: InvoiceInput, client: Pick<Client, 'name' | 'nif' | 'vat_applicable'>, org: OrgTaxProfile, ctx: BuildContext = {}): BuiltInvoice {
  const lines: InvoiceLine[] = input.lines.map((l, i) => {
    const qty = l.quantity.replace(',', '.')
    const qtyMilli = parseQty(qty)
    if (qtyMilli <= 0) throw badRequest(`Ligne ${i + 1} : la quantité doit être supérieure à zéro.`)
    return {
      code: `L${i + 1}`, label: l.description, unit: l.unit?.trim() || '', qty, qty_milli: qtyMilli,
      unit_cents: parseMoney(l.unit_price.replace(',', '.')), amount_cents: 0,
    }
  })
  const subtotalBefore = computeInvoice(lines.map(l => ({ qtyMilli: l.qty_milli, unitCents: l.unit_cents })), 0).subtotalCents
  let discount: number
  try { discount = discountCents(subtotalBefore, input.discount) } catch (error) { throw badRequest(`Remise : ${(error as Error).message}.`) }
  if (discount > subtotalBefore) throw badRequest('La remise dépasse le total des lignes.')
  const totals = computeInvoice(lines.map(l => ({ qtyMilli: l.qty_milli, unitCents: l.unit_cents })), input.vat_rate_bp, discount)
  lines.forEach((l, i) => { l.amount_cents = totals.lineCents[i]! })
  if (totals.lineCents.some(c => c > MAX_LINE_CENTS) || totals.totalCents > MAX_TOTAL_CENTS) throw badRequest('Montant trop élevé : vérifiez les quantités et les prix.')

  const checks: Check[] = []
  const money = (cents: number) => `${formatMoney(cents)} ${input.currency}`

  // 1. Client.
  checks.push(client.nif && NIF_FORMAT.test(normalizeNif(client.nif))
    ? { id: 'nif', status: 'ok', title: 'NIF du client au bon format', note: client.nif }
    : { id: 'nif', status: 'warning', title: 'NIF du client à vérifier', note: client.nif ? `Format inattendu : ${client.nif}` : 'Aucun NIF pour ce client' })

  // 2. VAT, against what the organization and the client declared.
  const rate = input.vat_rate_bp
  if (rate > 0 && org.vat_status === 'no') {
    checks.push({ id: 'vat', status: 'error', title: 'TVA facturée sans être assujetti', note: 'Votre entreprise est déclarée non assujettie à la TVA : retirez la TVA ou corrigez vos paramètres.' })
  } else if (rate > 0 && !client.vat_applicable) {
    checks.push({ id: 'vat', status: 'warning', title: 'TVA appliquée à un client exonéré', note: 'La fiche du client indique « TVA non applicable » : à confirmer par votre expert-comptable.' })
  } else if (rate > 0 && rate !== VAT_STANDARD_BP) {
    checks.push({ id: 'vat', status: 'warning', title: `Taux de TVA inhabituel (${rate / 100} %)`, note: 'Le taux standard en RDC est 16 % : à confirmer par votre expert-comptable.' })
  } else if (rate === 0 && org.vat_status === 'yes' && client.vat_applicable) {
    checks.push({ id: 'vat', status: 'warning', title: 'TVA non appliquée', note: 'Votre entreprise est assujettie et le client ne figure pas comme exonéré.' })
  } else if (rate > 0 && org.vat_status === 'unknown') {
    checks.push({ id: 'vat', status: 'warning', title: `TVA ${rate / 100} % appliquée`, note: `${money(totals.vatCents)} — confirmez que votre entreprise est assujettie à la TVA.` })
  } else {
    checks.push({ id: 'vat', status: rate ? 'ok' : 'info', title: rate ? `TVA ${rate / 100} % appliquée` : 'TVA non appliquée', note: rate ? money(totals.vatCents) : 'Aucune TVA sur cette facture.' })
  }

  // 3. What the document said, compared with what the code computed.
  const ex = ctx.extracted
  if (ex) {
    const read = (s: string | null) => (s ? parseMoney(s) : null)
    const readTotal = read(ex.total)
    if (readTotal !== null && readTotal !== totals.totalCents) {
      checks.push({ id: 'total_read', status: 'warning', title: 'Total différent du document', note: `Le document indique ${money(readTotal)}, le calcul donne ${money(totals.totalCents)}. Vérifiez les lignes, la remise et la TVA.` })
    } else if (readTotal !== null) {
      checks.push({ id: 'total_read', status: 'ok', title: 'Total conforme au document', note: money(totals.totalCents) })
    }
    const readSub = read(ex.subtotal)
    // Without a grand total on the document, its subtotal is the figure to compare.
    if (readSub !== null && readTotal === null && readSub !== totals.subtotalCents) {
      checks.push({ id: 'subtotal_read', status: 'warning', title: 'Total HT différent du document', note: `Le document indique ${money(readSub)}, le calcul donne ${money(totals.subtotalCents)}.` })
    }
    const wrong = ex.lines.filter(l => l.quantity && l.unit_price && l.amount && Math.abs(Number(l.quantity) * Number(l.unit_price) - Number(l.amount)) > 0.011)
    if (wrong.length) checks.push({ id: 'line_math', status: 'warning', title: 'Calculs faux dans le document', note: wrong.map(l => `${l.description} : ${l.quantity} × ${l.unit_price} ≠ ${l.amount}`).join(' ; ') + '. Les montants de la facture sont recalculés.' })
    if (ex.suspicious_instructions) checks.push({ id: 'instructions', status: 'warning', title: 'Instructions ignorées', note: "Le document contient des consignes adressées à l'agent. Elles ont été ignorées : seuls vos montants vérifiés comptent." })
  }
  if (ctx.ocrConfidence !== null && ctx.ocrConfidence !== undefined && ctx.ocrConfidence < 75) {
    checks.push({ id: 'ocr', status: 'warning', title: `Lecture du scan peu sûre (${ctx.ocrConfidence} %)`, note: 'Comparez chaque quantité et chaque prix avec le document original.' })
  }

  // 4. Dates.
  const today = ctx.today ?? new Date().toISOString().slice(0, 10)
  if (input.issue_date > addDays(today, 1)) checks.push({ id: 'date', status: 'warning', title: 'Date de facture dans le futur', note: input.issue_date })
  else if (input.issue_date < addDays(today, -365)) checks.push({ id: 'date', status: 'warning', title: 'Date de facture de plus d\'un an', note: input.issue_date })

  // 5. Our own identity, required before any official document (directive 5.2).
  if (!org.nif || !org.rccm) checks.push({ id: 'identity', status: 'warning', title: 'Votre NIF ou RCCM manque', note: 'Complétez votre identité fiscale dans les paramètres avant tout envoi.' })

  // 6. Fiscal status (rule 8).
  checks.push({ id: 'fiscal', status: 'info', title: 'Document non fiscal', note: 'Projet de facture. La facture normalisée DGI passe par votre dispositif homologué.' })

  return { lines, subtotalCents: totals.subtotalCents, discountCents: totals.discountCents, vatRateBp: rate, vatCents: totals.vatCents, totalCents: totals.totalCents, checks }
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface ReviewSuggestion {
  input: InvoiceInput
  /** Existing client recognised by tax id or name; null when a new client would be created. */
  matchedClient: { id: string; name: string } | null
}

/** The form the reviewer starts from: what the document said, completed with the organization's defaults. */
export function suggestInvoice(ex: ExtractedInvoice, org: OrgTaxProfile & { currency: string }, clients: Client[], today = new Date().toISOString().slice(0, 10)): ReviewSuggestion {
  const nif = ex.client.nif ? normalizeNif(ex.client.nif) : null
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\((?:fictif|fictive)\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const matched = clients.find(c => nif && c.nif && normalizeNif(c.nif) === nif)
    ?? clients.find(c => ex.client.name && norm(c.name) === norm(ex.client.name))
    ?? null
  const vatApplicable = matched ? matched.vat_applicable : ex.vat_exempt !== true
  const rate = ex.vat_exempt === true || !vatApplicable || org.vat_status === 'no' ? 0
    : ex.vat_rate_percent ? Math.round(Number(ex.vat_rate_percent) * 100) : VAT_STANDARD_BP
  const terms = ex.payment_terms_days ?? 30
  const due = ex.due_date && ex.due_date >= today ? ex.due_date : addDays(today, terms)
  const input: InvoiceInput = {
    client: matched ? { id: matched.id } : {
      name: ex.client.name ?? '', address: ex.client.address, nif: nif ?? ex.client.nif, rccm: ex.client.rccm,
      email: ex.client.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ex.client.email) ? ex.client.email : null, vat_applicable: vatApplicable,
    },
    reference: ex.reference, po_number: ex.po_number, period: null,
    issue_date: today, due_date: due,
    currency: (ex.currency ?? (org.currency === 'CDF' ? 'CDF' : 'USD')) as 'USD' | 'CDF',
    lines: ex.lines.map(l => ({
      description: l.description, quantity: l.quantity ?? '1', unit: l.unit,
      unit_price: l.unit_price ?? (l.amount && l.quantity && Number(l.quantity) > 0 ? (Number(l.amount) / Number(l.quantity)).toFixed(2) : l.amount ?? '0.00'),
    })),
    vat_rate_bp: rate,
    discount: ex.discount ? { type: 'amount', value: ex.discount } : null,
    notes: ex.notes,
  }
  return { input, matchedClient: matched ? { id: matched.id, name: matched.name } : null }
}
