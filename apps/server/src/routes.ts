/** All API routes, mounted under /api: origin check, session resolution, then each module under its prefix. */
import type { FastifyInstance } from 'fastify'
import { forbidden } from './errors.js'
import { authRoutes } from './auth/routes.js'
import { resolveSession, SESSION_COOKIE } from './auth/sessions.js'
import { auditRoutes } from './audit.js'
import { orgRoutes } from './orgs/routes.js'
import { creditRoutes } from './credits.js'
import { agentRoutes } from './agents/routes.js'
import { documentRoutes } from './documents/routes.js'
import { invoiceRoutes } from './invoicing/routes.js'
import { demoRoutes } from './demo.js'
import { clientRoutes } from './invoicing/client-routes.js'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  // Cross-site request forgery: a state-changing request must come from our own origin.
  app.addHook('onRequest', async (request) => {
    if (UNSAFE.has(request.method) && request.headers.origin !== config.publicOrigin) {
      throw forbidden('Requête refusée (origine non autorisée).')
    }
    const token = request.cookies[SESSION_COOKIE]
    if (token) {
      const session = resolveSession(db, config, token)
      if (session) {
        request.user = session.user
        request.sessionId = session.sessionId
        request.org = session.org
      }
    }
  })

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(auditRoutes, { prefix: '/audit' })
  await app.register(orgRoutes)
  await app.register(creditRoutes, { prefix: '/credits' })
  await app.register(agentRoutes)
  await app.register(documentRoutes, { prefix: '/documents' })
  await app.register(invoiceRoutes, { prefix: '/invoices' })
  await app.register(clientRoutes, { prefix: '/clients' })
  await app.register(demoRoutes, { prefix: '/demo' })
}
