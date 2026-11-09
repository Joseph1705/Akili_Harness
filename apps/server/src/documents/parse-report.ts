/** Activity report parser for the subcontracting report layout (fixtures/README.md). Deterministic: no model involved. */
import { z } from 'zod'

export const ReportLine = z.object({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/),
  label: z.string().min(1).max(200),
  unit: z.string().min(1).max(30),
  /** Decimal with a dot and at most 3 decimals, as written in the report. */
  qty: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
})

export const ActivityReport = z.object({
  number: z.string().min(3).max(40),
  po: z.string().min(2).max(40),
  client: z.string().min(2).max(160),
  provider: z.string().max(160).optional(),
  site: z.string().max(160).optional(),
  period: z.string().max(80).optional(),
  lines: z.array(ReportLine).min(1).max(200),
  remarks: z.string().max(4000).optional(),
})
export type ActivityReport = z.infer<typeof ActivityReport>
export type ReportLine = z.infer<typeof ReportLine>

const FIELDS: Record<string, keyof ActivityReport> = {
  'rapport n°': 'number', 'rapport no': 'number', 'rapport n': 'number',
  'bon de commande': 'po', "donneur d'ordre": 'client', 'client': 'client',
  'prestataire': 'provider', 'site': 'site', 'période': 'period', 'periode': 'period',
  'observations': 'remarks',
}

const LABELS: Record<string, string> = { number: 'Rapport N°', po: 'Bon de commande', client: "Donneur d'ordre", lines: 'lignes de prestations' }

export class ReportParseError extends Error {}

function normalizeQty(raw: string): string {
  return raw.replace(/\s/g, '').replace(',', '.')
}

export function parseReport(text: string): ActivityReport {
  const found: Record<string, unknown> = {}
  const lines: ReportLine[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const cells = line.split(' | ').map(c => c.trim())
    if (cells.length >= 4 && /^[A-Z0-9][A-Z0-9-]{1,19}$/.test(cells[0]!) && /^[\d\s]+([.,]\d+)?$/.test(cells[cells.length - 1]!)) {
      lines.push({ code: cells[0]!, label: cells.slice(1, -2).join(' '), unit: cells[cells.length - 2]!, qty: normalizeQty(cells[cells.length - 1]!) })
      continue
    }
    // "Champ : valeur" (PDF) or "Champ | valeur" (Excel, CSV).
    const match = /^([^:|]{2,30}?)\s*(?::|\|)\s*(.+)$/.exec(line)
    if (!match) continue
    const key = FIELDS[match[1]!.toLowerCase().trim()]
    if (key && found[key] === undefined) found[key] = match[2]!.trim()
  }
  found.lines = lines
  const parsed = ActivityReport.safeParse(found)
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map(i => LABELS[String(i.path[0])] ?? String(i.path[0])))]
    throw new ReportParseError(`Ce document ne ressemble pas à un rapport d'activité : ${missing.join(', ')} manquant ou illisible.`)
  }
  return parsed.data
}

/** Text that tries to instruct the agent (prompt injection). It is never obeyed; it is shown to the human. */
export function suspiciousInstructions(text: string): boolean {
  const t = text.toLowerCase()
  const patterns = [
    /\b(agent|ia|ai|assistant|chatgpt|claude|deepseek)\b.{0,40}\b(ignore|oublie|ne tiens pas compte)/,
    /\bignore[rz]?\b.{0,40}\b(tarif|contrat|règle|regle|instruction|consigne)/,
    /sans (validation|contrôle|controle|vérification|verification)/,
    /\b(envoie|transf[eè]re|paie|vire)\b.{0,30}\b(imm[ée]diatement|tout de suite|sans)/,
    /ignore (all|previous|the above) (instructions|rules)/,
  ]
  return patterns.some(p => p.test(t))
}
