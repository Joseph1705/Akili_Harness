/**
 * Retention (DIRECTIVES §7 "appropriate retention and deletion policies"), run by the worker every few hours:
 * expired login codes, sessions, OAuth states, idempotency keys and cache entries are deleted; AI prompt and
 * answer excerpts are erased after AKILI_AI_LOG_RETENTION_DAYS (the numbers of the run are kept); webhook
 * payloads after 180 days. Financial history (credits, invoices, payments, audit) is never deleted.
 */
import type { Config } from './config.js'
import type { Db } from './db.js'

export async function purgeExpired(db: Db, config: Config): Promise<void> {
  await db.run("DELETE FROM login_codes WHERE created_at < now() - interval '1 day'")
  await db.run("DELETE FROM sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND last_seen_at < now() - interval '30 days'")
  await db.run("DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'")
  await db.run("DELETE FROM idempotency WHERE created_at < now() - interval '30 days'")
  await db.run('DELETE FROM ai_cache WHERE expires_at < now()')
  await db.run("UPDATE action_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < now()")
  await db.run(`UPDATE ai_runs SET request_excerpt = NULL, response_excerpt = NULL
    WHERE created_at < now() - make_interval(days => ?) AND (request_excerpt IS NOT NULL OR response_excerpt IS NOT NULL)`, config.aiLogRetentionDays)
  await db.run('UPDATE ai_run_steps SET detail = NULL WHERE created_at < now() - make_interval(days => ?) AND detail IS NOT NULL', config.aiLogRetentionDays)
  await db.run("UPDATE payment_events SET payload = NULL WHERE received_at < now() - interval '180 days' AND payload IS NOT NULL")
}
