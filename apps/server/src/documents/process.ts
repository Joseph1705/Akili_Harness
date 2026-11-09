/** One report → extraction → duplicate check → credit → draft invoice. Writes the agent's steps to its session transcript. */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { audit } from '../audit.js'
import { consume } from '../credits.js'
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

interface DocRow { id: string; org_id: string; agent_id: string; blob_id: string; filename: string; kind: FileKind; status: string; extracted: ActivityReport | null; created_at: string; session_id: string | null }

export async function processDocument(app: FastifyInstance, orgId: string, documentId: string): Promise<JobOutcome> {
  const { db, config } = app.deps
  const doc = await db.get<DocRow>(`SELECT d.*, s.session_id FROM documents d LEFT JOIN document_sessions s ON s.document_id = d.id
    WHERE d.id = ? AND d.org_id = ?`, documentId, orgId)
  if (!doc || doc.status === 'done' || doc.status === 'duplicate' || doc.status === 'failed') return 'done'
  const step = (name: string, arg: string, out: string) => doc.session_id ? addEvent(db, orgId, doc.session_id, 'tool', { name, arg, out }) : Promise.resolve()
  const say = (text: string) => doc.session_id ? addEvent(db, orgId, doc.session_id, 'agent', { text }) : Promise.resolve()
  const finish = (status: string, error: string | null = null) =>
    db.run('UPDATE documents SET status = ?, error = ?, processed_at = now() WHERE id = ? AND org_id = ?', status, error, documentId, orgId)

  await db.run("UPDATE documents SET status = 'processing' WHERE id = ? AND org_id = ?", documentId, orgId)

  // 1. Read. The text is data, never instructions (rule 9).
  let report: ActivityReport
  if (doc.extracted) {
    report = doc.extracted
  } else {
    try {
      const { bytes } = await getBlob(db, config, orgId, doc.blob_id)
      report = parseReport(await extractText(bytes, doc.kind))
    } catch (error) {
      const message = error instanceof ReportParseError ? error.message : 'Fichier illisible.'
      await finish('failed', message)
      await step('Lire', doc.filename, `échec — ${message}`)
      return 'done'
    }
    await db.run('UPDATE documents SET extracted = ?, report_number = ? WHERE id = ? AND org_id = ?', JSON.stringify(report), report.number, documentId, orgId)
    await step('Lire', doc.filename, `rapport ${report.number} · ${report.lines.length} ligne${report.lines.length > 1 ? 's' : ''} · ${report.po}`)
  }

  // 2. Same report already received earlier?
  const twin = await db.get<{ filename: string }>(`SELECT filename FROM documents WHERE org_id = ? AND report_number = ? AND id <> ?
    AND status IN ('done', 'processing', 'waiting_credits') AND created_at <= ? LIMIT 1`, orgId, report.number, documentId, doc.created_at)
  if (twin) {
    await finish('duplicate', `Rapport ${report.number} déjà traité (${twin.filename}).`)
    await say(`Le rapport ${report.number} a déjà été traité : aucun crédit consommé.`)
    return 'done'
  }

  // 3. Contract.
  const contract = await contractByPo(db, orgId, report.po)
  const client = contract && await clientById(db, orgId, contract.client_id)
  if (!contract || !client) {
    await finish('failed', `Bon de commande ${report.po} inconnu : ajoutez le contrat correspondant dans Paramètres › Clients et contrats.`)
    await step('Rapprocher', `${report.po} ↔ contrats`, 'aucun contrat trouvé')
    return 'done'
  }
  await step('Rapprocher', `${report.po} ↔ ${contract.reference}`, client.name)

  // 4. One credit for this document (founder decision: 1 credit = 1 document).
  if (!await consume(db, orgId, documentId)) {
    await finish('waiting_credits')
    await say('Crédits épuisés : ce rapport sera traité dès la prochaine recharge.')
    return 'waiting_credits'
  }

  // 5. Draft invoice, every number computed by code (rule 6).
  const org = (await db.get<OrgTaxProfile>('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?', orgId))!
  const draft = buildDraft(report, contract, client, org)
  const invoiceId = randomUUID()
  const number = await db.tx(async tx => {
    const issue = await tx.get<{ issue: string; due: string; year: number }>(`SELECT current_date::text AS issue, (current_date + ?::int)::text AS due,
      extract(year FROM current_date)::int AS year`, contract.payment_terms_days)
    const n = await nextNumber(tx, orgId, issue!.year, 'P')
    await tx.run(`INSERT INTO invoices (id, org_id, document_id, agent_id, client_id, contract_id, number, status, currency, lines,
      subtotal_cents, vat_rate_bp, vat_cents, total_cents, issue_date, due_date, po_number, period, checks)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    invoiceId, orgId, documentId, doc.agent_id, client.id, contract.id, n, contract.currency, JSON.stringify(draft.lines),
    draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, issue!.issue, issue!.due, contract.po_number,
    report.period ?? null, JSON.stringify(draft.checks))
    await tx.run("UPDATE documents SET status = 'done', error = NULL, invoice_id = ?, processed_at = now() WHERE id = ? AND org_id = ?", invoiceId, documentId, orgId)
    await tx.run('UPDATE agents SET last_action_at = now() WHERE id = ? AND org_id = ?', doc.agent_id, orgId)
    return n
  })
  const warnings = draft.checks.filter(c => c.status === 'warning' || c.status === 'error')
  await step('Calculer', `${draft.lines.length} ligne${draft.lines.length > 1 ? 's' : ''} · TVA ${draft.vatRateBp / 100} %`, `${formatMoney(draft.totalCents)} ${contract.currency} TTC`)
  await step('Préparer', number, warnings.length ? `${warnings.length} point${warnings.length > 1 ? 's' : ''} à vérifier` : 'tous les contrôles sont passés')
  await say(`Projet de facture ${number} prêt pour ${client.name} : ${formatMoney(draft.totalCents)} ${contract.currency} TTC. Il attend votre validation.`)
  await audit(db, { orgId, userId: null }, 'invoice.drafted', 'invoice', invoiceId, { document: documentId, agent: doc.agent_id })
  return 'done'
}
