/**
 * Documents: upload (any business document; answered at once, processed in the background, directive 4.11),
 * listing, the review of fields read from a document, and the generation of its invoice — the moment the
 * one credit is charged, atomically with the invoice (DIRECTIVES §4–5).
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { applyCredit, balanceOf } from '../billing/wallet.js'
import { badRequest, HttpError, notFound } from '../errors.js'
import { buildInvoice, InvoiceInput, suggestInvoice } from '../invoicing/build.js'
import { listClients } from '../invoicing/clients.js'
import { resolveClient, taxProfile } from '../invoicing/routes.js'
import { idempotent, insertDraft, loadInvoice, presentInvoice } from '../invoicing/store.js'
import { enqueue } from '../jobs.js'
import { scanWithClamd, ScannerUnavailable } from '../security/antivirus.js'
import { sha256 } from '../security/crypto.js'
import { addEvent, createSession } from '../sessions/events.js'
import { getBlob, putBlob, safeFilename } from '../storage/blobs.js'
import { CONTENT_TYPES, DOCUMENT_KINDS, sniff, type FileKind } from '../storage/sniff.js'
import type { ExtractedInvoice } from './invoice-fields.js'

const Id = z.object({ id: z.string().uuid() })

interface ReviewDoc {
  id: string; org_id: string; agent_id: string; status: string; filename: string; kind: FileKind; extracted_invoice: ExtractedInvoice | null
  ocr_confidence: number | null; ocr_used: boolean; invoice_id: string | null; extraction_method: string | null
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const listQuery = `SELECT d.id, d.filename, d.kind, d.status, d.report_number, d.error, d.invoice_id, d.created_at, d.processed_at,
    d.ocr_used, d.ocr_confidence, d.pages, d.extraction_method, d.size,
    a.name AS agent_name, i.number AS invoice_number, i.status AS invoice_status, i.total_cents, i.currency
    FROM documents d JOIN agents a ON a.id = d.agent_id AND a.org_id = d.org_id
    LEFT JOIN invoices i ON i.id = d.invoice_id AND i.org_id = d.org_id`

  app.post('/', async (request) => {
    const org = orgOf(request, CAN.operate)
    const fields: Record<string, string> = {}
    const files: Array<{ filename: string; bytes: Buffer }> = []
    for await (const part of request.parts()) {
      if (part.type === 'file') files.push({ filename: part.filename, bytes: await part.toBuffer() })
      else fields[part.fieldname] = String(part.value)
    }
    const { agentId, sessionId } = z.object({ agentId: z.string().uuid(), sessionId: z.string().uuid().optional() }).parse(fields)
    const agent = await db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM agents WHERE id = ? AND org_id = ?', agentId, org.id)
    if (!agent) throw notFound('Agent')
    if (agent.status !== 'active') throw badRequest(`L'agent « ${agent.name} » est en pause.`)
    if (files.length === 0) throw badRequest('Aucun fichier reçu.')
    const kinds = files.map(f => sniff(f.bytes))
    const refused = files.filter((_, i) => !kinds[i] || !DOCUMENT_KINDS.has(kinds[i]!))
    if (refused.length) {
      throw badRequest(`Formats acceptés : PDF (texte ou scanné), photo (JPEG, PNG, WebP), Word (.docx), texte, Excel (.xlsx) ou CSV. Refusé : ${refused.map(f => safeFilename(f.filename)).join(', ')}.`)
    }
    // Malware scan before anything is stored (when an antivirus is configured).
    if (config.antivirus) {
      for (const file of files) {
        let result
        try {
          result = await scanWithClamd(file.bytes, config.antivirus.host, config.antivirus.port)
        } catch (error) {
          request.log.error({ err: String(error) }, 'antivirus unavailable')
          throw new HttpError(503, 'antivirus_unavailable', "L'analyse antivirus est momentanément indisponible. Réessayez dans quelques minutes.")
        }
        if (!result.clean) {
          await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.virus_blocked', 'document', safeFilename(file.filename), { signature: result.signature })
          throw badRequest(`Fichier refusé par l'antivirus : ${safeFilename(file.filename)}.`)
        }
      }
    }

    let session = sessionId && await db.get('SELECT id FROM chat_sessions WHERE id = ? AND org_id = ?', sessionId, org.id) ? sessionId : undefined
    if (!session) session = await createSession(db, org.id, request.user!.id, `${agent.name} — ${files.length} document${files.length > 1 ? 's' : ''}`, agent.id)
    await addEvent(db, org.id, session, 'user', { text: `Traiter ${files.map(f => safeFilename(f.filename)).join(', ')}` })

    const documents = []
    for (const [i, file] of files.entries()) {
      const kind = kinds[i]!
      const id = randomUUID()
      const twin = await db.get<{ filename: string; blob_id: string }>(`SELECT d.filename, d.blob_id FROM documents d JOIN blobs b ON b.id = d.blob_id AND b.org_id = d.org_id
        WHERE d.org_id = ? AND b.sha256 = ? AND d.status NOT IN ('failed', 'dismissed') LIMIT 1`, org.id, sha256(file.bytes))
      const blobId = twin?.blob_id ?? (await putBlob(db, config, org.id, file.bytes, { filename: file.filename, kind })).id
      const status = twin ? 'duplicate' : 'queued'
      await db.tx(async tx => {
        await tx.run('INSERT INTO documents (id, org_id, agent_id, blob_id, filename, kind, status, error, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, org.id, agent.id, blobId, safeFilename(file.filename), kind, status, twin ? `Fichier identique à ${twin.filename}, déjà reçu.` : null, file.bytes.length)
        await tx.run('INSERT INTO document_sessions (document_id, org_id, session_id) VALUES (?, ?, ?)', id, org.id, session!)
        if (!twin) await enqueue(tx, org.id, 'process_document', id)
      })
      if (twin) await addEvent(db, org.id, session, 'agent', { text: `${safeFilename(file.filename)} est identique à ${twin.filename} : ignoré, aucun crédit consommé.` })
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.uploaded', 'document', id, { kind, duplicate: Boolean(twin) })
      documents.push({ id, filename: safeFilename(file.filename), status })
    }
    const balance = await balanceOf(db, org.id)
    return { documents, sessionId: session, credits: { balance, waiting: balance < 1 } }
  })

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.string().max(20).optional() }).parse(request.query)
    return {
      documents: await db.all(`${listQuery} WHERE d.org_id = ? AND (?::text IS NULL OR d.status = ?::text) ORDER BY d.created_at DESC LIMIT 200`, org.id, status ?? null, status ?? null),
    }
  })

  /** One document; for a document awaiting review, the proposed invoice and its checks. */
  app.get('/:id', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const doc = await db.get<Record<string, unknown>>(`${listQuery} WHERE d.org_id = ? AND d.id = ?`, org.id, id)
    if (!doc) throw notFound('Document')
    const full = (await db.get<ReviewDoc>('SELECT * FROM documents WHERE id = ? AND org_id = ?', id, org.id))!
    let review = null
    if (full.status === 'needs_review' && full.extracted_invoice) {
      const profile = await db.get<{ nif: string | null; rccm: string | null; vat_status: 'yes' | 'no' | 'unknown'; currency: string }>(
        'SELECT nif, rccm, vat_status, currency FROM organizations WHERE id = ?', org.id)
      const clients = await listClients(db, org.id)
      const suggestion = suggestInvoice(full.extracted_invoice, profile!, clients)
      const clientForChecks = 'id' in suggestion.input.client ? clients.find(c => c.id === (suggestion.input.client as { id: string }).id)! : { name: suggestion.input.client.name, nif: suggestion.input.client.nif ?? null, vat_applicable: suggestion.input.client.vat_applicable }
      let checks: unknown[] = []
      try {
        checks = suggestion.input.lines.length ? buildInvoice(suggestion.input, clientForChecks, profile!, { extracted: full.extracted_invoice, ocrConfidence: full.ocr_confidence }).checks : []
      } catch { checks = [] }
      // The same source document number already invoiced? Shown, not blocked (partial deliveries exist).
      const reference = full.extracted_invoice.reference
      const twin = reference ? await db.get<{ filename: string; number: string | null }>(`SELECT d.filename, i.number FROM documents d LEFT JOIN invoices i ON i.id = d.invoice_id AND i.org_id = d.org_id
        WHERE d.org_id = ? AND d.id <> ? AND d.status IN ('done', 'needs_review') AND d.extracted_invoice->>'reference' = ? LIMIT 1`, org.id, id, reference) : undefined
      review = {
        extracted: full.extracted_invoice, suggestion: suggestion.input, matchedClient: suggestion.matchedClient, checks,
        possibleDuplicate: twin ? { filename: twin.filename, invoice_number: twin.number } : null,
        balance: await balanceOf(db, org.id),
      }
    }
    return { document: doc, review }
  })

  app.get('/:id/file', async (request, reply) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const doc = await db.get<{ blob_id: string; filename: string; kind: FileKind }>('SELECT blob_id, filename, kind FROM documents WHERE id = ? AND org_id = ?', id, org.id)
    if (!doc) throw notFound('Document')
    const { bytes } = await getBlob(db, config, org.id, doc.blob_id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.downloaded', 'document', id)
    return reply.header('content-type', CONTENT_TYPES[doc.kind] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(bytes)
  })

  /**
   * The reviewer confirmed the fields: create the invoice and charge the document's one credit, in ONE
   * transaction. A retry (same Idempotency-Key, or the document already done) returns the same invoice
   * and never charges again. Without credit, nothing is created (402) and the document keeps waiting.
   */
  app.post('/:id/invoice', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = Id.parse(request.params)
    return idempotent(db, org.id, request, async () => {
      const input = InvoiceInput.parse(request.body)
      const invoiceId = await db.tx(async tx => {
        const doc = await tx.get<ReviewDoc>('SELECT * FROM documents WHERE id = ? AND org_id = ? FOR UPDATE', id, org.id)
        if (!doc) throw notFound('Document')
        if (doc.status === 'done' && doc.invoice_id) return doc.invoice_id
        if (doc.status !== 'needs_review') throw new HttpError(409, 'not_reviewable', "Ce document n'attend pas de vérification.")
        const client = await resolveClient(tx, org.id, input.client)
        const built = buildInvoice(input, client, await taxProfile(tx, org.id), { extracted: doc.extracted_invoice, ocrConfidence: doc.ocr_confidence })
        const inv = await insertDraft(tx, {
          orgId: org.id, source: 'document', clientId: client.id, built, currency: input.currency, issueDate: input.issue_date, dueDate: input.due_date,
          reference: input.reference, poNumber: input.po_number, period: input.period, notes: input.notes,
          documentId: doc.id, agentId: doc.agent_id, createdBy: request.user!.id,
        })
        await tx.run("UPDATE documents SET status = 'done', invoice_id = ?, error = NULL WHERE id = ? AND org_id = ?", inv.id, doc.id, org.id)
        await applyCredit(tx, {
          orgId: org.id, type: 'consumption', amount: -1, operationKey: `document:${doc.id}`, documentId: doc.id, invoiceId: inv.id,
          actorUserId: request.user!.id, reason: `Facture ${inv.number} générée depuis ${doc.filename}`,
        })
        await audit(tx, { orgId: org.id, userId: request.user!.id }, 'invoice.generated', 'invoice', inv.id, { document: doc.id, number: inv.number, method: doc.extraction_method })
        return inv.id
      })
      const session = await db.get<{ session_id: string }>('SELECT session_id FROM document_sessions WHERE document_id = ? AND org_id = ?', id, org.id)
      const invoice = await presentInvoice(db, await loadInvoice(db, org.id, invoiceId))
      if (session) await addEvent(db, org.id, session.session_id, 'agent', { text: `Projet de facture ${invoice.number} créé pour ${invoice.client?.name ?? 'le client'} : il attend votre validation. 1 crédit utilisé.` })
      return { invoice, balance: await balanceOf(db, org.id) }
    })
  })

  /** Not to be invoiced (wrong document, already handled elsewhere): no credit. */
  app.post('/:id/dismiss', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = Id.parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).strict().parse(request.body ?? {})
    const changed = await db.run(`UPDATE documents SET status = 'dismissed', error = ? WHERE id = ? AND org_id = ?
      AND status IN ('needs_review', 'failed', 'waiting_credits', 'queued')`, reason ? `Écarté : ${reason}` : 'Écarté par un utilisateur.', id, org.id)
    if (changed === 0) throw new HttpError(409, 'not_dismissable', 'Ce document ne peut plus être écarté.')
    await db.run("UPDATE jobs SET status = 'done' WHERE org_id = ? AND ref_id = ? AND status IN ('pending', 'waiting_credits')", org.id, id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.dismissed', 'document', id)
    return { ok: true }
  })

  /** Read again (after adding a contract, enabling AI, or a failed reading). Still no credit until an invoice exists. */
  app.post('/:id/reprocess', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = Id.parse(request.params)
    const changed = await db.run(`UPDATE documents SET status = 'queued', error = NULL, extracted = NULL, extracted_invoice = NULL, report_number = NULL
      WHERE id = ? AND org_id = ? AND status IN ('failed', 'needs_review')`, id, org.id)
    if (changed === 0) throw new HttpError(409, 'not_reprocessable', 'Seul un document en échec ou à vérifier peut être relu.')
    await enqueue(db, org.id, 'process_document', id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.reprocessed', 'document', id)
    return { ok: true }
  })
}
