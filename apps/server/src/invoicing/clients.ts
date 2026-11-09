/** Clients (who the organization invoices) and their contracts with rate cards. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db.js'

export const RateInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Code : 2 à 20 caractères, lettres, chiffres et tirets.'),
  label: z.string().trim().min(2).max(200),
  unit: z.string().trim().min(1).max(30),
  unit_price: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Prix unitaire : nombre avec au plus 2 décimales, point comme séparateur.'),
  max_qty: z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/, 'Plafond : nombre avec au plus 3 décimales.').optional().or(z.literal('').transform(() => undefined)),
}).strict()
export type Rate = z.infer<typeof RateInput>

export const ContractInput = z.object({
  reference: z.string().trim().min(2).max(60),
  po_number: z.string().trim().min(2).max(40),
  currency: z.enum(['USD', 'CDF']),
  payment_terms_days: z.number().int().min(0).max(365),
  rates: z.array(RateInput).min(1).max(100).refine(r => new Set(r.map(x => x.code)).size === r.length, 'Chaque code de prestation doit être unique.'),
}).strict()
export type ContractInput = z.infer<typeof ContractInput>

export const ClientInput = z.object({
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().max(240).nullable().optional(),
  nif: z.string().trim().max(30).nullable().optional(),
  rccm: z.string().trim().max(60).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  vat_applicable: z.boolean().default(true),
}).strict()
export type ClientInput = z.infer<typeof ClientInput>

export interface Client {
  id: string; org_id: string; name: string; address: string | null; nif: string | null; rccm: string | null
  email: string | null; vat_applicable: boolean
}

export interface Contract {
  id: string; org_id: string; client_id: string; reference: string; po_number: string; currency: string
  payment_terms_days: number; rates: Rate[]
}

export async function createClient(db: Db, orgId: string, input: ClientInput): Promise<string> {
  const id = randomUUID()
  await db.run('INSERT INTO clients (id, org_id, name, address, nif, rccm, email, vat_applicable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, orgId, input.name, input.address ?? null, input.nif ?? null, input.rccm ?? null, input.email ?? null, input.vat_applicable)
  return id
}

export async function createContract(db: Db, orgId: string, clientId: string, input: ContractInput): Promise<string> {
  const id = randomUUID()
  await db.run(`INSERT INTO contracts (id, org_id, client_id, reference, po_number, currency, payment_terms_days, rates)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, orgId, clientId, input.reference, input.po_number, input.currency, input.payment_terms_days, JSON.stringify(input.rates))
  return id
}

export async function contractByPo(db: Db, orgId: string, po: string): Promise<Contract | undefined> {
  return db.get<Contract>('SELECT * FROM contracts WHERE org_id = ? AND upper(po_number) = upper(?)', orgId, po.trim())
}

export async function contractById(db: Db, orgId: string, id: string): Promise<Contract | undefined> {
  return db.get<Contract>('SELECT * FROM contracts WHERE org_id = ? AND id = ?', orgId, id)
}

export async function clientById(db: Db, orgId: string, id: string): Promise<Client | undefined> {
  return db.get<Client>('SELECT * FROM clients WHERE org_id = ? AND id = ?', orgId, id)
}

export async function listClients(db: Db, orgId: string) {
  const clients = await db.all<Client>('SELECT * FROM clients WHERE org_id = ? ORDER BY name', orgId)
  const contracts = await db.all<Contract>('SELECT * FROM contracts WHERE org_id = ? ORDER BY created_at', orgId)
  return clients.map(c => ({ ...c, contracts: contracts.filter(k => k.client_id === c.id) }))
}
