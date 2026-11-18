/**
 * Background jobs stored in PostgreSQL, so work survives a restart (directive 4.11: asynchronous
 * processing, immediate acknowledgement). Workers claim jobs with SKIP LOCKED, so several app
 * containers can run side by side without processing a job twice. Failures retry with backoff.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'
import { processDocument } from './documents/process.js'
import { reconcilePayments } from './billing/payments.js'
import { ingestKnowledge } from './knowledge/store.js'
import { draftWhatsAppReply } from './connectors/routes.js'
import { purgeExpired } from './maintenance.js'

export type JobOutcome = 'done' | 'waiting_credits'
export type JobType = 'process_document' | 'ingest_knowledge' | 'whatsapp_draft'

const HANDLERS: Record<JobType, (app: FastifyInstance, orgId: string, refId: string) => Promise<JobOutcome>> = {
  process_document: processDocument,
  ingest_knowledge: ingestKnowledge,
  whatsapp_draft: draftWhatsAppReply,
}

const MAX_ATTEMPTS = 3

export async function enqueue(db: Db, orgId: string, type: JobType, refId: string): Promise<void> {
  await db.run('INSERT INTO jobs (id, org_id, type, ref_id) VALUES (?, ?, ?, ?)', randomUUID(), orgId, type, refId)
}

/** Run one pending job; false when there is none. */
export async function runOneJob(app: FastifyInstance): Promise<boolean> {
  const { db } = app.deps
  const job = await db.get<{ id: string; org_id: string; type: string; ref_id: string; attempts: number }>(`UPDATE jobs SET status = 'running', attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, org_id, type, ref_id, attempts`)
  if (!job) return false
  try {
    const handler = HANDLERS[job.type as JobType]
    if (!handler) throw new Error(`unknown job type ${job.type}`)
    const outcome = await handler(app, job.org_id, job.ref_id)
    await db.run('UPDATE jobs SET status = ?, error = NULL WHERE id = ?', outcome, job.id)
  } catch (error) {
    const failed = job.attempts >= MAX_ATTEMPTS
    await db.run(`UPDATE jobs SET status = ?, error = ?, run_after = now() + make_interval(secs => ?) WHERE id = ?`,
      failed ? 'failed' : 'pending', String(error).slice(0, 500), 2 ** job.attempts, job.id)
    if (failed) {
      app.log.error({ job: job.id, error: String(error) }, 'job failed')
      // No credit is ever charged for a document that failed this way (the charge is inside the invoice transaction).
      await db.run("UPDATE documents SET status = 'failed', error = 'Erreur interne pendant le traitement. Aucun crédit n''a été utilisé. Réessayez ou contactez le support.' WHERE id = ? AND org_id = ? AND status = 'processing'", job.ref_id, job.org_id)
      await db.run("UPDATE knowledge_documents SET status = 'failed', error = 'Erreur interne pendant l''indexation. Réessayez.' WHERE id = ? AND org_id = ? AND status IN ('processing', 'queued')", job.ref_id, job.org_id)
    } else if (job.type === 'process_document') {
      // Back in the queue for the retry: a document never stays "processing" while no worker holds it.
      await db.run("UPDATE documents SET status = 'queued' WHERE id = ? AND org_id = ? AND status = 'processing'", job.ref_id, job.org_id)
    }
  }
  return true
}

/** Tests: run until nothing is pending. */
export async function drainJobs(app: FastifyInstance, limit = 200): Promise<void> {
  for (let i = 0; i < limit && await runOneJob(app); i++) { /* keep going */ }
}

export async function startWorker(app: FastifyInstance, intervalMs = 500): Promise<{ stop(): void }> {
  // Jobs left "running" by a crash go back to the queue.
  await app.deps.db.run("UPDATE jobs SET status = 'pending' WHERE status = 'running'")
  let running = false
  let lastReconcile = 0
  let lastPurge = 0
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      while (await runOneJob(app)) { /* drain */ }
      // Payments whose webhook was lost are verified with the provider every few minutes.
      if (Date.now() - lastReconcile > 3 * 60_000) { lastReconcile = Date.now(); await reconcilePayments(app) }
      // Retention: expired secrets and old AI excerpts, every 6 hours.
      if (Date.now() - lastPurge > 6 * 3600_000) { lastPurge = Date.now(); await purgeExpired(app.deps.db, app.deps.config) }
    } catch (error) { app.log.error({ error: String(error) }, 'worker loop') } finally { running = false }
  }, intervalMs)
  return { stop: () => clearInterval(timer) }
}
