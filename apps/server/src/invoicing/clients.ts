/** Clients (who the organization invoices) and their contracts with rate cards. */
import { randomUUID } from 'node:crypto'
import { now, type Db } from '../db.js'
import { parseMoney, parseQty } from './compute.js'

export interface Rate { code: string; label: string; unit: string; unit_price: string; max_qty?: string }

export interface Client {
  id: string; org_id: string; name: string; address: string | null; nif: string | null; rccm: string | null
  email: string | null; vat_applicable: number
}

export interface Contract {
  id: string; org_id: string; client_id: string; reference: string; po_number: string; currency: string
  payment_terms_days: number; rates: Rate[]
}

export interface ContractInput {
  name: string; address?: string; nif?: string; rccm?: string; email?: string; vat_applicable: boolean
  contract: { reference: string; po_number: string; currency: string; payment_terms_days: number; rates: Rate[] }
}

export function importClient(db: Db, orgId: string, input: ContractInput): { clientId: string; contractId: string } {
  for (const r of input.contract.rates) { parseMoney(r.unit_price); if (r.max_qty) parseQty(r.max_qty) }
  const clientId = randomUUID()
  const contractId = randomUUID()
  db.tx(() => {
    db.prepare('INSERT INTO clients (id, org_id, name, address, nif, rccm, email, vat_applicable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clientId, orgId, input.name, input.address ?? null, input.nif ?? null, input.rccm ?? null, input.email ?? null, input.vat_applicable ? 1 : 0, now())
    db.prepare('INSERT INTO contracts (id, org_id, client_id, reference, po_number, currency, payment_terms_days, rates, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(contractId, orgId, clientId, input.contract.reference, input.contract.po_number, input.contract.currency, input.contract.payment_terms_days, JSON.stringify(input.contract.rates), now())
  })
  return { clientId, contractId }
}

function contractRow(row: Record<string, unknown> | undefined): Contract | undefined {
  return row ? { ...(row as unknown as Contract), rates: JSON.parse(String(row.rates)) as Rate[] } : undefined
}

export function contractByPo(db: Db, orgId: string, po: string): Contract | undefined {
  return contractRow(db.prepare('SELECT * FROM contracts WHERE org_id = ? AND upper(po_number) = upper(?)').get(orgId, po.trim()) as Record<string, unknown> | undefined)
}

export function contractById(db: Db, orgId: string, id: string): Contract | undefined {
  return contractRow(db.prepare('SELECT * FROM contracts WHERE org_id = ? AND id = ?').get(orgId, id) as Record<string, unknown> | undefined)
}

export function clientById(db: Db, orgId: string, id: string): Client | undefined {
  return db.prepare('SELECT * FROM clients WHERE org_id = ? AND id = ?').get(orgId, id) as Client | undefined
}

export function listClients(db: Db, orgId: string) {
  const clients = db.prepare('SELECT * FROM clients WHERE org_id = ? ORDER BY name').all(orgId) as unknown as Client[]
  return clients.map(c => ({
    ...c,
    contracts: (db.prepare('SELECT * FROM contracts WHERE org_id = ? AND client_id = ?').all(orgId, c.id) as Record<string, unknown>[]).map(r => contractRow(r)),
  }))
}
