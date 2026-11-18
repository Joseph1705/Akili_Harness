/** All API routes, mounted under /api: origin check, session resolution, then each module under its prefix. */
import type { FastifyInstance } from 'fastify'
import { forbidden, HttpError } from './errors.js'
import { RateLimiter } from './auth/rate-limit.js'
import { authRoutes } from './auth/routes.js'
import { resolveSession, SESSION_COOKIE } from './auth/sessions.js'
import { auditRoutes } from './audit.js'
import { orgRoutes } from './orgs/routes.js'
import { creditRoutes } from './credits.js'
import { agentRoutes } from './agents/routes.js'
import { documentRoutes } from './documents/routes.js'
import { invoiceRoutes, publicInvoiceRoutes } from './invoicing/routes.js'
import { clientRoutes } from './invoicing/client-routes.js'
import { sessionRoutes } from './sessions/routes.js'
import { platformRoutes } from './platform.js'
import { billingRoutes, sasPayWebhookRoutes } from './billing/payments.js'
import { aiRoutes } from './ai/routes.js'
import { knowledgeRoutes } from './knowledge/routes.js'
import { mcpRoutes } from './mcp/routes.js'
import { connectorRoutes, whatsappRoutes, whatsappWebhookRoutes } from './connectors/routes.js'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const APP_VERSION = '0.2.0'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  // Rate limits per address (DIRECTIVES §7), on top of the stricter ones on login codes, uploads and AI.
  const limiter = new RateLimiter()
  const tooMany = () => new HttpError(429, 'rate_limited', 'Trop de requêtes. Patientez un instant puis réessayez.')

  // Cross-site request forgery: a state-changing request must come from our own origin.
  app.addHook('onRequest', async (request) => {
    // Webhooks come from providers' servers, not from a browser: they prove themselves by signature instead.
    const webhook = request.url.startsWith('/api/webhooks/')
    if (webhook) return
    if (!limiter.take(`api:${request.ip}`, 1500, 5 * 60_000)) throw tooMany()
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
    // Costly endpoints: per organization (uploads) and per person (questions to the AI).
    if (request.method === 'POST' && request.org) {
      if ((request.url === '/api/documents' || request.url === '/api/knowledge') && !limiter.take(`upload:${request.org.id}`, 120, 10 * 60_000)) throw tooMany()
      if (/^\/api\/sessions\/[0-9a-f-]{36}\/messages$/.test(request.url) && !limiter.take(`ai:${request.user!.id}`, 30, 60_000)) throw tooMany()
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
  await app.register(publicInvoiceRoutes, { prefix: '/public/invoices' })
  await app.register(clientRoutes)
  await app.register(sessionRoutes)
  await app.register(platformRoutes, { prefix: '/platform' })
  await app.register(billingRoutes, { prefix: '/billing' })
  await app.register(sasPayWebhookRoutes, { prefix: '/webhooks' })
  await app.register(whatsappWebhookRoutes, { prefix: '/webhooks' })
  await app.register(aiRoutes)
  await app.register(knowledgeRoutes, { prefix: '/knowledge' })
  await app.register(mcpRoutes, { prefix: '/mcp' })
  await app.register(connectorRoutes, { prefix: '/connectors' })
  await app.register(whatsappRoutes, { prefix: '/whatsapp' })
}
