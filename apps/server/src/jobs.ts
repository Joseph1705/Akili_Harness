/**
 * Background jobs stored in PostgreSQL, so work survives a restart (directive 4.11: asynchronous
 * processing, immediate acknowledgement). Workers claim jobs with SKIP LOCKED, so several app
 * containers can run side by side without processing a job twice. Failures retry with backoff.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'
import { processDocument } from './documents/process.js'

export type JobOutcome = 'done' | 'waiting_credits'

const HANDLERS: Record<string, (app: FastifyInstance, orgId: string, refId: string) => Promise<JobOutcome>> = {
  process_document: processDocument,
}

const MAX_ATTEMPTS = 3

export async function enqueue(db: Db, orgId: string, type: keyof typeof HANDLERS, refId: string): Promise<void> {
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
    const outcome = await HANDLERS[job.type]!(app, job.org_id, job.ref_id)
    await db.run('UPDATE jobs SET status = ?, error = NULL WHERE id = ?', outcome, job.id)
  } catch (error) {
    const failed = job.attempts >= MAX_ATTEMPTS
    await db.run(`UPDATE jobs SET status = ?, error = ?, run_after = now() + make_interval(secs => ?) WHERE id = ?`,
      failed ? 'failed' : 'pending', String(error).slice(0, 500), 2 ** job.attempts, job.id)
    if (failed) {
      app.log.error({ job: job.id, error: String(error) }, 'job failed')
      await db.run("UPDATE documents SET status = 'failed', error = 'Erreur interne pendant le traitement. Réessayez ou contactez le support.' WHERE id = ? AND org_id = ? AND status = 'processing'", job.ref_id, job.org_id)
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
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try { while (await runOneJob(app)) { /* drain */ } } catch (error) { app.log.error({ error: String(error) }, 'worker loop') } finally { running = false }
  }, intervalMs)
  return { stop: () => clearInterval(timer) }
}
