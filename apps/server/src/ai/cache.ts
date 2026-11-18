/**
 * Response cache (DIRECTIVES §3 G "secure response caching"): per organization only, keyed by a keyed hash
 * of the exact request (provider, model, prompt, input), encrypted with the organization's key, expiring.
 * Used for deterministic work (document extraction), never for conversations.
 */
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { decrypt, encrypt, hmac, orgKey } from '../security/crypto.js'

function cacheKey(config: Config, orgId: string, key: unknown): string {
  return hmac(orgKey(config.masterKey, orgId), `ai-cache-v1:${JSON.stringify(key)}`)
}

export async function cacheGet<T>(db: Db, config: Config, orgId: string, key: unknown): Promise<T | null> {
  if (config.ai.cacheTtlHours === 0) return null
  const hash = cacheKey(config, orgId, key)
  const row = await db.get<{ payload: Buffer }>('SELECT payload FROM ai_cache WHERE org_id = ? AND key_hash = ? AND expires_at > now()', orgId, hash)
  if (!row) return null
  await db.run('UPDATE ai_cache SET hits = hits + 1 WHERE org_id = ? AND key_hash = ?', orgId, hash)
  try {
    return JSON.parse(decrypt(orgKey(config.masterKey, orgId), row.payload, `${orgId}/ai-cache/${hash}`).toString('utf8')) as T
  } catch {
    return null
  }
}

export async function cachePut(db: Db, config: Config, orgId: string, key: unknown, value: unknown): Promise<void> {
  if (config.ai.cacheTtlHours === 0) return
  const hash = cacheKey(config, orgId, key)
  const sealed = encrypt(orgKey(config.masterKey, orgId), Buffer.from(JSON.stringify(value)), `${orgId}/ai-cache/${hash}`)
  await db.run(`INSERT INTO ai_cache (org_id, key_hash, payload, expires_at) VALUES (?, ?, ?, now() + make_interval(hours => ?))
    ON CONFLICT (org_id, key_hash) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, hits = 0`,
  orgId, hash, sealed, config.ai.cacheTtlHours)
  // Expired entries are removed opportunistically.
  await db.run('DELETE FROM ai_cache WHERE org_id = ? AND expires_at < now()', orgId)
}
