/**
 * Platform administration (us, the operators — AKILI_PLATFORM_ADMINS): see organizations and credit
 * them after a payment, until mobile money and cards are integrated. Organizations cannot credit themselves.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from './audit.js'
import { userOf } from './auth/context.js'
import { topup } from './credits.js'
import { notFound } from './errors.js'

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const admin = (request: FastifyRequest) => {
    const user = userOf(request)
    // Not a 403: the platform area does not exist for anyone else.
    if (!config.platformAdmins.includes(user.email)) throw notFound('Page')
    return user
  }

  app.get('/orgs', async (request) => {
    admin(request)
    return {
      orgs: await db.all(`SELECT o.id, o.name, o.kind, o.plan, o.city, o.created_at, o.onboarding_done_at,
        (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger l WHERE l.org_id = o.id) AS balance,
        (SELECT count(*) FROM memberships m WHERE m.org_id = o.id) AS members,
        (SELECT count(*) FROM documents d WHERE d.org_id = o.id) AS documents,
        (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_email
        FROM organizations o ORDER BY o.created_at DESC LIMIT 500`),
    }
  })

  app.post('/orgs/:id/credits', async (request) => {
    const user = admin(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      credits: z.number().int().min(1).max(100_000),
      ref: z.string().trim().min(3, 'Référence de paiement requise.').max(80),
    }).strict().parse(request.body)
    if (!await db.get('SELECT 1 FROM organizations WHERE id = ?', id)) throw notFound('Organisation')
    await topup(db, id, body.credits, body.ref, user.id)
    await audit(db, { orgId: id, userId: user.id }, 'credits.topup', 'credits', body.ref, { credits: body.credits, by: 'platform' })
    return { ok: true }
  })
}
