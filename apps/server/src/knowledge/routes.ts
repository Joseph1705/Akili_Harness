/** Knowledge base: add, replace (new version), delete, re-index, and test a search. */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { badRequest, notFound } from '../errors.js'
import { enqueue } from '../jobs.js'
import { deleteBlob, putBlob, safeFilename } from '../storage/blobs.js'
import { sniff, type FileKind } from '../storage/sniff.js'
import { hasVectors, searchKnowledge } from './store.js'

const KNOWLEDGE_KINDS = new Set<FileKind>(['pdf', 'docx', 'txt', 'png', 'jpeg', 'webp', 'xlsx', 'csv'])
const Id = z.object({ id: z.string().uuid() })

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  app.get('/', async (request) => {
    const org = orgOf(request)
    return {
      documents: await db.all(`SELECT k.id, k.title, k.filename, k.kind, k.status, k.version, k.chunks, k.embedded, k.embedding_model, k.ocr_used, k.flagged,
        k.error, k.created_at, k.updated_at, u.email AS created_by_email FROM knowledge_documents k LEFT JOIN users u ON u.id = k.created_by
        WHERE k.org_id = ? ORDER BY k.updated_at DESC LIMIT 500`, org.id),
      vectors: await hasVectors(db),
      embeddings: Boolean(config.ai.embeddings),
    }
  })

  /** Upload a document; with `replaceId`, it becomes the new version of an existing one. */
  app.post('/', async (request) => {
    const org = orgOf(request, CAN.configure)
    const fields: Record<string, string> = {}
    let file: { filename: string; bytes: Buffer } | null = null
    for await (const part of request.parts()) {
      if (part.type === 'file') { if (!file) file = { filename: part.filename, bytes: await part.toBuffer() } }
      else fields[part.fieldname] = String(part.value)
    }
    const body = z.object({ title: z.string().trim().max(160).optional(), replaceId: z.string().uuid().optional() }).parse(fields)
    if (!file) throw badRequest('Aucun fichier reçu.')
    const kind = sniff(file.bytes)
    if (!kind || !KNOWLEDGE_KINDS.has(kind)) throw badRequest('Formats acceptés : PDF, Word (.docx), texte, image, Excel ou CSV.')
    const blob = await putBlob(db, config, org.id, file.bytes, { filename: file.filename, kind })
    const title = body.title || safeFilename(file.filename).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ')
    let id: string
    if (body.replaceId) {
      const previous = await db.get<{ blob_id: string | null }>('SELECT blob_id FROM knowledge_documents WHERE id = ? AND org_id = ?', body.replaceId, org.id)
      if (!previous) throw notFound('Document')
      id = body.replaceId
      await db.tx(async tx => {
        await tx.run(`UPDATE knowledge_documents SET blob_id = ?, filename = ?, kind = ?, title = ?, status = 'queued', version = version + 1, error = NULL, updated_at = now()
          WHERE id = ? AND org_id = ?`, blob.id, safeFilename(file!.filename), kind, title, id, org.id)
        await enqueue(tx, org.id, 'ingest_knowledge', id)
      })
      if (previous.blob_id) await deleteBlob(db, config, org.id, previous.blob_id)
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'knowledge.updated', 'knowledge', id)
    } else {
      id = randomUUID()
      await db.tx(async tx => {
        await tx.run(`INSERT INTO knowledge_documents (id, org_id, title, filename, kind, blob_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
          id, org.id, title, safeFilename(file!.filename), kind, blob.id, request.user!.id)
        await enqueue(tx, org.id, 'ingest_knowledge', id)
      })
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'knowledge.added', 'knowledge', id)
    }
    return { document: await db.get('SELECT id, title, filename, kind, status, version FROM knowledge_documents WHERE id = ?', id) }
  })

  app.get('/:id', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const document = await db.get('SELECT * FROM knowledge_documents WHERE id = ? AND org_id = ?', id, org.id)
    if (!document) throw notFound('Document')
    const chunks = await db.all('SELECT ordinal, heading, left(content, 400) AS content FROM knowledge_chunks WHERE document_id = ? AND org_id = ? ORDER BY ordinal LIMIT 200', id, org.id)
    return { document, chunks }
  })

  app.delete('/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const doc = await db.get<{ blob_id: string | null; title: string }>('SELECT blob_id, title FROM knowledge_documents WHERE id = ? AND org_id = ?', id, org.id)
    if (!doc) throw notFound('Document')
    await db.tx(async tx => {
      await tx.run('DELETE FROM knowledge_chunks WHERE document_id = ? AND org_id = ?', id, org.id)
      await tx.run('DELETE FROM knowledge_documents WHERE id = ? AND org_id = ?', id, org.id)
      await tx.run("UPDATE jobs SET status = 'done' WHERE org_id = ? AND ref_id = ? AND type = 'ingest_knowledge' AND status IN ('pending', 'running')", org.id, id)
    })
    if (doc.blob_id) await deleteBlob(db, config, org.id, doc.blob_id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'knowledge.deleted', 'knowledge', id, { title: doc.title })
    return { ok: true }
  })

  /** Re-index (e.g. after enabling embeddings). */
  app.post('/:id/reindex', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const changed = await db.run("UPDATE knowledge_documents SET status = 'queued', updated_at = now() WHERE id = ? AND org_id = ? AND status IN ('ready', 'failed')", id, org.id)
    if (changed === 0) throw notFound('Document')
    await enqueue(db, org.id, 'ingest_knowledge', id)
    return { ok: true }
  })

  /** What an agent would retrieve for this question (sources only, no model call). */
  app.post('/search', async (request) => {
    const org = orgOf(request)
    const { query, k } = z.object({ query: z.string().trim().min(2).max(500), k: z.number().int().min(1).max(10).default(5) }).strict().parse(request.body)
    return { sources: await searchKnowledge(app, org.id, query, k) }
  })
}
