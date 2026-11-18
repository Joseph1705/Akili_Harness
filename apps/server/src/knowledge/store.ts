/**
 * Knowledge base (RAG, DIRECTIVES §3 B): ingestion in the background (text, Word, PDF, scans and photos by
 * OCR), cleaning, chunking, embeddings when a provider is configured and allowed, storage in PostgreSQL
 * (full-text index always, pgvector when installed), hybrid search with reciprocal rank fusion, and sources.
 * Every query is scoped to one organization. Retrieved text is data, never instructions (rule 9).
 */
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { readDocument, UnreadableDocument } from '../documents/extract.js'
import { suspiciousInstructions } from '../security/guardrails.js'
import { getBlob } from '../storage/blobs.js'
import type { FileKind } from '../storage/sniff.js'
import type { JobOutcome } from '../jobs.js'
import { embed } from '../ai/providers/openai-compatible.js'
import { pseudonymizerFor } from '../ai/pseudonymize.js'
import { aiAccess } from '../ai/router.js'
import { chunkText } from './chunk.js'

let vectorColumn: boolean | null = null

/** pgvector present (deploy/postgres) → embeddings are stored and searched; otherwise full-text only. */
export async function hasVectors(db: Db): Promise<boolean> {
  if (vectorColumn === null) {
    vectorColumn = Boolean(await db.get(`SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'
      AND table_schema = ANY (current_schemas(false))`))
  }
  return vectorColumn
}

/** Whether this organization's knowledge may be embedded now, and how (rule 5 for external providers). */
async function embeddingPlan(app: FastifyInstance, orgId: string): Promise<{ external: boolean; model: string } | null> {
  const cfg = app.deps.config.ai.embeddings
  if (!cfg) return null
  const access = await aiAccess(app, orgId, 'chat')
  if (!access.settings.enabled) return null
  if (cfg.external && !access.externalConsent) return null
  if (access.settings.mode === 'local' && cfg.external) return null
  return { external: cfg.external, model: cfg.model }
}

const vectorLiteral = (v: number[]) => `[${v.map(x => (Number.isFinite(x) ? x : 0)).join(',')}]`

export async function ingestKnowledge(app: FastifyInstance, orgId: string, documentId: string): Promise<JobOutcome> {
  const { db, config } = app.deps
  const doc = await db.get<{ id: string; blob_id: string; kind: FileKind; status: string; version: number }>(
    'SELECT id, blob_id, kind, status, version FROM knowledge_documents WHERE id = ? AND org_id = ?', documentId, orgId)
  if (!doc || doc.status === 'ready') return 'done'
  await db.run("UPDATE knowledge_documents SET status = 'processing', error = NULL WHERE id = ? AND org_id = ?", documentId, orgId)
  let text: string
  let ocrUsed = false
  try {
    const { bytes } = await getBlob(db, config, orgId, doc.blob_id)
    const read = await readDocument(bytes, doc.kind, { ocr: config.ocr.enabled, maxOcrPages: config.ocr.maxPages })
    text = read.text
    ocrUsed = read.ocrUsed
  } catch (error) {
    await db.run("UPDATE knowledge_documents SET status = 'failed', error = ?, updated_at = now() WHERE id = ? AND org_id = ?",
      error instanceof UnreadableDocument ? error.message : 'Fichier illisible.', documentId, orgId)
    return 'done'
  }
  const chunks = chunkText(text)
  if (chunks.length === 0) {
    await db.run("UPDATE knowledge_documents SET status = 'failed', error = 'Aucun texte exploitable dans ce document.', updated_at = now() WHERE id = ? AND org_id = ?", documentId, orgId)
    return 'done'
  }
  // Embeddings (optional). A failure here keeps the document searchable by words.
  let vectors: number[][] | null = null
  let embeddingModel: string | null = null
  const plan = await embeddingPlan(app, orgId)
  if (plan && await hasVectors(db)) {
    try {
      const pseudo = plan.external ? await pseudonymizerFor(db, orgId) : null
      const inputs = chunks.map(c => {
        const t = `${c.heading ? `${c.heading}\n` : ''}${c.content}`
        return pseudo ? pseudo.mask(t) : t
      })
      vectors = []
      for (let i = 0; i < inputs.length; i += 64) vectors.push(...await embed({ ...config.ai.embeddings!, model: plan.model }, inputs.slice(i, i + 64)))
      embeddingModel = plan.model
    } catch (error) {
      app.log.warn({ document: documentId, err: String(error) }, 'knowledge embeddings failed, full-text only')
      vectors = null
    }
  }
  const flagged = suspiciousInstructions(text)
  const withVectors = vectors !== null && await hasVectors(db)
  await db.tx(async tx => {
    // The previous version stays searchable until this one is complete.
    await tx.run('DELETE FROM knowledge_chunks WHERE document_id = ? AND org_id = ?', documentId, orgId)
    for (const [i, c] of chunks.entries()) {
      if (withVectors) {
        await tx.run(`INSERT INTO knowledge_chunks (org_id, document_id, ordinal, heading, content, embedding_model, embedding) VALUES (?, ?, ?, ?, ?, ?, ?::public.vector)`,
          orgId, documentId, c.ordinal, c.heading, c.content, embeddingModel, vectorLiteral(vectors![i]!))
      } else {
        await tx.run('INSERT INTO knowledge_chunks (org_id, document_id, ordinal, heading, content) VALUES (?, ?, ?, ?, ?)', orgId, documentId, c.ordinal, c.heading, c.content)
      }
    }
    await tx.run(`UPDATE knowledge_documents SET status = 'ready', chunks = ?, embedded = ?, embedding_model = ?, ocr_used = ?, flagged = ?, error = NULL, updated_at = now()
      WHERE id = ? AND org_id = ?`, chunks.length, withVectors, embeddingModel, ocrUsed, flagged, documentId, orgId)
  })
  return 'done'
}

export interface Source { n: number; chunk_id: number; document_id: string; title: string; heading: string | null; ordinal: number; content: string; score: number; flagged: boolean }

/** Words of a question as an OR query (a question rarely contains every word of the passage). */
function orQuery(question: string): string | null {
  const words = [...new Set(question.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 30)
  return words.length ? words.map(w => `'${w.replace(/'/g, "''")}'`).join(' | ') : null
}

/** Hybrid search: full-text and (when available) vectors, fused by reciprocal rank. */
export async function searchKnowledge(app: FastifyInstance, orgId: string, question: string, k = 5): Promise<Source[]> {
  const { db, config } = app.deps
  const ranked = new Map<number, { row: Omit<Source, 'n' | 'score'>; score: number }>()
  const add = (rows: Array<Omit<Source, 'n' | 'score'>>) => rows.forEach((row, i) => {
    const entry = ranked.get(row.chunk_id) ?? { row, score: 0 }
    entry.score += 1 / (60 + i + 1)
    ranked.set(row.chunk_id, entry)
  })
  const select = `SELECT c.id AS chunk_id, c.document_id, d.title, c.heading, c.ordinal, c.content, d.flagged
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.org_id = c.org_id`
  const q = orQuery(question)
  if (q) {
    add(await db.all(`${select}, to_tsquery('french', ?) query
      WHERE c.org_id = ? AND d.status = 'ready' AND c.tsv @@ query ORDER BY ts_rank_cd(c.tsv, query) DESC, c.id LIMIT 20`, q, orgId))
  }
  const plan = await embeddingPlan(app, orgId)
  if (plan && await hasVectors(db)) {
    try {
      const pseudo = plan.external ? await pseudonymizerFor(db, orgId) : null
      const [vector] = await embed({ ...config.ai.embeddings!, model: plan.model }, [pseudo ? pseudo.mask(question) : question])
      add(await db.all(`${select} WHERE c.org_id = ? AND d.status = 'ready' AND c.embedding IS NOT NULL AND c.embedding_model = ?
        ORDER BY c.embedding OPERATOR(public.<=>) ?::public.vector, c.id LIMIT 20`, orgId, plan.model, vectorLiteral(vector!)))
    } catch (error) {
      app.log.warn({ err: String(error) }, 'knowledge vector search failed, full-text only')
    }
  }
  return [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, k)
    .map((e, i) => ({ ...e.row, n: i + 1, score: Math.round(e.score * 10_000) / 10_000 }))
}

/** Retrieved passages for a prompt: numbered sources, wrapped as untrusted data. */
export function formatSources(sources: Source[]): string {
  if (sources.length === 0) return ''
  return sources.map(s => `<connaissance source="${s.n}" titre="${s.title.replace(/"/g, "'")}"${s.heading ? ` section="${s.heading.replace(/"/g, "'")}"` : ''}>\n${s.content}\n</connaissance>`).join('\n')
}
