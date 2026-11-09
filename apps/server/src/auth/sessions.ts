/** Session tokens: random, stored only as an HMAC, sliding expiry, never bound to the IP (directive 4.11). */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import { now, type Db } from '../db.js'
import { hmac } from '../security/crypto.js'
import type { OrgContext, User } from './context.js'

export const SESSION_COOKIE = 'sid'
export const SESSION_DAYS = 30

function tokenKey(config: Config): Buffer {
  return Buffer.from(hmac(config.masterKey, 'session-token-key-v1'), 'hex')
}

export function createSession(db: Db, config: Config, userId: string, userAgent: string | undefined): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const created = now()
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
  const membership = db.prepare('SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1').get(userId) as { org_id: string } | undefined
  db.prepare(`INSERT INTO sessions (id, token_hash, user_id, current_org_id, user_agent, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hmac(tokenKey(config), token), userId, membership?.org_id ?? null, (userAgent ?? '').slice(0, 200), created, created, expires)
  return { token, id }
}

export interface ResolvedSession {
  sessionId: string
  user: User
  org: OrgContext | undefined
}

export function resolveSession(db: Db, config: Config, token: string): ResolvedSession | undefined {
  const row = db.prepare(`SELECT s.id, s.user_id, s.current_org_id, s.expires_at, s.last_seen_at FROM sessions s
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(hmac(tokenKey(config), token)) as
    { id: string; user_id: string; current_org_id: string | null; expires_at: string; last_seen_at: string } | undefined
  if (!row || row.expires_at <= now()) return undefined
  // Sliding expiry, written at most once a minute.
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now(), expires, row.id)
  }
  const user = db.prepare('SELECT id, email, first_name, last_name, phone, locale, timezone FROM users WHERE id = ?').get(row.user_id) as unknown as User
  let org: OrgContext | undefined
  if (row.current_org_id) {
    org = db.prepare(`SELECT o.id, o.name, o.plan, m.role FROM organizations o JOIN memberships m ON m.org_id = o.id
      WHERE o.id = ? AND m.user_id = ?`).get(row.current_org_id, row.user_id) as OrgContext | undefined
  }
  return { sessionId: row.id, user, org }
}
