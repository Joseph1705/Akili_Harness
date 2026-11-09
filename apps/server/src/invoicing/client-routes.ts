/** Clients and contracts: the rate cards every invoice is priced from. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { HttpError, notFound } from '../errors.js'
import { ClientInput, ContractInput, clientById, contractById, createClient, createContract, listClients } from './clients.js'

const Id = z.object({ id: z.string().uuid() })
const duplicatePo = (po: string) => new HttpError(409, 'duplicate_po', `Le bon de commande ${po} est déjà utilisé par un autre contrat.`)
const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505'

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps

  app.get('/clients', async (request) => ({ clients: await listClients(db, orgOf(request).id) }))

  app.post('/clients', async (request) => {
    const org = orgOf(request, CAN.configure)
    const input = ClientInput.parse(request.body)
    const id = await createClient(db, org.id, input)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'client.created', 'client', id)
    return { client: await clientById(db, org.id, id) }
  })

  app.patch('/clients/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const patch = ClientInput.partial().parse(request.body)
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (!await clientById(db, org.id, id)) throw notFound('Client')
    if (keys.length) await db.run(`UPDATE clients SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`, ...keys.map(k => patch[k] ?? null), id, org.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'client.updated', 'client', id, { fields: keys })
    return { client: await clientById(db, org.id, id) }
  })

  app.post('/clients/:id/contracts', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const input = ContractInput.parse(request.body)
    if (!await clientById(db, org.id, id)) throw notFound('Client')
    let contractId: string
    try {
      contractId = await createContract(db, org.id, id, input)
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicatePo(input.po_number)
      throw error
    }
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'contract.created', 'contract', contractId)
    return { contract: await contractById(db, org.id, contractId) }
  })

  app.put('/contracts/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const input = ContractInput.parse(request.body)
    try {
      const changed = await db.run(`UPDATE contracts SET reference = ?, po_number = ?, currency = ?, payment_terms_days = ?, rates = ?
        WHERE id = ? AND org_id = ?`, input.reference, input.po_number, input.currency, input.payment_terms_days, JSON.stringify(input.rates), id, org.id)
      if (changed === 0) throw notFound('Contrat')
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicatePo(input.po_number)
      throw error
    }
    // Existing drafts keep the prices they were computed with; new reports use the new rate card.
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'contract.updated', 'contract', id)
    return { contract: await contractById(db, org.id, id) }
  })
}
