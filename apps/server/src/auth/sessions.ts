/** Session tokens: random, stored only as an HMAC, sliding expiry, never bound to the IP (directive 4.11). */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { Db } from '../db.js'
import { hmac } from '../security/crypto.js'
import type { OrgContext, User } from './context.js'

export const SESSION_COOKIE = 'sid'
export const SESSION_DAYS = 30

function tokenKey(config: Config): Buffer {
  return Buffer.from(hmac(config.masterKey, 'session-token-key-v1'), 'hex')
}

export async function createSession(db: Db, config: Config, userId: string, userAgent: string | undefined): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const membership = await db.get<{ org_id: string }>('SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', userId)
  await db.run(`INSERT INTO sessions (id, token_hash, user_id, current_org_id, user_agent, expires_at)
    VALUES (?, ?, ?, ?, ?, now() + make_interval(days => ?))`,
  id, hmac(tokenKey(config), token), userId, membership?.org_id ?? null, (userAgent ?? '').slice(0, 200), SESSION_DAYS)
  return { token, id }
}

export interface ResolvedSession {
  sessionId: string
  user: User
  org: OrgContext | undefined
}

export async function resolveSession(db: Db, config: Config, token: string): Promise<ResolvedSession | undefined> {
  const row = await db.get<{ id: string; user_id: string; current_org_id: string | null; last_seen_at: string }>(
    `SELECT id, user_id, current_org_id, last_seen_at FROM sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()`, hmac(tokenKey(config), token))
  if (!row) return undefined
  // Sliding expiry, written at most once a minute.
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    await db.run('UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => ?) WHERE id = ?', SESSION_DAYS, row.id)
  }
  const user = (await db.get<User>('SELECT id, email, first_name, last_name, phone, locale, timezone FROM users WHERE id = ?', row.user_id))!
  const org = row.current_org_id
    ? await db.get<OrgContext>(`SELECT o.id, o.name, o.plan, m.role FROM organizations o JOIN memberships m ON m.org_id = o.id
        WHERE o.id = ? AND m.user_id = ?`, row.current_org_id, row.user_id)
    : undefined
  return { sessionId: row.id, user, org }
}
