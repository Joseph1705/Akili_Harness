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
import { clientRoutes } from './invoicing/client-routes.js'
import { sessionRoutes } from './sessions/routes.js'
import { platformRoutes } from './platform.js'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const APP_VERSION = '0.2.0'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  // Cross-site request forgery: a state-changing request must come from our own origin.
  app.addHook('onRequest', async (request) => {
    if (UNSAFE.has(request.method) && request.headers.origin !== config.publicOrigin) {
      throw forbidden('Requête refusée (origine non autorisée).')
    }
    const token = request.cookies[SESSION_COOKIE]
    if (token) {
      const session = await resolveSession(db, config, token)
      if (session) {
        request.user = session.user
        request.sessionId = session.sessionId
        request.org = session.org
      }
    }
  })

  app.get('/public/config', async () => ({ brand: config.brand, hostingLabel: config.hostingLabel, supportEmail: config.supportEmail ?? null, version: APP_VERSION }))
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(auditRoutes, { prefix: '/audit' })
  await app.register(orgRoutes)
  await app.register(creditRoutes, { prefix: '/credits' })
  await app.register(agentRoutes)
  await app.register(documentRoutes, { prefix: '/documents' })
  await app.register(invoiceRoutes, { prefix: '/invoices' })
  await app.register(clientRoutes)
  await app.register(sessionRoutes)
  await app.register(platformRoutes, { prefix: '/platform' })
}
