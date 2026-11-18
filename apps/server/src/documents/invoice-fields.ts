/**
 * Invoice fields read from any business document's text (purchase order, delivery note, quote, request…),
 * without a language model. Deterministic and cautious: every value is a proposal shown to a human,
 * who corrects it before an invoice is generated, and every amount is recomputed by code (rule 6).
 * The text is data, never instructions (rule 9): sentences addressed to an AI are detected and dropped.
 *
 * The same shape (ExtractedInvoice) is produced by the language-model extractor when an organization
 * enables it (ai/extract.ts), so the review screen and the checks do not depend on how fields were read.
 */
import { z } from 'zod'
import { isInstructionLine, suspiciousInstructions } from '../security/guardrails.js'

export const Party = z.object({
  name: z.string().max(160).nullable(),
  address: z.string().max(240).nullable(),
  nif: z.string().max(40).nullable(),
  rccm: z.string().max(60).nullable(),
  id_nat: z.string().max(60).nullable(),
  email: z.string().max(254).nullable(),
  phone: z.string().max(40).nullable(),
})
export type Party = z.infer<typeof Party>

export const ExtractedLine = z.object({
  description: z.string().min(1).max(300),
  /** Decimal strings with a dot, as read: quantity up to 3 decimals, money with 2. */
  quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).nullable(),
  unit: z.string().max(30).nullable(),
  unit_price: z.string().regex(/^\d{1,12}\.\d{2}$/).nullable(),
  amount: z.string().regex(/^\d{1,12}\.\d{2}$/).nullable(),
})
export type ExtractedLine = z.infer<typeof ExtractedLine>

const Money = z.string().regex(/^\d{1,12}\.\d{2}$/).nullable()

export const DOCUMENT_TYPES = ['invoice', 'quote', 'purchase_order', 'delivery_note', 'receipt', 'statement', 'other'] as const

export const ExtractedInvoice = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
  /** Number of the source document (e.g. BL-2026-118), shown on the invoice as its reference. */
  reference: z.string().max(60).nullable(),
  /** The customer's purchase order number, when the document names one. */
  po_number: z.string().max(60).nullable(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  payment_terms_days: z.number().int().min(0).max(365).nullable(),
  currency: z.enum(['USD', 'CDF']).nullable(),
  /** Who the generated invoice is addressed to (never the organization itself). */
  client: Party,
  /** Who issued the source document, as read (it may be the organization itself). */
  issuer: Party,
  lines: z.array(ExtractedLine).max(200),
  subtotal: Money,
  discount: Money,
  vat_rate_percent: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullable(),
  vat_amount: Money,
  total: Money,
  vat_exempt: z.boolean().nullable(),
  notes: z.string().max(1000).nullable(),
  suspicious_instructions: z.boolean(),
})
export type ExtractedInvoice = z.infer<typeof ExtractedInvoice>

export interface OrgIdentity { name: string; nif: string | null; rccm: string | null; currency: string }

const emptyParty = (): Party => ({ name: null, address: null, nif: null, rccm: null, id_nat: null, email: null, phone: null })

// ---------------------------------------------------------------- numbers

/**
 * "1 350,00", "1.234,56", "1,234.56", "18,5" → "1350.00", "1234.56", "1234.56", "18.50" (decimals = 2);
 * quantities keep up to 3 decimals without trailing zeros ("1240,5" → "1240.5"). Null when not a plain number.
 */
export function parseDecimal(raw: string, decimals: 2 | 3 = 2): string | null {
  let s = raw.trim().replace(/[  ]/g, ' ')
  if (s.includes(' ')) {
    if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return null
    s = s.replace(/ /g, '')
  }
  if (!/^\d+([.,]\d+)*$/.test(s)) return null
  const comma = s.lastIndexOf(',')
  const dot = s.lastIndexOf('.')
  let int: string
  let frac = ''
  if (comma >= 0 && dot >= 0) {
    const sep = comma > dot ? ',' : '.'
    const other = sep === ',' ? '.' : ','
    const at = s.lastIndexOf(sep)
    const head = s.slice(0, at)
    if (head.includes(sep) || !new RegExp(`^\\d{1,3}(\\${other}\\d{3})*$`).test(head)) return null
    int = head.split(other).join('')
    frac = s.slice(at + 1)
  } else if (comma >= 0 || dot >= 0) {
    const parts = s.split(comma >= 0 ? ',' : '.')
    if (parts.length > 2) {
      if (parts[0]!.length > 3 || !parts.slice(1).every(p => p.length === 3)) return null
      int = parts.join('')
    } else {
      int = parts[0]!
      frac = parts[1]!
      // "1,250" in a money column is a thousands separator; in a quantity it is a decimal.
      if (frac.length === 3 && decimals === 2 && int.length <= 3) { int += frac; frac = '' }
    }
  } else {
    int = s
  }
  if (frac.length > decimals) return null
  int = int.replace(/^0+(?=\d)/, '')
  if (int.length > (decimals === 2 ? 12 : 9)) return null
  if (decimals === 2) return `${int}.${frac.padEnd(2, '0')}`
  frac = frac.replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int
}

interface Atom { text: string; start: number; end: number }

function atoms(line: string): Atom[] {
  const out: Atom[] = []
  for (const m of line.matchAll(/\d+(?:[.,]\d+)*/g)) out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length })
  return out
}

interface NumberToken { value: string; start: number; end: number; written: string }

/** "1" + " " + "350,00" may be one number (1 350,00) or two: decided by the arithmetic, not guessed. */
function glueable(line: string, prev: Atom, next: Atom): boolean {
  return /^[   ]$/.test(line.slice(prev.end, next.start)) && !/[.,]/.test(prev.text) && prev.text.length <= 3
    && /^\d{3}(?:[.,]\d+)?$/.test(next.text)
}

/** Every reading of the line's trailing numbers as (quantity, unit price, amount). */
function triples(line: string, list: Atom[]): Array<[NumberToken, NumberToken, NumberToken]> {
  const tail = list.slice(-7)
  const n = tail.length
  const out: Array<[NumberToken, NumberToken, NumberToken]> = []
  for (let mask = 0; mask < 1 << Math.max(0, n - 1); mask++) {
    const groups: Atom[][] = [[tail[0]!]]
    let ok = true
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) {
        if (!glueable(line, tail[i - 1]!, tail[i]!)) { ok = false; break }
        groups[groups.length - 1]!.push(tail[i]!)
      } else {
        groups.push([tail[i]!])
      }
    }
    if (!ok || groups.length < 3) continue
    const tokens = groups.slice(-3).map((g, k) => {
      const startAt = g[0]!.start
      const endAt = g[g.length - 1]!.end
      return { value: parseDecimal(g.map(a => a.text).join(' '), k === 0 ? 3 : 2), start: startAt, end: endAt, written: line.slice(startAt, endAt) }
    })
    if (tokens.some(t => t.value === null)) continue
    out.push(tokens as [NumberToken, NumberToken, NumberToken])
  }
  return out
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.001)

// ---------------------------------------------------------------- vocabulary

const UNITS = ['jours', 'jour', 'j', 'heures', 'heure', 'h', 'km', 'm2', 'm²', 'm3', 'm³', 'mètres', 'mètre', 'm', 'tonnes', 'tonne', 't', 'kg',
  'litres', 'litre', 'l', 'forfait', 'forfaits', 'unités', 'unité', 'u', 'pièces', 'pièce', 'pce', 'pcs', 'mois', 'semaines', 'semaine',
  'citernes', 'citerne', 'agent-jour', 'agents-jour', 'voyages', 'voyage', 'lots', 'lot', 'sacs', 'sac', 'carton', 'cartons']
const UNIT_RE = new RegExp(`^(?:${UNITS.map(u => u.replace(/[-]/g, '\\-')).join('|')})$`, 'i')
const CURRENCY_WORDS = /\b(?:USD|CDF|FC|Fc|US\$|dollars?|francs?(?: congolais)?)\b|\$/gi

const TOTAL_RE = /\b(?:sous[- ]?total|total|montant\s+(?:h\.?t\.?|t\.?t\.?c\.?|net|total)|net\s+[àa]\s+payer|t\.?v\.?a\.?|vat|taxes?|remise|rabais|escompte|discount|acompte|reste\s+[àa]\s+payer)\b/i
const SUBTOTAL_RE = /\b(?:sous[- ]?total|total\s+h\.?\s?t\.?|montant\s+h\.?\s?t\.?|total\s+hors\s+taxes?|subtotal)\b/i
const GRAND_TOTAL_RE = /\b(?:total\s+t\.?\s?t\.?\s?c\.?|montant\s+t\.?\s?t\.?\s?c\.?|net\s+[àa]\s+payer|total\s+[àa]\s+payer|total\s+g[ée]n[ée]ral|grand\s+total|total\s+due|amount\s+due)\b/i
const PLAIN_TOTAL_RE = /^\s*(?:total|montant\s+total|total\s+amount)\b/i
const VAT_RE = /\b(?:t\.?v\.?a\.?|vat)\b/i
const DISCOUNT_RE = /\b(?:remise|rabais|escompte|discount)\b/i
const VAT_EXEMPT_RE = /exon[ée]r|tva\s+non\s+applicable|hors\s+champ|non\s+assujetti|vat\s+exempt/i

const HEADER_DESC = /d[ée]signation|description|libell[ée]|article|prestation|produit|d[ée]tail|item/i
const HEADER_QTY = /^(?:qt[ée]s?\.?|quantit[ée]s?|qty|nombre|nbre|nb)$/i
const HEADER_PRICE = /p\.?\s?u\.?|prix\s*unit|unit\s*price|tarif|^prix$/i
const HEADER_UNIT = /^(?:unit[ée]s?|u\.?)$/i
const HEADER_AMOUNT = /montant|total|amount|valeur/i

const CLIENT_MARKER = /^(?:client|doit|factur[ée]\s+[àa]|destinataire|adress[ée]\s+[àa]|[àa]\s+l['’]attention\s+de|bill\s+to|customer|acheteur|donneur\s+d['’]ordre)\b\s*(?:[:\-–]\s*)?(.*)$/i
const SUPPLIER_MARKER = /^(?:fournisseur|prestataire|vendeur|supplier|vendor|exp[ée]diteur)\b\s*(?:[:\-–]\s*)?(.*)$/i

const TITLES: Array<[RegExp, ExtractedInvoice['document_type']]> = [
  [/\bfacture\s+pro\s*-?\s*forma\b|\bproforma\b|\bdevis\b|\bquotation\b|\bquote\b/i, 'quote'],
  [/\bbon\s+de\s+commande\b|\bpurchase\s+order\b|\bcommande\s+n[°ºo]/i, 'purchase_order'],
  [/\bbon\s+de\s+livraison\b|\bdelivery\s+note\b/i, 'delivery_note'],
  [/\bre[çc]u\b|\breceipt\b/i, 'receipt'],
  [/\brelev[ée]\b|\bstatement\b/i, 'statement'],
  [/\bfacture\b|\binvoice\b/i, 'invoice'],
]

const NUMBER_AFTER = /(?:\bn[°ºo]\.?|\bno\.?|\bnum[ée]ro|#|\br[ée]f(?:[ée]rence)?\.?)\s*[:\-]?\s*((?=[A-Z0-9\-\/\.]*\d)[A-Z0-9][A-Z0-9\-\/\.]{1,40}[A-Z0-9])/i

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, février: 2, fevrier: 2, févr: 2, fevr: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  août: 8, aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, décembre: 12, decembre: 12, déc: 12, dec: 12,
}

// ---------------------------------------------------------------- helpers

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/^[\s\-–•*·:|]+|[\s\-–•*·:|]+$/g, '').trim()
}

/** A company or person name, not OCR noise: a real word and mostly letters. */
function plausibleName(s: string): boolean {
  const c = clean(s)
  return c.length >= 3 && c.length <= 120 && /\p{L}{3,}/u.test(c) && letterRatio(c) >= 0.6
}

function letterRatio(s: string): number {
  const visible = s.replace(/\s/g, '')
  if (!visible) return 0
  return (visible.match(/\p{L}/gu)?.length ?? 0) / visible.length
}

/** OCR reads 0 as O, 1 as I or l, 5 as S, 8 as B: fix them where a tax id must hold digits. */
export function normalizeNif(raw: string): string {
  const s = raw.replace(/[\s.\-]/g, '').toUpperCase()
  if (/^[A-Z][0-9OILSB]{7}[A-Z]$/.test(s)) {
    return s[0] + s.slice(1, 8).replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8') + s[8]
  }
  return s
}

function parseDate(text: string): string | null {
  let m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/.exec(text)
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]))
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /\b(\d{1,2})(?:er)?\s+([a-zéû]{3,9})\.?\s+(\d{4})\b/i.exec(text)
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()]
    if (month) return isoDate(Number(m[3]), month, Number(m[1]))
  }
  return null
}

function isoDate(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1) return null
  return date.toISOString().slice(0, 10)
}

function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\((?:fictif|fictive)\)/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(sarl|sa|sas|sprl|sarlu|ltd|llc|inc|ets|etablissements)\b/g, ' ').replace(/\s+/g, ' ').trim()
}

function isUs(party: Party, us: OrgIdentity): boolean {
  if (party.nif && us.nif && normalizeNif(party.nif) === normalizeNif(us.nif)) return true
  if (party.rccm && us.rccm && party.rccm.replace(/\s/g, '').toUpperCase() === us.rccm.replace(/\s/g, '').toUpperCase()) return true
  if (!party.name) return false
  const a = normName(party.name)
  const b = normName(us.name)
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))
}

function identities(line: string, party: Party, explicitClient = false): void {
  const nif = /\bNIF(?:\s+client)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-]{5,14}[A-Z0-9])\b/i.exec(line)
  if (nif && !party.nif) party.nif = normalizeNif(nif[1]!)
  const rccm = /\bRCCM\s*[:.]?\s*([A-Z]{2}\/[A-Z]{2,4}\/RCCM\/[0-9A-Z\-]{4,20}|[A-Z0-9][A-Z0-9\/\-]{5,40})/i.exec(line)
  if (rccm && !party.rccm) party.rccm = rccm[1]!.toUpperCase()
  const idNat = /\bId\.?\s*Nat\.?\s*[:.]?\s*([0-9A-Z][0-9A-Z\-]{5,30})/i.exec(line)
  if (idNat && !party.id_nat) party.id_nat = idNat[1]!.toUpperCase()
  const email = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,180}\.[A-Z]{2,}/i.exec(line)
  if (email && !party.email) party.email = email[0].toLowerCase()
  const phone = /(?:\+243|\b0)[\s.]?\d{2,3}(?:[\s.]?\d{2,3}){2,3}\b/.exec(line)
  if (phone && !party.phone && !explicitClient) party.phone = phone[0].replace(/\s+/g, ' ')
}

const IDENTITY_LINE = /\b(?:NIF|RCCM|Id\.?\s*Nat|T[ée]l|Phone|E-?mail|Courriel)\b/i
const ADDRESS_LINE = /\b(?:av(?:\.|enue)?|bd|boulevard|route|rue|quartier|q\.|commune|c\/|bp|b\.p\.|lubumbashi|kinshasa|kolwezi|likasi|goma|bukavu|matadi|kisangani|mbuji|kananga)\b/i

// ---------------------------------------------------------------- extraction

export function extractInvoiceFields(text: string, us: OrgIdentity): ExtractedInvoice {
  const raw = text.replace(/\r/g, '').split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
  // Lines aimed at an AI are kept out of every field.
  const suspicious = suspiciousInstructions(text)
  const lines = raw.map(l => (l && isInstructionLine(l) ? '' : l))
  const result: ExtractedInvoice = {
    document_type: 'other', reference: null, po_number: null, issue_date: null, due_date: null, payment_terms_days: null,
    currency: null, client: emptyParty(), issuer: emptyParty(), lines: [], subtotal: null, discount: null,
    vat_rate_percent: null, vat_amount: null, total: null, vat_exempt: null, notes: null, suspicious_instructions: suspicious,
  }

  // Document type and number: the first title line.
  let titleIndex = -1
  for (const [i, line] of lines.entries()) {
    if (!line || CLIENT_MARKER.test(line) || SUPPLIER_MARKER.test(line)) continue
    const found = TITLES.find(([re]) => re.test(line))
    if (found && line.length <= 90) {
      result.document_type = found[1]
      const num = NUMBER_AFTER.exec(line)
      if (num) result.reference = num[1]!.toUpperCase()
      titleIndex = i
      break
    }
  }
  if (result.document_type === 'purchase_order') result.po_number = result.reference
  for (const line of lines) {
    if (!result.po_number && /\b(?:bon\s+de\s+commande|b\.?\s?c\.?|purchase\s+order|p\.?o\.?)\b/i.test(line)) {
      const m = /\b(?:bon\s+de\s+commande|b\.?\s?c\.?|purchase\s+order|p\.?o\.?)\s*(?:n[°ºo]\.?|no\.?|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/\.]{1,40}[A-Z0-9])/i.exec(line)
      if (m && /\d/.test(m[1]!)) result.po_number = m[1]!.toUpperCase()
    }
  }

  // Parties: the letterhead (before the title or the first marker) is the issuer; a "Client :" block is the recipient.
  const issuer = emptyParty()
  const recipient = emptyParty()
  let supplierNamed: Party | null = null
  let block: 'issuer' | 'recipient' | 'none' = 'issuer'
  let recipientLines = 0
  for (const [i, line] of lines.entries()) {
    if (!line) { if (block === 'recipient' && recipientLines > 0) block = 'none'; continue }
    if (i === titleIndex) { if (block === 'issuer') block = 'none'; continue }
    const client = CLIENT_MARKER.exec(line)
    if (client) {
      block = 'recipient'
      recipientLines = 0
      const rest = clean(client[1] ?? '')
      if (rest && !recipient.name && plausibleName(rest) && !/^(?:nif|rccm)\b/i.test(rest)) {
        recipient.name = rest.split(/\s+[—–-]\s+/)[0]!.slice(0, 160)
        recipientLines++
      }
      continue
    }
    if (/^NIF\s+client\b/i.test(line)) { identities(line, recipient, true); continue }
    const supplier = SUPPLIER_MARKER.exec(line)
    if (supplier) {
      supplierNamed = emptyParty()
      const rest = clean(supplier[1] ?? '')
      supplierNamed.name = rest.split(/\s+[—–-]\s+/)[0]!.slice(0, 160) || null
      identities(line, supplierNamed)
      if (block === 'issuer') block = 'none'
      continue
    }
    if (HEADER_DESC.test(line) && (HEADER_AMOUNT.test(line) || /qt[ée]|quantit/i.test(line))) { block = 'none'; continue }
    if (block === 'issuer') {
      if (letterRatio(line) < 0.5 && !IDENTITY_LINE.test(line)) continue // OCR noise, rulers
      if (parseDate(line) && /\bdate\b/i.test(line)) continue
      if (!issuer.name && !IDENTITY_LINE.test(line) && plausibleName(line)) { issuer.name = clean(line).slice(0, 160); continue }
      identities(line, issuer)
      if (!issuer.address && ADDRESS_LINE.test(line)) issuer.address = clean(line.split(/\s+[-·]\s+(?=RCCM|NIF|Id)/i)[0]!).slice(0, 240)
      continue
    }
    if (block === 'recipient') {
      if (TOTAL_RE.test(line) || /\bdate\b/i.test(line)) { block = 'none'; continue }
      recipientLines++
      if (!recipient.name && plausibleName(line) && !IDENTITY_LINE.test(line)) { recipient.name = clean(line).slice(0, 160); continue }
      identities(line, recipient, true)
      if (!recipient.address && ADDRESS_LINE.test(line) && !IDENTITY_LINE.test(line)) recipient.address = clean(line).slice(0, 240)
    }
  }

  // Who do we invoice? Never ourselves.
  const issuerIsUs = isUs(issuer, us)
  const recipientIsUs = isUs(recipient, us) || (supplierNamed !== null && isUs(supplierNamed, us) && !issuerIsUs)
  if (issuerIsUs || (!recipientIsUs && recipient.name && result.document_type !== 'purchase_order')) {
    result.client = recipient
  } else {
    result.client = issuer
  }
  result.issuer = issuer
  if (result.client.name && isUs(result.client, us)) result.client = emptyParty()

  // Dates and terms.
  for (const line of lines) {
    if (!line) continue
    const date = parseDate(line)
    if (/[ée]ch[ée]ance|payable\s+(?:avant|le|au\s+plus\s+tard)|date\s+limite|due\s+date|[àa]\s+r[ée]gler\s+avant/i.test(line)) {
      if (date && !result.due_date) result.due_date = date
    } else if (date && !result.issue_date && /\bdate\b|\b(?:[ée]mis|[ée]tabli)e?\s+le\b|\ble\s+\d/i.test(line)) {
      result.issue_date = date
    }
    const terms = /d[ée]lai\s+de\s+paiement\s*[:\-]?\s*(\d{1,3})\s*jours?|paiement\s+[àa]\s+(\d{1,3})\s*jours?|(\d{1,3})\s*jours?\s+(?:fin\s+de\s+mois|net|date\s+de\s+facture)/i.exec(line)
    if (terms && result.payment_terms_days === null) result.payment_terms_days = Math.min(365, Number(terms[1] ?? terms[2] ?? terms[3]))
  }
  if (!result.issue_date) result.issue_date = lines.map(l => (l && !/[ée]ch[ée]ance/i.test(l) ? parseDate(l) : null)).find(Boolean) ?? null

  // Currency: the most frequent marker.
  const usd = (text.match(/\bUSD\b|US\s?\$|\$\s?\d|\d\s?\$|\bdollars?\b/gi) ?? []).length
  const cdf = (text.match(/\bCDF\b|\bF\.?C\.?\b|\bFc\b|francs?\s+congolais/gi) ?? []).length
  result.currency = usd === 0 && cdf === 0 ? null : usd >= cdf ? 'USD' : 'CDF'

  // Lines, then totals.
  result.lines = readItems(lines)
  for (const line of lines) {
    if (!line || !TOTAL_RE.test(line)) continue
    if (VAT_RE.test(line) && !SUBTOTAL_RE.test(line) && !GRAND_TOTAL_RE.test(line)) {
      const rate = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(line)
      if (rate && !result.vat_rate_percent) result.vat_rate_percent = rate[1]!.replace(',', '.').replace(/\.0+$/, '')
      const amount = lastAmount(line)
      if (amount && !result.vat_amount) result.vat_amount = amount
      continue
    }
    const amount = lastAmount(line)
    if (!amount) continue
    if (SUBTOTAL_RE.test(line)) result.subtotal ??= amount
    else if (DISCOUNT_RE.test(line)) result.discount ??= amount
    else if (GRAND_TOTAL_RE.test(line)) result.total = amount
    else if (PLAIN_TOTAL_RE.test(line) && !result.total) result.total = amount
  }
  if (lines.some(l => l && VAT_EXEMPT_RE.test(l))) result.vat_exempt = true
  if (result.vat_rate_percent || result.vat_amount) result.vat_exempt ??= false

  // Notes: remarks and conditions, never instructions.
  const notes = lines.filter(l => l && /^(?:observations?|remarques?|notes?|commentaires?|conditions?)\b/i.test(l)).map(clean)
  result.notes = notes.length ? notes.join(' · ').slice(0, 1000) : null
  result.lines = result.lines.filter(l => ExtractedLine.safeParse(l).success)
  return ExtractedInvoice.parse(result)
}

/** Last money amount of a totals line ("Total TTC | 2 429,04 USD" → "2429.04"); percentages are skipped. */
function lastAmount(line: string): string | null {
  const stripped = line.replace(CURRENCY_WORDS, ' ').replace(/(\d)\s*%/g, '$1%')
  const list = atoms(stripped).filter(a => stripped[a.end] !== '%' && !/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/.test(stripped.slice(Math.max(0, a.start - 6), a.end + 6)))
  if (list.length === 0) return null
  // Glue from the right: "2 429,04" → 2429.04.
  let start = list.length - 1
  while (start > 0) {
    const prev = list[start - 1]!
    const curAtom = list[start]!
    if (!/^[   ]$/.test(stripped.slice(prev.end, curAtom.start)) || /[.,]/.test(prev.text) || !/^\d{3}(?:[.,]\d+)?$/.test(curAtom.text) || prev.text.length > 3) break
    start--
  }
  return parseDecimal(list.slice(start).map(a => a.text).join(' '), 2)
}

interface Columns { desc: number; qty: number; unit: number; price: number; amount: number }

function readItems(lines: string[]): ExtractedLine[] {
  const items: ExtractedLine[] = []
  let columns: Columns | null = null
  let inTable = false
  for (const line of lines) {
    if (!line) continue
    const cells = line.includes(' | ') ? line.split(' | ').map(c => c.trim()) : null
    // Header row: "Désignation | Qté | Unité | P.U. | Montant" (or the same words without separators, from OCR).
    if (HEADER_DESC.test(line) && (HEADER_AMOUNT.test(line) || /qt[ée]|quantit/i.test(line)) && !TOTAL_RE.test(line.replace(HEADER_AMOUNT, ''))) {
      inTable = true
      columns = cells ? mapColumns(cells) : null
      continue
    }
    if (TOTAL_RE.test(line) && (/\d/.test(line))) { if (inTable) inTable = false; continue }
    if (cells && columns) {
      const item = fromCells(cells, columns)
      if (item) { items.push(item); continue }
    }
    const item = fromText(line, inTable)
    if (item) items.push(item)
  }
  return items.slice(0, 200)
}

function mapColumns(cells: string[]): Columns | null {
  const find = (re: RegExp, skip: number[] = []) => cells.findIndex((c, i) => !skip.includes(i) && re.test(c))
  const desc = find(HEADER_DESC)
  const price = find(HEADER_PRICE, [desc])
  const qty = find(HEADER_QTY, [desc, price])
  const unit = find(HEADER_UNIT, [desc, price, qty])
  const amount = find(HEADER_AMOUNT, [desc, price, qty, unit])
  if (desc < 0 || (qty < 0 && price < 0 && amount < 0)) return null
  return { desc, qty, unit, price, amount }
}

function fromCells(cells: string[], c: Columns): ExtractedLine | null {
  const description = clean(cells[c.desc] ?? '')
  if (description.length < 2 || letterRatio(description) < 0.4) return null
  const num = (i: number, d: 2 | 3) => (i >= 0 && cells[i] !== undefined ? parseDecimal(cells[i]!.replace(CURRENCY_WORDS, '').trim(), d) : null)
  const quantity = num(c.qty, 3)
  const unitPrice = num(c.price, 2)
  const amount = num(c.amount, 2)
  if (quantity === null && unitPrice === null && amount === null) return null
  const unitCell = c.unit >= 0 ? clean(cells[c.unit] ?? '') : ''
  return { description: description.slice(0, 300), quantity, unit: unitCell && unitCell.length <= 30 ? unitCell : null, unit_price: unitPrice, amount }
}

/** "Sable lavé 25 18,00 450,00", "Gardiennage : 60 x 25,00 = 1 500,00 USD". */
function fromText(line: string, inTable: boolean): ExtractedLine | null {
  if (TOTAL_RE.test(line) || /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{4}\b/.test(line)) return null
  const stripped = line.replace(/^[\s\-–•*·]+/, '')
  const list = atoms(stripped)
  if (list.length < 2) return null
  const explicit = /[x×=]/i.test(stripped.replace(/[A-Za-zÀ-ÿ]{2,}/g, ' '))
  for (const [q, p, a] of triples(stripped, list)) {
    if (Number(q.value) <= 0 || Number(p.value) <= 0) continue
    if (!/[.,]\d{2}$/.test(a.written) && !inTable && !explicit) continue
    if (!close(Number(q.value) * Number(p.value), Number(a.value))) continue
    if (!separatorOk(stripped.slice(q.end, p.start)) || !separatorOk(stripped.slice(p.end, a.start))) continue
    const unit = stripped.slice(q.end, p.start).split(/[\s|x×*=:@]+/).find(w => UNIT_RE.test(w)) ?? null
    const description = clean(stripped.slice(0, q.start))
    if (description.length < 2 || letterRatio(description) < 0.4) continue
    return { description: description.slice(0, 300), quantity: q.value, unit, unit_price: p.value, amount: a.value }
  }
  if (!inTable) return null
  // Inside a table without a reliable product: "Carburant 300,00" → 1 × 300,00.
  const last = list[list.length - 1]!
  const amount = parseDecimal(last.text, 2)
  const description = clean(stripped.slice(0, list[0]!.start))
  if (!amount || !/[.,]\d{2}$/.test(last.text) || description.length < 2 || letterRatio(description) < 0.5) return null
  return { description: description.slice(0, 300), quantity: '1', unit: null, unit_price: amount, amount }
}

function separatorOk(between: string): boolean {
  const rest = between.replace(CURRENCY_WORDS, ' ').split(/[\s]+/).filter(w => w && !UNIT_RE.test(w)).join('')
  return /^[|x×*=:@àa/]*$/i.test(rest) && rest.length <= 3
}
