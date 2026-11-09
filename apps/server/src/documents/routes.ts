/** Report upload and listing. Upload answers at once; processing runs in the background (directive 4.11). */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { now } from '../db.js'
import { badRequest, notFound } from '../errors.js'
import { enqueue } from '../jobs.js'
import { addEvent, createSession } from '../sessions/events.js'
import { getBlob, putBlob, safeFilename } from '../storage/blobs.js'
import { sniff } from '../storage/sniff.js'
import { sha256 } from '../security/crypto.js'

const REPORT_KINDS = new Set(['pdf', 'xlsx', 'csv'])
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf', csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const listQuery = `SELECT d.id, d.filename, d.kind, d.status, d.report_number, d.error, d.invoice_id, d.created_at, d.processed_at,
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
    const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ? AND org_id = ?').get(agentId, org.id) as { id: string; name: string; status: string } | undefined
    if (!agent) throw notFound('Agent')
    if (agent.status !== 'active') throw badRequest(`L'agent « ${agent.name} » est en pause.`)
    if (files.length === 0) throw badRequest('Aucun fichier reçu.')
    const kinds = files.map(f => sniff(f.bytes))
    const refused = files.filter((_, i) => !REPORT_KINDS.has(kinds[i] ?? ''))
    if (refused.length) throw badRequest(`Formats acceptés : PDF, Excel (.xlsx) ou CSV. Refusé : ${refused.map(f => safeFilename(f.filename)).join(', ')}.`)

    let session = sessionId && db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND org_id = ?').get(sessionId, org.id) ? sessionId : undefined
    if (!session) session = createSession(db, org.id, request.user!.id, `${agent.name} — ${files.length} rapport${files.length > 1 ? 's' : ''}`, agent.id)
    addEvent(db, org.id, session, 'user', { text: `Traiter ${files.map(f => safeFilename(f.filename)).join(', ')}` })

    const documents = files.map((file, i) => {
      const kind = kinds[i]!
      const id = randomUUID()
      const twin = db.prepare(`SELECT d.filename, d.blob_id FROM documents d JOIN blobs b ON b.id = d.blob_id AND b.org_id = d.org_id
        WHERE d.org_id = ? AND b.sha256 = ? AND d.status != 'failed' LIMIT 1`).get(org.id, sha256(file.bytes)) as { filename: string; blob_id: string } | undefined
      const blobId = twin?.blob_id ?? putBlob(db, config, org.id, file.bytes, { filename: file.filename, kind: kind as 'pdf' }).id
      const status = twin ? 'duplicate' : 'queued'
      db.tx(() => {
        db.prepare(`INSERT INTO documents (id, org_id, agent_id, blob_id, filename, kind, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, org.id, agent.id, blobId, safeFilename(file.filename), kind, status, twin ? `Fichier identique à ${twin.filename}, déjà reçu.` : null, now())
        db.prepare('INSERT INTO document_sessions (document_id, org_id, session_id) VALUES (?, ?, ?)').run(id, org.id, session!)
        if (!twin) enqueue(db, org.id, 'process_document', id)
      })
      if (twin) addEvent(db, org.id, session!, 'agent', { text: `${safeFilename(file.filename)} est identique à ${twin.filename} : ignoré, aucun crédit consommé.` })
      audit(db, { orgId: org.id, userId: request.user!.id }, 'document.uploaded', 'document', id, { kind, duplicate: Boolean(twin) })
      return { id, filename: safeFilename(file.filename), status }
    })
    return { documents, sessionId: session }
  })

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.string().max(20).optional() }).parse(request.query)
    const rows = status
      ? db.prepare(`${listQuery} WHERE d.org_id = ? AND d.status = ? ORDER BY d.created_at DESC LIMIT 200`).all(org.id, status)
      : db.prepare(`${listQuery} WHERE d.org_id = ? ORDER BY d.created_at DESC LIMIT 200`).all(org.id)
    return { documents: rows }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const doc = db.prepare(`${listQuery} WHERE d.org_id = ? AND d.id = ?`).get(org.id, id)
    if (!doc) throw notFound('Document')
    return { document: doc }
  })

  app.get('/:id/file', async (request, reply) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const doc = db.prepare('SELECT blob_id, filename, kind FROM documents WHERE id = ? AND org_id = ?').get(id, org.id) as { blob_id: string; filename: string; kind: string } | undefined
    if (!doc) throw notFound('Document')
    const { bytes } = getBlob(db, config, org.id, doc.blob_id)
    audit(db, { orgId: org.id, userId: request.user!.id }, 'document.downloaded', 'document', id)
    return reply.header('content-type', CONTENT_TYPES[doc.kind] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store')
      .send(bytes)
  })
}
