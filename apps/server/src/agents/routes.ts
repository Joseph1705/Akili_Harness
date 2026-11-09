/** Packs and agents. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { badRequest, notFound } from '../errors.js'
import { createAgent, packById, PACKS } from './packs.js'

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps
  const agentQuery = `SELECT a.*, (SELECT COUNT(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id AND d.status = 'done' AND d.processed_at >= date('now')) AS docs_today,
    (SELECT COUNT(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id) AS docs_total FROM agents a`

  app.get('/packs', async (request) => { orgOf(request); return { packs: PACKS } })

  app.get('/agents', async (request) => {
    const org = orgOf(request)
    return { agents: db.prepare(`${agentQuery} WHERE a.org_id = ? ORDER BY a.created_at`).all(org.id) }
  })

  app.get('/agents/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const agent = db.prepare(`${agentQuery} WHERE a.org_id = ? AND a.id = ?`).get(org.id, id)
    if (!agent) throw notFound('Agent')
    return { agent }
  })

  app.post('/agents', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({
      packId: z.string().max(60), name: z.string().trim().min(2).max(80), language: z.enum(['fr', 'en', 'sw']).default('fr'),
    }).strict().parse(request.body)
    const pack = packById(body.packId)
    if (!pack) throw notFound('Pack')
    if (!pack.available) throw badRequest(`Le pack « ${pack.name} » arrive bientôt.`)
    const id = createAgent(db, org.id, pack.id, body.name, body.language)
    audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.created', 'agent', id, { pack: pack.id })
    return { agent: db.prepare(`${agentQuery} WHERE a.org_id = ? AND a.id = ?`).get(org.id, id) }
  })

  app.patch('/agents/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ status: z.enum(['active', 'paused']).optional(), name: z.string().trim().min(2).max(80).optional() }).strict().parse(request.body)
    const result = db.prepare('UPDATE agents SET status = COALESCE(?, status), name = COALESCE(?, name) WHERE id = ? AND org_id = ?').run(body.status ?? null, body.name ?? null, id, org.id)
    if (result.changes === 0) throw notFound('Agent')
    audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.updated', 'agent', id, body)
    return { ok: true }
  })
}
