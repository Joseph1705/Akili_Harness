/** Fastify application: security headers, error handling, API routes, static web interface. */
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { HttpError } from './errors.js'
import { registerRoutes } from './routes.js'
import { createMailer, type Mailer } from './auth/mailer.js'

export interface AppDeps {
  config: Config
  db: Db
  mailer?: Mailer
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<AppDeps>
  }
}

/** Upload ceiling for reports (directive 4.11 tests use 5 MB PDFs). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export async function buildApp(input: AppDeps): Promise<FastifyInstance> {
  const deps: Required<AppDeps> = { ...input, mailer: input.mailer ?? createMailer(input.config) }
  const app = Fastify({
    logger: input.config.env === 'test' ? false : {
      level: 'info',
      // Never log cookies, codes or bodies (rule 4).
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: input.config.env === 'production',
  })
  app.decorate('deps', deps)

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        // Only over HTTPS: on a first test by IP (plain HTTP) it would break every request.
        upgradeInsecureRequests: input.config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: input.config.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
  })
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 10 } })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.code, message: error.message, ...error.detail })
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_input',
        message: 'Certains champs sont invalides.',
        fields: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const status = (error as { statusCode?: number }).statusCode
    if (status === 413 || (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: 'too_large', message: 'Fichier trop volumineux.' })
    }
    if (status && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: 'Requête invalide.' })
    }
    request.log.error(error)
    return reply.status(500).send({ error: 'internal', message: 'Erreur interne. Réessayez ou contactez le support.' })
  })

  // Liveness for Docker and Caddy: also proves the database answers.
  app.get('/api/health', async (_request, reply) => {
    try { await deps.db.get('SELECT 1'); return { ok: true } } catch { return reply.status(503).send({ ok: false }) }
  })
  await app.register(registerRoutes, { prefix: '/api' })

  const webDist = input.config.webDist
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist, index: ['index.html'], wildcard: true,
      // Hashed build assets never change; the page itself must be re-read after each deployment.
      setHeaders: (res, path) => res.setHeader('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
    })
  }
  app.setNotFoundHandler((request, reply) => {
    // Page routes get the app; a missing file (script, style, image) is a real 404, never HTML.
    const path = request.url.split('?')[0]!
    if (path.startsWith('/api/') || !webDist || request.method !== 'GET' || /\.[a-z0-9]{1,8}$/i.test(path)) {
      return reply.status(404).send({ error: 'not_found', message: 'Introuvable.' })
    }
    return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html')
  })
  return app
}
