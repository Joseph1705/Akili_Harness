/**
 * One document, in the background (directive 4.11):
 *   - no credit left → the document waits (nothing is read, nothing is charged) until credits are bought;
 *   - read it (text, tables, OCR for scans and photos) — the text is data, never instructions (rule 9);
 *   - an activity report with a known purchase order → draft invoice priced from the contract, and its
 *     one credit, in one transaction;
 *   - any other business document → invoice fields proposed for a person to review; the credit is charged
 *     only when that person generates the invoice (documents/routes.ts).
 * Failures (unreadable file, failed OCR, nothing to invoice) never cost a credit (DIRECTIVES §5 B).
 * Each step is written to the agent's session transcript.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { audit } from '../audit.js'
import { applyCredit, balanceOf, InsufficientCredits } from '../billing/wallet.js'
import { formatMoney } from '../invoicing/compute.js'
import { clientById, contractByPo } from '../invoicing/clients.js'
import { buildDraft, type OrgTaxProfile } from '../invoicing/draft.js'
import { nextNumber } from '../invoicing/numbering.js'
import { addEvent } from '../sessions/events.js'
import { getBlob } from '../storage/blobs.js'
import { KIND_LABEL, type FileKind } from '../storage/sniff.js'
import type { JobOutcome } from '../jobs.js'
import { readDocument, UnreadableDocument, type ReadResult } from './extract.js'
import { extractInvoiceFields, type ExtractedInvoice, type OrgIdentity } from './invoice-fields.js'
import { parseReport, ReportParseError, type ActivityReport } from './parse-report.js'
import { extractWithModel } from '../ai/extract.js'

interface DocRow {
  id: string; org_id: string; agent_id: string; blob_id: string; filename: string; kind: FileKind; status: string
  extracted: ActivityReport | null; extracted_invoice: ExtractedInvoice | null; created_at: string; session_id: string | null
}

export async function orgIdentity(app: FastifyInstance, orgId: string): Promise<OrgIdentity> {
  return (await app.deps.db.get<OrgIdentity>('SELECT name, nif, rccm, currency FROM organizations WHERE id = ?', orgId))!
}

export async function processDocument(app: FastifyInstance, orgId: string, documentId: string): Promise<JobOutcome> {
  const { db, config } = app.deps
  const doc = await db.get<DocRow>(`SELECT d.*, s.session_id FROM documents d LEFT JOIN document_sessions s ON s.document_id = d.id
    WHERE d.id = ? AND d.org_id = ?`, documentId, orgId)
  if (!doc || !['queued', 'processing', 'waiting_credits'].includes(doc.status)) return 'done'
  const step = (name: string, arg: string, out: string) => doc.session_id ? addEvent(db, orgId, doc.session_id, 'tool', { name, arg, out }) : Promise.resolve()
  const say = (text: string) => doc.session_id ? addEvent(db, orgId, doc.session_id, 'agent', { text }) : Promise.resolve()
  const finish = (status: string, error: string | null = null) =>
    db.run('UPDATE documents SET status = ?, error = ?, processed_at = now() WHERE id = ? AND org_id = ?', status, error, documentId, orgId)

  // 0. No credit: processing does not start (DIRECTIVES §5 H). It resumes after a purchase.
  if (!doc.extracted && await balanceOf(db, orgId) < 1) {
    if (doc.status !== 'waiting_credits') {
      await finish('waiting_credits')
      await say(`Crédits insuffisants (solde : 0) : « ${doc.filename} » sera traité dès que vous aurez rechargé votre compte.`)
    }
    return 'waiting_credits'
  }

  await db.run("UPDATE documents SET status = 'processing' WHERE id = ? AND org_id = ?", documentId, orgId)

  // 1. Read.
  let report: ActivityReport | null = doc.extracted
  if (!report) {
    let read: ReadResult
    try {
      const { bytes } = await getBlob(db, config, orgId, doc.blob_id)
      read = await readDocument(bytes, doc.kind, { ocr: config.ocr.enabled, maxOcrPages: config.ocr.maxPages })
    } catch (error) {
      const message = error instanceof UnreadableDocument ? error.message : 'Fichier illisible.'
      await finish('failed', `${message} Aucun crédit n'a été utilisé.`)
      await step('Lire', doc.filename, `échec — ${message}`)
      return 'done'
    }
    await db.run('UPDATE documents SET ocr_used = ?, ocr_confidence = ?, pages = ? WHERE id = ? AND org_id = ?',
      read.ocrUsed, read.ocrConfidence, read.pages, documentId, orgId)
    try {
      report = parseReport(read.text)
    } catch (error) {
      if (!(error instanceof ReportParseError)) throw error
      return reviewPath(app, doc, read, { step, say, finish })
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
    await finish('failed', `Bon de commande ${report.po} inconnu : ajoutez le contrat correspondant dans Paramètres › Clients et contrats. Aucun crédit n'a été utilisé.`)
    await step('Rapprocher', `${report.po} ↔ contrats`, 'aucun contrat trouvé')
    return 'done'
  }
  await step('Rapprocher', `${report.po} ↔ ${contract.reference}`, client.name)

  // 4. Draft invoice, every number computed by code (rule 6), and its one credit, in ONE transaction:
  // if anything fails, no invoice exists and no credit is spent (DIRECTIVES §5 B).
  const org = (await db.get<OrgTaxProfile>('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?', orgId))!
  const draft = buildDraft(report, contract, client, org)
  const invoiceId = randomUUID()
  let number: string
  try {
    number = await db.tx(async tx => {
      const issue = await tx.get<{ issue: string; due: string; year: number }>(`SELECT current_date::text AS issue, (current_date + ?::int)::text AS due,
        extract(year FROM current_date)::int AS year`, contract.payment_terms_days)
      const n = await nextNumber(tx, orgId, issue!.year, 'P')
      await tx.run(`INSERT INTO invoices (id, org_id, document_id, agent_id, client_id, contract_id, number, status, source, currency, lines,
        subtotal_cents, vat_rate_bp, vat_cents, total_cents, issue_date, due_date, po_number, period, checks)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'report', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceId, orgId, documentId, doc.agent_id, client.id, contract.id, n, contract.currency, JSON.stringify(draft.lines),
      draft.subtotalCents, draft.vatRateBp, draft.vatCents, draft.totalCents, issue!.issue, issue!.due, contract.po_number,
      report.period ?? null, JSON.stringify(draft.checks))
      await tx.run("UPDATE documents SET status = 'done', error = NULL, invoice_id = ?, processed_at = now() WHERE id = ? AND org_id = ?", invoiceId, documentId, orgId)
      await tx.run('UPDATE agents SET last_action_at = now() WHERE id = ? AND org_id = ?', doc.agent_id, orgId)
      await applyCredit(tx, { orgId, type: 'consumption', amount: -1, operationKey: `document:${documentId}`, documentId, invoiceId })
      return n
    })
  } catch (error) {
    if (!(error instanceof InsufficientCredits)) throw error
    await finish('waiting_credits')
    await say(`Crédits épuisés (solde : ${error.balance}) : ce rapport sera traité dès la prochaine recharge.`)
    return 'waiting_credits'
  }
  const warnings = draft.checks.filter(c => c.status === 'warning' || c.status === 'error')
  await step('Calculer', `${draft.lines.length} ligne${draft.lines.length > 1 ? 's' : ''} · TVA ${draft.vatRateBp / 100} %`, `${formatMoney(draft.totalCents)} ${contract.currency} TTC`)
  await step('Préparer', number, warnings.length ? `${warnings.length} point${warnings.length > 1 ? 's' : ''} à vérifier` : 'tous les contrôles sont passés')
  await say(`Projet de facture ${number} prêt pour ${client.name} : ${formatMoney(draft.totalCents)} ${contract.currency} TTC. Il attend votre validation.`)
  await audit(db, { orgId, userId: null }, 'invoice.drafted', 'invoice', invoiceId, { document: documentId, agent: doc.agent_id })
  return 'done'
}

interface Steps {
  step: (name: string, arg: string, out: string) => Promise<void>
  say: (text: string) => Promise<void>
  finish: (status: string, error?: string | null) => Promise<number>
}

/** Any business document: fields proposed for review. No credit yet. */
async function reviewPath(app: FastifyInstance, doc: DocRow, read: ReadResult, { step, say, finish }: Steps): Promise<JobOutcome> {
  const { db } = app.deps
  const orgId = doc.org_id
  const readNote = [KIND_LABEL[doc.kind], read.pages ? `${read.pages} page${read.pages > 1 ? 's' : ''}` : null,
    read.ocrUsed ? `lu par OCR (confiance ${read.ocrConfidence} %)` : null].filter(Boolean).join(' · ')
  await step('Lire', doc.filename, readNote)

  const identity = await orgIdentity(app, orgId)
  // A language model proposes the fields only when the organization enabled it (rule 5); otherwise, or if it
  // fails, the local reading is used. Either way a person reviews before anything is invoiced.
  const viaModel = await extractWithModel(app, orgId, read.text, identity, { documentId: doc.id }).catch(error => {
    app.log.warn({ document: doc.id, err: String(error) }, 'model extraction failed, using local reading')
    return null
  })
  const fields = viaModel?.fields ?? extractInvoiceFields(read.text, identity)
  const method = viaModel?.method ?? 'local'
  const usable = fields.lines.length > 0 || fields.total !== null || fields.subtotal !== null || fields.client.name !== null
  if (!usable) {
    const message = read.ocrUsed
      ? "Le texte de ce document n'a pas pu être lu (image floue, trop petite ou manuscrite). Aucun crédit n'a été utilisé : reprenez une photo nette, ou saisissez la facture à la main."
      : "Aucune information de facturation (client, lignes ou montants) n'a été trouvée dans ce document. Aucun crédit n'a été utilisé."
    await finish('failed', message)
    await say(message)
    return 'done'
  }
  await db.run(`UPDATE documents SET status = 'needs_review', error = NULL, extracted_invoice = ?, extraction_method = ?, processed_at = now()
    WHERE id = ? AND org_id = ?`, JSON.stringify(fields), method, doc.id, orgId)
  await db.run('UPDATE agents SET last_action_at = now() WHERE id = ? AND org_id = ?', doc.agent_id, orgId)
  const total = fields.total ?? fields.subtotal
  await step('Extraire', fields.reference ?? doc.filename,
    `${fields.client.name ?? 'client à préciser'} · ${fields.lines.length} ligne${fields.lines.length > 1 ? 's' : ''}${total ? ` · total lu ${total.replace('.', ',')} ${fields.currency ?? ''}`.trimEnd() : ''}`)
  if (fields.suspicious_instructions) await say("Ce document contient des consignes adressées à l'agent : elles ont été ignorées.")
  await say(`Facture à vérifier : contrôlez les informations lues dans « ${doc.filename} », corrigez-les si besoin, puis générez la facture (1 crédit).`)
  await audit(db, { orgId, userId: null }, 'document.extracted', 'document', doc.id, { method: method, ocr: read.ocrUsed, lines: fields.lines.length })
  return 'done'
}
