/**
 * Background jobs stored in the database, so work survives a restart (directive 4.11: asynchronous
 * processing, immediate acknowledgement). One in-process worker polls; failures retry with backoff.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { now, type Db } from './db.js'
import { processDocument } from './documents/process.js'

export type JobOutcome = 'done' | 'waiting_credits'

const HANDLERS: Record<string, (app: FastifyInstance, orgId: string, refId: string) => Promise<JobOutcome>> = {
  process_document: processDocument,
}

const MAX_ATTEMPTS = 3

export function enqueue(db: Db, orgId: string, type: keyof typeof HANDLERS, refId: string): void {
  db.prepare('INSERT INTO jobs (id, org_id, type, ref_id, run_after, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), orgId, type, refId, now(), now())
}

/** Run one pending job; false when there is none. */
export async function runOneJob(app: FastifyInstance): Promise<boolean> {
  const { db } = app.deps
  const job = db.tx(() => {
    const row = db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY created_at LIMIT 1").get(now()) as
      { id: string; org_id: string; type: string; ref_id: string; attempts: number } | undefined
    if (row) db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(row.id)
    return row
  })
  if (!job) return false
  try {
    const outcome = await HANDLERS[job.type]!(app, job.org_id, job.ref_id)
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(outcome, job.id)
  } catch (error) {
    const attempts = job.attempts + 1
    const failed = attempts >= MAX_ATTEMPTS
    db.prepare('UPDATE jobs SET status = ?, error = ?, run_after = ? WHERE id = ?')
      .run(failed ? 'failed' : 'pending', String(error).slice(0, 500), new Date(Date.now() + 2 ** attempts * 1000).toISOString(), job.id)
    if (failed) app.log.error({ job: job.id, error: String(error) }, 'job failed')
  }
  return true
}

/** Tests and the demo seed: run until nothing is pending. */
export async function drainJobs(app: FastifyInstance, limit = 200): Promise<void> {
  for (let i = 0; i < limit && await runOneJob(app); i++) { /* keep going */ }
}

export function startWorker(app: FastifyInstance, intervalMs = 400): { stop(): void } {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try { while (await runOneJob(app)) { /* drain */ } } finally { running = false }
  }, intervalMs)
  // Jobs left "running" by a crash go back to the queue.
  app.deps.db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run()
  return { stop: () => clearInterval(timer) }
}
