/** Organizations, onboarding (directive 5.2), members and roles, logo, consents. */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf, userOf, type Role } from '../auth/context.js'
import { topup } from '../credits.js'
import { badRequest, notFound } from '../errors.js'
import { getBlob, putBlob } from '../storage/blobs.js'
import { consentState, recordConsent, type ConsentType } from './consents.js'
import { LOGO_SIZES, logoAtSize, normalizeLogo } from './logo.js'

const text = (max: number) => z.string().trim().max(max)
const optionalText = (max: number) => text(max).nullable().optional()

const OrgPatch = z.object({
  name: text(160).min(2).optional(),
  sector: optionalText(120), city: optionalText(80), province: optionalText(80),
  currency: z.enum(['USD', 'CDF']).optional(), secondary_currencies: optionalText(40), team_size: optionalText(20),
  rccm: optionalText(60), id_nat: optionalText(60), nif: optionalText(30), address: optionalText(240),
  vat_status: z.enum(['yes', 'no', 'unknown']).optional(),
  accounting_software: optionalText(80), reports_channel: optionalText(80), bank_details: optionalText(240),
  data_mode: z.enum(['standard', 'souverain']).optional(),
  onboarding_step: z.number().int().min(1).max(8).optional(),
}).strict()

const ProfilePatch = z.object({
  first_name: text(80).min(1).optional(), last_name: text(80).min(1).optional(), phone: optionalText(30),
  locale: z.enum(['fr', 'en']).optional(), timezone: text(60).optional(),
}).strict()

const ROLES = ['owner', 'admin', 'operator', 'reader', 'accountant'] as const

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  const orgPayload = async (orgId: string, role: Role) => ({
    ...(await db.get('SELECT id, kind, name, plan, data_mode, onboarding_step, onboarding_done_at FROM organizations WHERE id = ?', orgId)),
    role,
  })

  app.post('/orgs', async (request) => {
    const user = userOf(request)
    const body = z.object({ kind: z.enum(['company', 'individual']), name: text(160).min(2).optional() }).strict().parse(request.body)
    if (body.kind === 'company' && !body.name) throw badRequest("Indiquez le nom de l'entreprise.")
    const id = randomUUID()
    const name = body.name ?? ([user.first_name, user.last_name].filter(Boolean).join(' ') || 'Mon activité')
    await db.tx(async tx => {
      await tx.run('INSERT INTO organizations (id, kind, name, plan, onboarding_step) VALUES (?, ?, ?, ?, 2)',
        id, body.kind, name, body.kind === 'company' ? 'entreprise' : 'solo')
      await tx.run("INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')", user.id, id)
      await tx.run('UPDATE sessions SET current_org_id = ? WHERE id = ?', id, request.sessionId!)
      if (config.signupCredits > 0) await topup(tx, id, config.signupCredits, 'BIENVENUE', null)
    })
    await audit(db, { orgId: id, userId: user.id }, 'org.created', 'organization', id, { kind: body.kind })
    return { org: await orgPayload(id, 'owner') }
  })

  app.post('/orgs/switch', async (request) => {
    const user = userOf(request)
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.body)
    const member = await db.get<{ role: Role }>('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?', user.id, orgId)
    if (!member) throw notFound('Espace')
    await db.run('UPDATE sessions SET current_org_id = ? WHERE id = ?', orgId, request.sessionId!)
    return { org: await orgPayload(orgId, member.role) }
  })

  app.patch('/me/profile', async (request) => {
    const user = userOf(request)
    const patch = ProfilePatch.parse(request.body)
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length) {
      // Column names come from the strict schema above, never from the request.
      await db.run(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => patch[k] ?? null), user.id)
    }
    return { ok: true }
  })

  app.patch('/orgs/current', async (request) => {
    const org = orgOf(request, CAN.configure)
    const patch = OrgPatch.parse(request.body)
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length) {
      await db.run(`UPDATE organizations SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => patch[k] ?? null), org.id)
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'org.updated', 'organization', org.id, { fields: keys })
    }
    return { ok: true }
  })

  app.get('/orgs/current/consents', async (request) => consentState(db, orgOf(request).id))

  app.post('/orgs/current/consents', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({ type: z.enum(['terms', 'privacy', 'external_model']), granted: z.boolean() }).strict().parse(request.body)
    await recordConsent(db, org.id, request.user!.id, body.type as ConsentType, body.granted)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'consent.recorded', 'consent', body.type, { granted: body.granted })
    return consentState(db, org.id)
  })

  app.post('/orgs/current/onboarding/complete', async (request) => {
    const org = orgOf(request, CAN.configure)
    const state = await consentState(db, org.id)
    if (!state.terms || !state.privacy) throw badRequest("Acceptez les conditions d'utilisation et la politique de confidentialité.")
    await db.run('UPDATE organizations SET onboarding_done_at = COALESCE(onboarding_done_at, now()), onboarding_step = 8 WHERE id = ?', org.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'org.onboarding_completed', 'organization', org.id)
    return { ok: true }
  })

  app.post('/orgs/current/logo', async (request) => {
    const org = orgOf(request, CAN.configure)
    const file = await request.file()
    if (!file) throw badRequest('Aucun fichier reçu.')
    const png = await normalizeLogo(await file.toBuffer())
    const blob = await putBlob(db, config, org.id, png, { filename: 'logo.png', kind: 'png' })
    await db.run('UPDATE organizations SET logo_blob_id = ? WHERE id = ?', blob.id, org.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'org.logo_updated', 'blob', blob.id)
    return { ok: true }
  })

  app.get('/orgs/current/logo', async (request, reply) => {
    const org = orgOf(request)
    const { size } = z.object({ size: z.coerce.number().int().refine(n => (LOGO_SIZES as readonly number[]).includes(n)).default(128) }).parse(request.query)
    const row = await db.get<{ logo_blob_id: string | null }>('SELECT logo_blob_id FROM organizations WHERE id = ?', org.id)
    if (!row?.logo_blob_id) throw notFound('Logo')
    const { bytes } = await getBlob(db, config, org.id, row.logo_blob_id)
    reply.header('cache-control', 'private, max-age=300').type('image/png')
    return reply.send(await logoAtSize(bytes, size))
  })

  app.get('/orgs/current/members', async (request) => {
    const org = orgOf(request)
    return {
      members: await db.all(`SELECT u.id, u.email, u.first_name, u.last_name, m.role, m.created_at FROM memberships m
        JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`, org.id),
    }
  })

  app.post('/orgs/current/members', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ROLES).exclude(['owner']) }).strict().parse(request.body)
    await db.tx(async tx => {
      await tx.run('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING', randomUUID(), body.email)
      const user = (await tx.get<{ id: string }>('SELECT id FROM users WHERE email = ?', body.email))!
      await tx.run(`INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)
        ON CONFLICT (user_id, org_id) DO UPDATE SET role = excluded.role WHERE memberships.role <> 'owner'`, user.id, org.id, body.role)
    })
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'member.invited', 'member', body.email.replace(/^(.{2}).*@/, '$1***@'), { role: body.role })
    return { ok: true }
  })
}
