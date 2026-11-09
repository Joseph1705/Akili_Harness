/** Packs and agents. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { badRequest, notFound } from '../errors.js'
import { extractText } from '../documents/extract.js'
import { parseReport } from '../documents/parse-report.js'
import { clientById, contractByPo } from '../invoicing/clients.js'
import { buildDraft, type OrgTaxProfile } from '../invoicing/draft.js'
import { safeFilename } from '../storage/blobs.js'
import { sniff } from '../storage/sniff.js'
import { createAgent, packById, PACKS } from './packs.js'

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps
  const agentQuery = `SELECT a.*,
    (SELECT count(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id AND d.status = 'done' AND d.processed_at >= current_date) AS docs_today,
    (SELECT count(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id) AS docs_total FROM agents a`

  app.get('/packs', async (request) => { orgOf(request); return { packs: PACKS } })

  app.get('/agents', async (request) => {
    const org = orgOf(request)
    return { agents: await db.all(`${agentQuery} WHERE a.org_id = ? ORDER BY a.created_at`, org.id) }
  })

  app.get('/agents/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const agent = await db.get(`${agentQuery} WHERE a.org_id = ? AND a.id = ?`, org.id, id)
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
    const id = await createAgent(db, org.id, pack.id, body.name, body.language)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.created', 'agent', id, { pack: pack.id })
    return { agent: await db.get(`${agentQuery} WHERE a.org_id = ? AND a.id = ?`, org.id, id) }
  })

  app.patch('/agents/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ status: z.enum(['active', 'paused']).optional(), name: z.string().trim().min(2).max(80).optional() }).strict().parse(request.body)
    const changed = await db.run('UPDATE agents SET status = COALESCE(?, status), name = COALESCE(?, name) WHERE id = ? AND org_id = ?', body.status ?? null, body.name ?? null, id, org.id)
    if (changed === 0) throw notFound('Agent')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.updated', 'agent', id, body)
    return { ok: true }
  })

  // "Tester sur 5 documents" (design screen D): a dry run — nothing stored, no credit, no invoice.
  app.post('/agents/:id/test', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    if (!await db.get('SELECT 1 FROM agents WHERE id = ? AND org_id = ?', id, org.id)) throw notFound('Agent')
    const files: Array<{ filename: string; bytes: Buffer }> = []
    for await (const part of request.parts()) {
      if (part.type === 'file') files.push({ filename: safeFilename(part.filename), bytes: await part.toBuffer() })
    }
    if (files.length === 0 || files.length > 5) throw badRequest('Joignez de 1 à 5 rapports pour le test.')
    const profile = (await db.get<OrgTaxProfile>('SELECT nif, rccm, vat_status FROM organizations WHERE id = ?', org.id))!
    const results = []
    for (const file of files) {
      const kind = sniff(file.bytes)
      if (kind !== 'pdf' && kind !== 'xlsx' && kind !== 'csv') { results.push({ filename: file.filename, ok: false, error: 'Format non pris en charge.' }); continue }
      try {
        const report = parseReport(await extractText(file.bytes, kind))
        const contract = await contractByPo(db, org.id, report.po)
        const client = contract && await clientById(db, org.id, contract.client_id)
        if (!contract || !client) { results.push({ filename: file.filename, ok: false, report: report.number, error: `Bon de commande ${report.po} inconnu.` }); continue }
        const draft = buildDraft(report, contract, client, profile)
        results.push({
          filename: file.filename, ok: true, report: report.number, client: client.name, lines: draft.lines.length,
          total_cents: draft.totalCents, currency: contract.currency,
          attention: draft.checks.filter(c => c.status === 'warning' || c.status === 'error').length,
          checks: draft.checks.filter(c => c.status !== 'ok' && c.id !== 'fiscal'),
        })
      } catch (error) {
        results.push({ filename: file.filename, ok: false, error: error instanceof Error ? error.message : 'Fichier illisible.' })
      }
    }
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.tested', 'agent', id, { files: files.length })
    return { results }
  })
}
