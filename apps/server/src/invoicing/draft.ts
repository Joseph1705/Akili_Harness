/**
 * Builds a draft invoice from an activity report and a contract. Every amount and every check is
 * computed here, by code (rule 6). Report text is data: remarks are never read as instructions (rule 9).
 */
import type { ActivityReport } from '../documents/parse-report.js'
import { suspiciousInstructions } from '../documents/parse-report.js'
import type { Client, Contract } from './clients.js'
import { computeInvoice, formatMoney, formatQty, parseMoney, parseQty } from './compute.js'
import { VAT_STANDARD_BP } from './tax.js'

export type CheckStatus = 'ok' | 'warning' | 'error' | 'info'
export interface Check { id: string; status: CheckStatus; title: string; note: string }

export interface InvoiceLine {
  code: string; label: string; unit: string; qty: string; qty_milli: number; unit_cents: number; amount_cents: number
}

export interface OrgTaxProfile { nif: string | null; rccm: string | null; vat_status: 'yes' | 'no' | 'unknown' }

export interface Draft {
  lines: InvoiceLine[]
  subtotalCents: number
  vatRateBp: number
  vatCents: number
  totalCents: number
  checks: Check[]
}

const NIF_FORMAT = /^[A-Z]\d{7}[A-Z]$/

/** `quantities` overrides report quantities by line code (human corrections). */
export function buildDraft(report: ActivityReport, contract: Contract, client: Client, org: OrgTaxProfile, quantities: Record<string, string> = {}): Draft {
  const checks: Check[] = []
  const rates = new Map(contract.rates.map(r => [r.code, r]))
  const priced = report.lines.filter(l => rates.has(l.code))
  const unknown = report.lines.filter(l => !rates.has(l.code))

  const lines = priced.map(l => {
    const rate = rates.get(l.code)!
    const qty = quantities[l.code] ?? l.qty
    return { code: l.code, label: l.label, unit: l.unit, qty, qty_milli: parseQty(qty), unit_cents: parseMoney(rate.unit_price), amount_cents: 0 }
  })
  const vatApplies = client.vat_applicable === 1 && org.vat_status !== 'no'
  const vatRateBp = vatApplies ? VAT_STANDARD_BP : 0
  const totals = computeInvoice(lines.map(l => ({ qtyMilli: l.qty_milli, unitCents: l.unit_cents })), vatRateBp)
  lines.forEach((l, i) => { l.amount_cents = totals.lineCents[i]! })

  // 1. The client named in the report is the contract's client.
  const sameClient = normalize(report.client).includes(normalize(client.name)) || normalize(client.name).includes(normalize(report.client))
  checks.push(sameClient
    ? { id: 'client', status: 'ok', title: 'Client identifié', note: `${client.name} — contrat ${contract.reference}` }
    : { id: 'client', status: 'error', title: 'Client différent du contrat', note: `Le rapport cite « ${report.client} », le bon de commande ${contract.po_number} appartient à ${client.name}.` })

  // 2. Client tax id.
  checks.push(client.nif && NIF_FORMAT.test(client.nif)
    ? { id: 'nif', status: 'ok', title: 'NIF du client valide', note: 'Conforme au registre de vos clients' }
    : { id: 'nif', status: 'warning', title: 'NIF du client à vérifier', note: client.nif ? `Format inattendu : ${client.nif}` : 'Aucun NIF enregistré pour ce client' })

  // 3. Every line priced from the contract.
  checks.push(unknown.length === 0
    ? { id: 'rates', status: 'ok', title: `Montants conformes au ${contract.po_number}`, note: `${priced.length} ligne${priced.length > 1 ? 's' : ''} sur ${report.lines.length} au tarif du contrat` }
    : { id: 'rates', status: 'warning', title: 'Ligne hors contrat non facturée', note: unknown.map(l => `${l.code} (${l.label}, ${l.qty.replace('.', ',')} ${l.unit})`).join(' ; ') + ' : absente de la grille tarifaire, à traiter par avenant ou facture séparée.' })

  // 4. Quantities within the contract ceilings.
  const over = lines.filter(l => { const max = rates.get(l.code)!.max_qty; return max !== undefined && l.qty_milli > parseQty(max) })
  checks.push(over.length === 0
    ? { id: 'quantities', status: 'ok', title: 'Quantités dans les plafonds', note: 'Aucune quantité au-delà du contrat' }
    : { id: 'quantities', status: 'warning', title: 'Quantité au-delà du plafond', note: over.map(l => `${l.code} : ${formatQty(l.qty_milli)} ${l.unit} pour un plafond de ${rates.get(l.code)!.max_qty} ${l.unit}`).join(' ; ') })

  // 5. VAT.
  checks.push(vatApplies
    ? { id: 'vat', status: org.vat_status === 'unknown' ? 'warning' : 'ok', title: 'TVA 16 % correctement appliquée', note: org.vat_status === 'unknown' ? `${formatMoney(totals.vatCents)} ${contract.currency} — confirmez que votre entreprise est assujettie à la TVA` : `${formatMoney(totals.vatCents)} ${contract.currency}` }
    : { id: 'vat', status: 'info', title: 'TVA non appliquée', note: client.vat_applicable === 0 ? 'Client exonéré selon votre fiche client — à confirmer par votre expert-comptable' : 'Votre entreprise est déclarée non assujettie' })

  // 6. Payment term from the contract.
  checks.push({ id: 'due', status: 'ok', title: 'Échéance selon le contrat', note: `${contract.payment_terms_days} jours (contrat ${contract.reference})` })

  // 7. Instructions hidden in the document.
  if (suspiciousInstructions([report.remarks ?? '', ...report.lines.map(l => l.label)].join('\n'))) {
    checks.push({ id: 'instructions', status: 'warning', title: 'Instructions ignorées', note: "Le document contient des consignes adressées à l'agent. Elles ont été ignorées : les montants viennent uniquement du contrat." })
  }

  // 8. Our own identity, required before any official document (directive 5.2).
  if (!org.nif || !org.rccm) {
    checks.push({ id: 'identity', status: 'warning', title: 'Votre NIF ou RCCM manque', note: 'Complétez votre identité fiscale dans les paramètres avant tout envoi.' })
  }

  // 9. Fiscal status (rule 8).
  checks.push({ id: 'fiscal', status: 'info', title: 'Document non fiscal', note: 'Projet de facture. La facture normalisée DGI passe par votre dispositif homologué.' })

  return { lines, subtotalCents: totals.subtotalCents, vatRateBp, vatCents: totals.vatCents, totalCents: totals.totalCents, checks }
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w ]+/g, '').replace(/\b(sarl|sa|sas|sprl|fictif)\b/g, '').replace(/\s+/g, ' ').trim()
}
