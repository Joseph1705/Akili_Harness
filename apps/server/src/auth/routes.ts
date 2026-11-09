/** Login by e-mail code (directive 5.1), sessions and devices. */
import type { FastifyInstance } from 'fastify'
import { randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { now } from '../db.js'
import { HttpError, notFound } from '../errors.js'
import { hmac, safeEqualHex } from '../security/crypto.js'
import { audit } from '../audit.js'
import { userOf } from './context.js'
import { RateLimiter } from './rate-limit.js'
import { createSession, SESSION_COOKIE, SESSION_DAYS } from './sessions.js'

const CODE_TTL_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const TEN_MINUTES = 10 * 60_000

const Email = z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(254)

export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@')
  return `${name.slice(0, 2)}***@${domain}`
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer } = app.deps
  const limiter = new RateLimiter()
  const codeKey = Buffer.from(hmac(config.masterKey, 'login-code-key-v1'), 'hex')
  const tooMany = () => new HttpError(429, 'rate_limited', 'Trop de tentatives. Patientez quelques minutes.')

  app.post('/request-code', async (request) => {
    const { email } = z.object({ email: Email }).parse(request.body)
    if (!limiter.take(`ip:${request.ip}`, 20, TEN_MINUTES)) throw tooMany()
    if (!limiter.take(`code:${email}`, 3, TEN_MINUTES)) throw tooMany()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    db.tx(() => {
      db.prepare('UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL').run(now(), email)
      db.prepare('INSERT INTO login_codes (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), email, hmac(codeKey, `${email}:${code}`), new Date(Date.now() + CODE_TTL_MS).toISOString(), now())
    })
    await mailer.sendLoginCode(email, code)
    audit(db, { orgId: null, userId: null }, 'auth.code_requested', 'email', maskEmail(email))
    // Same answer whether the address is known or not: no account enumeration.
    return { ok: true, ...(config.demoMode ? { demoCode: mailer.lastCodeFor?.(email) } : {}) }
  })

  app.post('/verify', async (request, reply) => {
    const body = z.object({ email: Email, code: z.string().trim().regex(/^\d{6}$/, 'Le code a 6 chiffres.') }).parse(request.body)
    if (!limiter.take(`verify-ip:${request.ip}`, 30, TEN_MINUTES)) throw tooMany()
    const invalid = new HttpError(400, 'invalid_code', 'Code incorrect ou expiré. Demandez un nouveau code.')
    const row = db.prepare(`SELECT id, code_hash, expires_at, attempts FROM login_codes
      WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(body.email) as
      { id: string; code_hash: string; expires_at: string; attempts: number } | undefined
    if (!row || row.expires_at <= now()) throw invalid
    const attempts = row.attempts + 1
    const matches = safeEqualHex(row.code_hash, hmac(codeKey, `${body.email}:${body.code}`))
    if (!matches || attempts > MAX_ATTEMPTS) {
      db.prepare('UPDATE login_codes SET attempts = ?, consumed_at = CASE WHEN ? >= ? THEN ? ELSE consumed_at END WHERE id = ?')
        .run(attempts, attempts, MAX_ATTEMPTS, now(), row.id)
      audit(db, { orgId: null, userId: null }, 'auth.code_failed', 'email', maskEmail(body.email), { attempts })
      throw invalid
    }
    const { userId, token } = db.tx(() => {
      db.prepare('UPDATE login_codes SET consumed_at = ?, attempts = ? WHERE id = ?').run(now(), attempts, row.id)
      let user = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email) as { id: string } | undefined
      if (!user) {
        user = { id: randomUUID() }
        db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(user.id, body.email, now())
      }
      const session = createSession(db, config, user.id, request.headers['user-agent'])
      return { userId: user.id, token: session.token }
    })
    audit(db, { orgId: null, userId }, 'auth.login', 'user', userId)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_DAYS * 86400,
    })
    return { ok: true }
  })

  app.post('/logout', async (request, reply) => {
    userOf(request)
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), request.sessionId!)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/me', async (request) => {
    const user = userOf(request)
    const orgs = db.prepare(`SELECT o.id, o.name, o.plan, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY m.created_at`).all(user.id)
    let org = null
    if (request.org) {
      org = db.prepare(`SELECT id, kind, name, plan, data_mode, sector, city, province, currency, secondary_currencies, team_size,
        rccm, id_nat, nif, address, vat_status, accounting_software, reports_channel, bank_details,
        logo_blob_id IS NOT NULL AS has_logo, onboarding_step, onboarding_done_at FROM organizations WHERE id = ?`).get(request.org.id) as Record<string, unknown>
      org = { ...org, role: request.org.role, has_logo: Boolean(org.has_logo) }
    }
    return {
      user, org, orgs,
      app: { brand: config.brand, demoMode: config.demoMode, hostingLabel: config.hostingLabel, models: config.models },
    }
  })

  app.get('/sessions', async (request) => {
    const user = userOf(request)
    const rows = db.prepare(`SELECT id, user_agent, created_at, last_seen_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`).all(user.id, now()) as Array<{ id: string }>
    return { sessions: rows.map(s => ({ ...s, current: s.id === request.sessionId })) }
  })

  app.delete('/sessions/:id', async (request) => {
    const user = userOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const result = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, user.id)
    if (result.changes === 0) throw notFound('Session')
    audit(db, { orgId: request.org?.id ?? null, userId: user.id }, 'auth.session_revoked', 'session', id)
    return { ok: true }
  })
}
