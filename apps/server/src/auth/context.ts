/** Request context: the logged-in user, the session, and the current organization with the member's role. */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HttpError, forbidden } from '../errors.js'

export type Role = 'owner' | 'admin' | 'operator' | 'reader' | 'accountant'

export interface User {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  locale: string
  timezone: string
}

export interface OrgContext {
  id: string
  name: string
  plan: 'solo' | 'entreprise'
  role: Role
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
    sessionId?: string
    org?: OrgContext
  }
}

/** Who may do what. The accountant sees and validates but configures nothing (directive 4.3). */
export const CAN = {
  read: ['owner', 'admin', 'operator', 'reader', 'accountant'],
  operate: ['owner', 'admin', 'operator'],
  validate: ['owner', 'admin', 'operator', 'accountant'],
  configure: ['owner', 'admin'],
  billing: ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>

export function userOf(request: FastifyRequest): User {
  if (!request.user) throw new HttpError(401, 'unauthenticated', 'Connectez-vous pour continuer.')
  return request.user
}

export function orgOf(request: FastifyRequest, allowed: readonly Role[] = CAN.read): OrgContext {
  userOf(request)
  if (!request.org) throw new HttpError(409, 'onboarding_required', "Créez d'abord votre espace.")
  if (!allowed.includes(request.org.role)) throw forbidden()
  return request.org
}

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
