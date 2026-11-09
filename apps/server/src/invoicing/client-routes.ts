/** Clients and contracts, read-only in this version. */
import type { FastifyInstance } from 'fastify'
import { orgOf } from '../auth/context.js'
import { listClients } from './clients.js'

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => ({ clients: listClients(app.deps.db, orgOf(request).id) }))
}
