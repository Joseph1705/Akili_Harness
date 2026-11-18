/**
 * Pseudonymisation before any text leaves for an external model provider (directive 4.6, rule 5):
 * the organization's own identity, its clients, its people, tax ids (NIF, RCCM, Id. Nat.), e-mails,
 * phone numbers, bank accounts and company names are replaced by tokens such as [CLIENT_1] or [NIF_2];
 * the tokens are put back in the answer here, on our side. The table never leaves this process.
 *
 * This is pseudonymisation, not anonymisation: a person's name that appears in a document without
 * being known to the organization can still go through. It is presented as such, never as a guarantee.
 */
import type { Db } from '../db.js'

export interface Pseudonymizer {
  mask(text: string): string
  unmask(text: string): string
  maskDeep<T>(value: T): T
  unmaskDeep<T>(value: T): T
  /** Number of distinct values replaced so far. */
  readonly size: number
}

interface Term { value: string; kind: string }

const DETECTORS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'EMAIL', re: /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,180}\.[A-Z]{2,}/gi },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g },
  { kind: 'COMPTE', re: /\b\d{3,6}(?:[ -]\d{3,8}){2,5}\b(?=[^%]|$)/g },
  { kind: 'RCCM', re: /\b[A-Z]{2}\/[A-Z]{2,4}\/RCCM\/[0-9A-Z-]{4,20}\b/g },
  { kind: 'IDNAT', re: /\b\d{1,2}-[A-Z0-9]{2,6}-[A-Z]\d{4,6}[A-Z]?\b/g },
  { kind: 'NIF', re: /\b[A-Z][0-9OIL]{7}[A-Z]\b/g },
  { kind: 'TEL', re: /(?:\+243|\b0)[\s.-]?\d{2,3}(?:[\s.-]?\d{2,3}){2,3}\b/g },
  // Company names: "Bakwanga Mining SARL", "Ets Kasongo et Fils".
  { kind: 'SOCIETE', re: /\b(?:[A-ZÀ-Ý][\p{L}'’&.-]*\s+){0,4}[A-ZÀ-Ý][\p{L}'’&.-]*\s+(?:SARLU|SARL|SAS|SAU|SPRL|SA|Ltd|LLC|Inc)\b|\b(?:Ets|ETS|Établissements|Etablissements)\s+(?:[A-ZÀ-Ý][\p{L}'’&.-]*\s*){1,4}/gu },
]

/** A digit run that is really an amount ("1 350 000,00") must survive: accounts are long and grouped differently. */
function looksLikeAmount(value: string): boolean {
  return /^\d{1,3}(?: \d{3})+$/.test(value) && value.replace(/\D/g, '').length <= 12
}

export function createPseudonymizer(terms: Term[]): Pseudonymizer {
  const tokenOf = new Map<string, string>()
  const valueOf = new Map<string, string>()
  const counters = new Map<string, number>()
  const tokenFor = (kind: string, value: string) => {
    const key = value.trim()
    const found = tokenOf.get(key.toLowerCase())
    if (found) return found
    const n = (counters.get(kind) ?? 0) + 1
    counters.set(kind, n)
    const token = kind === 'ENTREPRISE' ? '[ENTREPRISE]' : `[${kind}_${n}]`
    tokenOf.set(key.toLowerCase(), token)
    valueOf.set(token, key)
    return token
  }
  // Longest first, so "Kibala Services SARL" is replaced before "Kibala Services".
  const known = terms.filter(t => t.value && t.value.trim().length >= 3).sort((a, b) => b.value.length - a.value.length)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const knownRe = known.length ? new RegExp(known.map(t => escape(t.value.trim())).join('|'), 'gi') : null
  const kindOf = new Map(known.map(t => [t.value.trim().toLowerCase(), t.kind]))

  const mask = (text: string): string => {
    if (!text) return text
    let out = knownRe ? text.replace(knownRe, m => tokenFor(kindOf.get(m.toLowerCase()) ?? 'TERME', m)) : text
    for (const { kind, re } of DETECTORS) {
      out = out.replace(re, (m: string) => (kind === 'COMPTE' && looksLikeAmount(m)) || /^\[[A-Z]+(?:_\d+)?\]$/.test(m) ? m : tokenFor(kind, m))
    }
    return out
  }
  const unmask = (text: string): string => (text ? text.replace(/\[(?:ENTREPRISE|[A-Z]+_\d+)\]/g, t => valueOf.get(t) ?? t) : text)
  const deep = <T>(value: T, fn: (s: string) => string): T => {
    if (typeof value === 'string') return fn(value) as T
    if (Array.isArray(value)) return value.map(v => deep(v, fn)) as T
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, fn)])) as T
    return value
  }
  return {
    mask, unmask,
    maskDeep: v => deep(v, mask),
    unmaskDeep: v => deep(v, unmask),
    get size() { return valueOf.size },
  }
}

/** Everything the organization knows that identifies it, its clients and its people. */
export async function pseudonymizerFor(db: Db, orgId: string): Promise<Pseudonymizer> {
  const terms: Term[] = []
  const org = await db.get<{ name: string; nif: string | null; rccm: string | null; id_nat: string | null; address: string | null; bank_details: string | null }>(
    'SELECT name, nif, rccm, id_nat, address, bank_details FROM organizations WHERE id = ?', orgId)
  if (org) {
    terms.push({ value: org.name, kind: 'ENTREPRISE' })
    const short = org.name.replace(/\s*\((?:fictif|fictive)\)\s*/i, '').replace(/\s+(?:SARLU|SARL|SAS|SAU|SPRL|SA)$/i, '').trim()
    if (short.length >= 4 && short !== org.name) terms.push({ value: short, kind: 'ENTREPRISE' })
    for (const [v, k] of [[org.nif, 'NIF'], [org.rccm, 'RCCM'], [org.id_nat, 'IDNAT'], [org.address, 'ADRESSE']] as const) if (v) terms.push({ value: v, kind: k })
  }
  const clients = await db.all<{ name: string; nif: string | null; rccm: string | null; email: string | null; address: string | null }>(
    'SELECT name, nif, rccm, email, address FROM clients WHERE org_id = ?', orgId)
  for (const c of clients) {
    terms.push({ value: c.name, kind: 'CLIENT' })
    const short = c.name.replace(/\s*\((?:fictif|fictive)\)\s*/i, '').replace(/\s+(?:SARLU|SARL|SAS|SAU|SPRL|SA)$/i, '').trim()
    if (short.length >= 4 && short !== c.name) terms.push({ value: short, kind: 'CLIENT' })
    for (const [v, k] of [[c.nif, 'NIF'], [c.rccm, 'RCCM'], [c.email, 'EMAIL'], [c.address, 'ADRESSE']] as const) if (v) terms.push({ value: v, kind: k })
  }
  const people = await db.all<{ email: string; first_name: string | null; last_name: string | null; phone: string | null }>(
    'SELECT u.email, u.first_name, u.last_name, u.phone FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?', orgId)
  for (const p of people) {
    terms.push({ value: p.email, kind: 'EMAIL' })
    const full = [p.first_name, p.last_name].filter(Boolean).join(' ')
    if (full.length >= 4) terms.push({ value: full, kind: 'PERSONNE' })
    if (p.last_name && p.last_name.length >= 4) terms.push({ value: p.last_name, kind: 'PERSONNE' })
    if (p.phone) terms.push({ value: p.phone, kind: 'TEL' })
  }
  return createPseudonymizer(terms)
}
