/** Login by e-mail code (directive 5.1), sessions and devices. */
import type { FastifyInstance } from 'fastify'
import { randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError, notFound } from '../errors.js'
import { hmac, safeEqualHex } from '../security/crypto.js'
import { audit } from '../audit.js'
import { userOf } from './context.js'
import { RateLimiter } from './rate-limit.js'
import { createSession, SESSION_COOKIE, SESSION_DAYS } from './sessions.js'

const CODE_TTL_MINUTES = 10
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
    await db.tx(async tx => {
      await tx.run('UPDATE login_codes SET consumed_at = now() WHERE email = ? AND consumed_at IS NULL', email)
      await tx.run(`INSERT INTO login_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, now() + make_interval(mins => ?))`,
        randomUUID(), email, hmac(codeKey, `${email}:${code}`), CODE_TTL_MINUTES)
    })
    try {
      await mailer.sendLoginCode(email, code)
    } catch (error) {
      request.log.error({ err: String(error), to: maskEmail(email) }, 'login code e-mail failed')
      throw new HttpError(503, 'mail_unavailable', "L'e-mail n'a pas pu être envoyé. Réessayez dans quelques minutes.")
    }
    await audit(db, { orgId: null, userId: null }, 'auth.code_requested', 'email', maskEmail(email))
    // Same answer whether the address is known or not: no account enumeration.
    return { ok: true }
  })

  app.post('/verify', async (request, reply) => {
    const body = z.object({ email: Email, code: z.string().trim().regex(/^\d{6}$/, 'Le code a 6 chiffres.') }).parse(request.body)
    if (!limiter.take(`verify-ip:${request.ip}`, 30, TEN_MINUTES)) throw tooMany()
    const invalid = new HttpError(400, 'invalid_code', 'Code incorrect ou expiré. Demandez un nouveau code.')
    const row = await db.get<{ id: string; code_hash: string; attempts: number }>(`SELECT id, code_hash, attempts FROM login_codes
      WHERE email = ? AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, body.email)
    if (!row) throw invalid
    const attempts = row.attempts + 1
    const matches = safeEqualHex(row.code_hash, hmac(codeKey, `${body.email}:${body.code}`))
    if (!matches || attempts > MAX_ATTEMPTS) {
      if (attempts >= MAX_ATTEMPTS) await db.run('UPDATE login_codes SET attempts = ?, consumed_at = now() WHERE id = ?', attempts, row.id)
      else await db.run('UPDATE login_codes SET attempts = ? WHERE id = ?', attempts, row.id)
      await audit(db, { orgId: null, userId: null }, 'auth.code_failed', 'email', maskEmail(body.email), { attempts })
      throw invalid
    }
    const { userId, token } = await db.tx(async tx => {
      // Consume the code atomically: a second request with the same code finds nothing to update.
      const consumed = await tx.run('UPDATE login_codes SET consumed_at = now(), attempts = ? WHERE id = ? AND consumed_at IS NULL', attempts, row.id)
      if (consumed === 0) throw invalid
      await tx.run('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING', randomUUID(), body.email)
      const user = (await tx.get<{ id: string }>('SELECT id FROM users WHERE email = ?', body.email))!
      const session = await createSession(tx, config, user.id, request.headers['user-agent'])
      return { userId: user.id, token: session.token }
    })
    await audit(db, { orgId: null, userId }, 'auth.login', 'user', userId)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_DAYS * 86400,
    })
    return { ok: true }
  })

  app.post('/logout', async (request, reply) => {
    userOf(request)
    await db.run('UPDATE sessions SET revoked_at = now() WHERE id = ?', request.sessionId!)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/me', async (request) => {
    const user = userOf(request)
    const orgs = await db.all(`SELECT o.id, o.name, o.plan, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY m.created_at`, user.id)
    let org = null
    if (request.org) {
      const row = await db.get<Record<string, unknown>>(`SELECT id, kind, name, plan, data_mode, sector, city, province, currency, secondary_currencies, team_size,
        rccm, id_nat, nif, address, vat_status, accounting_software, reports_channel, bank_details,
        logo_blob_id IS NOT NULL AS has_logo, onboarding_step, onboarding_done_at FROM organizations WHERE id = ?`, request.org.id)
      org = { ...row, role: request.org.role }
    }
    return {
      user, org, orgs,
      platformAdmin: config.platformAdmins.includes(user.email),
      app: { brand: config.brand, hostingLabel: config.hostingLabel, models: config.models },
    }
  })

  app.get('/sessions', async (request) => {
    const user = userOf(request)
    const rows = await db.all<{ id: string }>(`SELECT id, user_agent, created_at, last_seen_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, user.id)
    return { sessions: rows.map(s => ({ ...s, current: s.id === request.sessionId })) }
  })

  app.delete('/sessions/:id', async (request) => {
    const user = userOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const changed = await db.run('UPDATE sessions SET revoked_at = now() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, user.id)
    if (changed === 0) throw notFound('Session')
    await audit(db, { orgId: request.org?.id ?? null, userId: user.id }, 'auth.session_revoked', 'session', id)
    return { ok: true }
  })
}
