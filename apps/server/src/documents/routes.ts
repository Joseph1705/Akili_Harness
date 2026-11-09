/** Report upload and listing. Upload answers at once; processing runs in the background (directive 4.11). */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { badRequest, notFound } from '../errors.js'
import { enqueue } from '../jobs.js'
import { addEvent, createSession } from '../sessions/events.js'
import { getBlob, putBlob, safeFilename } from '../storage/blobs.js'
import { sniff, type FileKind } from '../storage/sniff.js'
import { sha256 } from '../security/crypto.js'

const REPORT_KINDS = new Set<FileKind>(['pdf', 'xlsx', 'csv'])
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
    const agent = await db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM agents WHERE id = ? AND org_id = ?', agentId, org.id)
    if (!agent) throw notFound('Agent')
    if (agent.status !== 'active') throw badRequest(`L'agent « ${agent.name} » est en pause.`)
    if (files.length === 0) throw badRequest('Aucun fichier reçu.')
    const kinds = files.map(f => sniff(f.bytes))
    const refused = files.filter((_, i) => !kinds[i] || !REPORT_KINDS.has(kinds[i]!))
    if (refused.length) throw badRequest(`Formats acceptés : PDF, Excel (.xlsx) ou CSV. Refusé : ${refused.map(f => safeFilename(f.filename)).join(', ')}.`)

    let session = sessionId && await db.get('SELECT id FROM chat_sessions WHERE id = ? AND org_id = ?', sessionId, org.id) ? sessionId : undefined
    if (!session) session = await createSession(db, org.id, request.user!.id, `${agent.name} — ${files.length} rapport${files.length > 1 ? 's' : ''}`, agent.id)
    await addEvent(db, org.id, session, 'user', { text: `Traiter ${files.map(f => safeFilename(f.filename)).join(', ')}` })

    const documents = []
    for (const [i, file] of files.entries()) {
      const kind = kinds[i]!
      const id = randomUUID()
      const twin = await db.get<{ filename: string; blob_id: string }>(`SELECT d.filename, d.blob_id FROM documents d JOIN blobs b ON b.id = d.blob_id AND b.org_id = d.org_id
        WHERE d.org_id = ? AND b.sha256 = ? AND d.status <> 'failed' LIMIT 1`, org.id, sha256(file.bytes))
      const blobId = twin?.blob_id ?? (await putBlob(db, config, org.id, file.bytes, { filename: file.filename, kind })).id
      const status = twin ? 'duplicate' : 'queued'
      await db.tx(async tx => {
        await tx.run('INSERT INTO documents (id, org_id, agent_id, blob_id, filename, kind, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, org.id, agent.id, blobId, safeFilename(file.filename), kind, status, twin ? `Fichier identique à ${twin.filename}, déjà reçu.` : null)
        await tx.run('INSERT INTO document_sessions (document_id, org_id, session_id) VALUES (?, ?, ?)', id, org.id, session!)
        if (!twin) await enqueue(tx, org.id, 'process_document', id)
      })
      if (twin) await addEvent(db, org.id, session, 'agent', { text: `${safeFilename(file.filename)} est identique à ${twin.filename} : ignoré, aucun crédit consommé.` })
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.uploaded', 'document', id, { kind, duplicate: Boolean(twin) })
      documents.push({ id, filename: safeFilename(file.filename), status })
    }
    return { documents, sessionId: session }
  })

  app.get('/', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.string().max(20).optional() }).parse(request.query)
    return {
      documents: await db.all(`${listQuery} WHERE d.org_id = ? AND (?::text IS NULL OR d.status = ?::text) ORDER BY d.created_at DESC LIMIT 200`, org.id, status ?? null, status ?? null),
    }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const doc = await db.get(`${listQuery} WHERE d.org_id = ? AND d.id = ?`, org.id, id)
    if (!doc) throw notFound('Document')
    return { document: doc }
  })

  app.get('/:id/file', async (request, reply) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const doc = await db.get<{ blob_id: string; filename: string; kind: string }>('SELECT blob_id, filename, kind FROM documents WHERE id = ? AND org_id = ?', id, org.id)
    if (!doc) throw notFound('Document')
    const { bytes } = await getBlob(db, config, org.id, doc.blob_id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'document.downloaded', 'document', id)
    return reply.header('content-type', CONTENT_TYPES[doc.kind] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store')
      .send(bytes)
  })
}
