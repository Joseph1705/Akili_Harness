/** Demo data (fictitious, fixtures/contracts.json). Only available in demo mode. */
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { audit } from './audit.js'
import { CAN, orgOf } from './auth/context.js'
import type { Db } from './db.js'
import { forbidden } from './errors.js'
import { importClient, type ContractInput } from './invoicing/clients.js'

export const FIXTURES_DIR = resolve(import.meta.dirname, '../../../fixtures')

export function loadDemoData(db: Db, orgId: string): void {
  const data = JSON.parse(readFileSync(join(FIXTURES_DIR, 'contracts.json'), 'utf8')) as {
    provider: Record<string, string>; clients: Array<ContractInput & { key: string }>
  }
  const p = data.provider
  db.prepare(`UPDATE organizations SET address = COALESCE(address, ?), rccm = COALESCE(rccm, ?), id_nat = COALESCE(id_nat, ?), nif = COALESCE(nif, ?),
    bank_details = COALESCE(bank_details, ?), city = COALESCE(city, ?), province = COALESCE(province, ?), sector = COALESCE(sector, ?),
    vat_status = CASE vat_status WHEN 'unknown' THEN 'yes' ELSE vat_status END WHERE id = ?`)
    .run(p.address!, p.rccm!, p.id_nat!, p.nif!, p.bank_details!, p.city!, p.province!, p.sector!, orgId)
  const existing = db.prepare('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?').get(orgId) as { n: number }
  if (existing.n === 0) for (const client of data.clients) importClient(db, orgId, client)
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  app.post('/load', async (request) => {
    if (!config.demoMode) throw forbidden('Disponible uniquement en mode démonstration.')
    const org = orgOf(request, CAN.configure)
    loadDemoData(db, org.id)
    audit(db, { orgId: org.id, userId: request.user!.id }, 'demo.loaded', 'organization', org.id)
    return { ok: true }
  })
  app.get('/reports', async (request) => {
    orgOf(request)
    if (!config.demoMode) throw forbidden('Disponible uniquement en mode démonstration.')
    const { readdirSync } = await import('node:fs')
    return { reports: readdirSync(join(FIXTURES_DIR, 'reports')).sort() }
  })
}
