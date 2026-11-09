/** One report → extraction → duplicate check → credit → draft invoice. Writes the agent's steps to its session transcript. */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { audit } from '../audit.js'
import { consume } from '../credits.js'
import { now } from '../db.js'
import { formatMoney } from '../invoicing/compute.js'
import { clientById, contractByPo } from '../invoicing/clients.js'
import { buildDraft, type OrgTaxProfile } from '../invoicing/draft.js'
import { nextNumber } from '../invoicing/numbering.js'
import { addEvent } from '../sessions/events.js'
import { getBlob } from '../storage/blobs.js'
import type { FileKind } from '../storage/sniff.js'
import type { JobOutcome } from '../jobs.js'
import { extractText } from './extract.js'
import { parseReport, ReportParseError, type ActivityReport } from './parse-report.js'

interface DocRow { id: string; org_id: string; agent_id: string; blob_id: string; filename: string; kind: FileKind; status: string; extracted: string | null; session_id?: string | null }

export async function processDocument(app: FastifyInstance, orgId: string, documentId: string): Promise<JobOutcome> {
  const { db, config } = app.deps
  const doc = db.prepare('SELECT d.*, (SELECT session_id FROM document_sessions s WHERE s.document_id = d.id) AS session_id FROM documents d WHERE d.id = ? AND d.org_id = ?').get(documentId, orgId) as DocRow | undefined
  if (!doc || doc.status === 'done' || doc.status === 'duplicate' || doc.status === 'failed') return 'done'
  const step = (name: string, arg: string, out: string) => { if (doc.session_id) addEvent(db, orgId, doc.session_id, 'tool', { name, arg, out }) }
  const say = (text: string) => { if (doc.session_id) addEvent(db, orgId, doc.session_id, 'agent', { text }) }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    const keys = Object.keys(extra)
    db.prepare(`UPDATE documents SET status = ?, processed_at = ?${keys.map(k => `, ${k} = ?`).join('')} WHERE id = ? AND org_id = ?`)
      .run(status, now(), ...keys.map(k => extra[k] as string | null), documentId, orgId)
  }

  db.prepare("UPDATE documents SET status = 'processing' WHERE id = ? AND org_id = ?").run(documentId, orgId)

  // 1. Read.
  let report: ActivityReport
  if (doc.extracted) {
    report = JSON.parse(doc.extracted) as ActivityReport
  } else {
    try {
      const { bytes } = getBlob(db, config, orgId, doc.blob_id)
      report = parseReport(await extractText(bytes, doc.kind))
    } catch (error) {
      const message = error instanceof ReportParseError ? error.message : 'Fichier illisible.'
      setStatus('failed', { error: message })
      step('Lire', doc.filename, `échec — ${message}`)
      return 'done'
    }
    db.prepare('UPDATE documents SET extracted = ?, report_number = ? WHERE id = ? AND org_id = ?').run(JSON.stringify(report), report.number, documentId, orgId)
    step('Lire', doc.filename, `rapport ${report.number} · ${report.lines.length} ligne${report.lines.length > 1 ? 's' : ''} · ${report.po}`)
  }

  // 2. Same report already processed?
  const twin = db.prepare(`SELECT id, filename FROM documents WHERE org_id = ? AND report_number = ? AND id != ? AND status IN ('done','processing','waiting_credits') AND created_at <= (SELECT created_at FROM documents WHERE id = ?) LIMIT 1`)
    .get(orgId, report.number, documentId, documentId) as { id: string; filename: string } | undefined
  if (twin) {
    setStatus('duplicate', { error: `Rapport ${report.number} déjà traité (${twin.filename}).` })
    say(`Le rapport ${report.number} a déjà été traité : aucun crédit consommé.`)
    return 'done'
  }

  // 3. Contract.
  const contract = contractByPo(db, orgId, report.po)
  const client = contract && clientById(db, orgId, contract.client_id)
  if (!contract || !client) {
    setStatus('failed', { error: `Bon de commande ${report.po} inconnu : ajoutez le contrat correspondant.` })
    step('Rapprocher', `${report.po} ↔ contrats`, 'aucun contrat trouvé')
    return 'done'
  }
  step('Rapprocher', `${report.po} ↔ ${contract.reference}`, `${client.name}`)

  // 4. One credit for this document (founder decision: 1 credit = 1 document).
  if (!consume(db, orgId, documentId)) {
    setStatus('waiting_credits')
    say('Crédits épuisés : ce rapport sera traité dès la prochaine recharge.')
    return 'waiting_credits'
  }

  // 5. Draft invoice, every number computed by code.
  const org = db.prepare('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?').get(orgId) as unknown as OrgTaxProfile
  const draft = buildDraft(report, contract, client, org)
  const issue = new Date()
  const due = new Date(issue.getTime() + contract.payment_terms_days * 86400_000)
  const invoiceId = randomUUID()
  const number = nextNumber(db, orgId, issue.getFullYear(), 'P')
  db.tx(() => {
    db.prepare(`INSERT INTO invoices (id, org_id, document_id, agent_id, client_id, contract_id, number, status, currency, lines,
      subtotal_cents, vat_rate_bp, vat_cents, total_cents, issue_date, due_date, po_number, period, checks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(invoiceId, orgId, documentId, doc.agent_id, client.id, contract.id, number, contract.currency, JSON.stringify(draft.lines),
        draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, issue.toISOString().slice(0, 10), due.toISOString().slice(0, 10),
        contract.po_number, report.period ?? null, JSON.stringify(draft.checks), now())
    setStatus('done', { invoice_id: invoiceId, error: null })
    db.prepare('UPDATE agents SET last_action_at = ? WHERE id = ? AND org_id = ?').run(now(), doc.agent_id, orgId)
  })
  const warnings = draft.checks.filter(c => c.status === 'warning' || c.status === 'error')
  step('Calculer', `${draft.lines.length} ligne${draft.lines.length > 1 ? 's' : ''} · TVA ${draft.vatRateBp / 100} %`, `${formatMoney(draft.totalCents)} ${contract.currency} TTC`)
  step('Préparer', number, warnings.length ? `${warnings.length} point${warnings.length > 1 ? 's' : ''} à vérifier` : 'tous les contrôles sont passés')
  say(`Projet de facture ${number} prêt pour ${client.name} : ${formatMoney(draft.totalCents)} ${contract.currency} TTC. Il attend votre validation.`)
  audit(db, { orgId, userId: null }, 'invoice.drafted', 'invoice', invoiceId, { document: documentId, agent: doc.agent_id })
  return 'done'
}
