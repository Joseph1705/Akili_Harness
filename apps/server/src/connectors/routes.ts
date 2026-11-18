/**
 * Connectors (DIRECTIVES §3 D): connect, authorize, manage and disconnect Google and WhatsApp; WhatsApp
 * conversations; human-initiated actions (Gmail search, export of validated invoices to Google Sheets,
 * WhatsApp replies). Webhooks prove themselves by signature.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf, type OrgContext } from '../auth/context.js'
import { HttpError, notFound } from '../errors.js'
import { formatMoney } from '../invoicing/compute.js'
import { idempotent } from '../invoicing/store.js'
import type { JobOutcome } from '../jobs.js'
import { requestApproval } from '../ai/approvals.js'
import { runAgent } from '../ai/agent.js'
import { disconnectGoogle, finishGoogle, gmailSearch, GOOGLE_SERVICES, sheetsAppend, startGoogle, type GoogleService } from './google.js'
import { connectWhatsApp, receiveWhatsApp, sendWhatsApp, verifyMetaSignature } from './whatsapp.js'

const SERVICE_OF_SCOPE = Object.fromEntries(Object.entries(GOOGLE_SERVICES).flatMap(([k, v]) => v.scopes.map(s => [s, k])))

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  app.get('/', async (request) => {
    const org = orgOf(request)
    const rows = await db.all<{ provider: string; status: string; account: string | null; scopes: string[]; last_error: string | null; updated_at: string; settings: Record<string, unknown> }>(
      "SELECT provider, status, account, scopes, last_error, updated_at, settings FROM connections WHERE org_id = ? AND status <> 'revoked'", org.id)
    const google = rows.find(r => r.provider === 'google')
    const whatsapp = rows.find(r => r.provider === 'whatsapp')
    return {
      google: {
        available: Boolean(config.connectors.google),
        connection: google ? { status: google.status, account: google.account, services: [...new Set(google.scopes.map(s => SERVICE_OF_SCOPE[s]).filter(Boolean))], last_error: google.last_error, updated_at: google.updated_at } : null,
        services: Object.entries(GOOGLE_SERVICES).map(([id, s]) => ({ id, label: s.label, available: s.available })),
      },
      whatsapp: {
        available: Boolean(config.connectors.whatsapp),
        webhook: `${config.publicOrigin}/api/webhooks/whatsapp`,
        connection: whatsapp ? { status: whatsapp.status, account: whatsapp.account, last_error: whatsapp.last_error, updated_at: whatsapp.updated_at } : null,
      },
    }
  })

  app.post('/google/start', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { services } = z.object({ services: z.array(z.enum(Object.keys(GOOGLE_SERVICES) as [GoogleService, ...GoogleService[]])).min(1).max(4) }).strict().parse(request.body)
    const url = await startGoogle(app, org.id, request.user!.id, services)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'connector.google_started', 'connector', 'google', { services })
    return { url }
  })

  /** Google sends the browser back here; the person then lands on the settings page with the outcome. */
  app.get('/google/callback', async (request, reply) => {
    const back = (params: Record<string, string>) => reply.redirect(`/parametres?${new URLSearchParams({ onglet: 'connecteurs', ...params })}`, 303)
    if (!request.user) return back({ google: 'erreur', raison: 'Connectez-vous puis recommencez.' })
    const q = z.object({ state: z.string().max(200).optional(), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }).parse(request.query)
    try {
      const { orgId, account } = await finishGoogle(app, request.user.id, q)
      await audit(db, { orgId, userId: request.user.id }, 'connector.google_connected', 'connector', 'google', { account: account.replace(/^(.{2}).*@/, '$1***@') })
      return back({ google: 'ok' })
    } catch (error) {
      return back({ google: 'erreur', raison: error instanceof HttpError ? error.message : 'Connexion impossible.' })
    }
  })

  app.delete('/google', async (request) => {
    const org = orgOf(request, CAN.configure)
    await disconnectGoogle(app, org.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'connector.google_disconnected', 'connector', 'google')
    return { ok: true }
  })

  app.get('/google/gmail', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(request.query)
    return { messages: await gmailSearch(app, org.id, q, 10) }
  })

  /** Export validated invoices to a Google Sheet: a person clicks it, so it runs now (rule 7). */
  app.post('/google/sheets/invoices', async (request) => {
    const org = orgOf(request, CAN.validate)
    const body = z.object({ spreadsheet_id: z.string().trim(), range: z.string().trim().default('Factures!A1'), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(request.body)
    return idempotent(db, org.id, request, async () => {
      const rows = await db.all<{ number: string; issue_date: string; due_date: string; client: string; currency: string; subtotal_cents: number; vat_cents: number; total_cents: number; payment_status: string }>(
        `SELECT i.number, i.issue_date, i.due_date, c.name AS client, i.currency, i.subtotal_cents, i.vat_cents, i.total_cents, i.payment_status
         FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id
         WHERE i.org_id = ? AND i.status = 'validated' AND (?::date IS NULL OR i.issue_date >= ?::date) ORDER BY i.issue_date, i.number LIMIT 500`,
        org.id, body.since ?? null, body.since ?? null)
      const values = rows.map(r => [r.number, r.issue_date, r.due_date, r.client, r.currency, formatMoney(r.subtotal_cents), formatMoney(r.vat_cents), formatMoney(r.total_cents), r.payment_status])
      const result = values.length ? await sheetsAppend(app, org.id, { spreadsheetId: body.spreadsheet_id, range: body.range, values }) : { updatedRange: null, rows: 0 }
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'connector.sheets_export', 'connector', 'google', { rows: result.rows })
      return { rows: result.rows, updatedRange: result.updatedRange }
    })
  })

  app.post('/whatsapp', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({ phone_number_id: z.string().trim(), access_token: z.string().trim().min(20).max(1000) }).strict().parse(request.body)
    const result = await connectWhatsApp(app, org.id, request.user!.id, { phoneNumberId: body.phone_number_id, accessToken: body.access_token })
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'connector.whatsapp_connected', 'connector', 'whatsapp', { account: result.display })
    return { ok: true, account: result.display }
  })

  app.delete('/whatsapp', async (request) => {
    const org = orgOf(request, CAN.configure)
    const changed = await db.run("UPDATE connections SET status = 'revoked', secrets = NULL, updated_at = now() WHERE org_id = ? AND provider = 'whatsapp' AND status <> 'revoked'", org.id)
    if (changed === 0) throw notFound('Connexion')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'connector.whatsapp_disconnected', 'connector', 'whatsapp')
    return { ok: true }
  })
}

export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps
  const Id = z.object({ id: z.string().uuid() })

  app.get('/conversations', async (request) => {
    const org = orgOf(request)
    return {
      conversations: await db.all(`SELECT c.id, c.contact_wa_id, c.contact_name, c.last_inbound_at, c.last_message_at, c.status,
        (SELECT body FROM whatsapp_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
        (SELECT count(*) FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.status = 'draft') AS drafts
        FROM whatsapp_conversations c WHERE c.org_id = ? ORDER BY c.last_message_at DESC LIMIT 100`, org.id),
    }
  })

  app.get('/conversations/:id', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const conversation = await db.get('SELECT id, contact_wa_id, contact_name, last_inbound_at, status FROM whatsapp_conversations WHERE id = ? AND org_id = ?', id, org.id)
    if (!conversation) throw notFound('Conversation')
    return {
      conversation,
      messages: await db.all('SELECT id, direction, body, status, author, approval_id, error, created_at FROM whatsapp_messages WHERE conversation_id = ? AND org_id = ? ORDER BY created_at LIMIT 500', id, org.id),
    }
  })

  /** A person writes and sends a reply. */
  app.post('/conversations/:id/messages', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = Id.parse(request.params)
    const { text } = z.object({ text: z.string().trim().min(1).max(4096) }).strict().parse(request.body)
    return idempotent(db, org.id, request, async () => {
      const sent = await sendWhatsApp(app, org.id, id, text, request.user!.email)
      await audit(db, { orgId: org.id, userId: request.user!.id }, 'whatsapp.sent', 'whatsapp', id)
      return { ok: true, id: sent.id }
    })
  })
}

/** WhatsApp webhook: Meta's verification handshake, then signed deliveries. */
export async function whatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { config, db } = app.deps
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body))

  app.get('/whatsapp', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const wa = config.connectors.whatsapp
    if (!wa) return reply.status(503).send({ error: 'webhook_not_configured' })
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === wa.verifyToken && typeof q['hub.challenge'] === 'string') {
      return reply.type('text/plain').send(q['hub.challenge'].slice(0, 200))
    }
    return reply.status(403).send({ error: 'invalid_verify_token' })
  })

  app.post('/whatsapp', async (request, reply) => {
    const wa = config.connectors.whatsapp
    if (!wa) return reply.status(503).send({ error: 'webhook_not_configured' })
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('')
    if (!verifyMetaSignature(raw, request.headers['x-hub-signature-256'] as string | undefined, wa.appSecret)) return reply.status(403).send({ error: 'invalid_signature' })
    let payload: unknown
    try { payload = JSON.parse(raw.toString('utf8')) } catch { return reply.status(400).send({ error: 'invalid_json' }) }
    const inbound = await receiveWhatsApp(app, payload)
    // Drafting a reply with the agent happens in the background (Meta expects a fast answer).
    for (const m of inbound) {
      const settings = await db.get<{ enabled: boolean; whatsapp_drafts: boolean }>('SELECT enabled, whatsapp_drafts FROM ai_settings WHERE org_id = ?', m.orgId)
      if (settings?.enabled && settings.whatsapp_drafts) {
        const { enqueue } = await import('../jobs.js')
        await enqueue(db, m.orgId, 'whatsapp_draft', m.messageId)
      }
    }
    return { ok: true }
  })
}

/** Background job: the agent drafts a reply to an inbound WhatsApp message; a person approves it before it leaves. */
export async function draftWhatsAppReply(app: FastifyInstance, orgId: string, messageId: string): Promise<JobOutcome> {
  const { db } = app.deps
  const msg = await db.get<{ conversation_id: string; body: string; contact_name: string | null; contact_wa_id: string }>(
    `SELECT m.conversation_id, m.body, c.contact_name, c.contact_wa_id FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
     WHERE m.id = ? AND m.org_id = ? AND m.direction = 'in'`, messageId, orgId)
  if (!msg) return 'done'
  // One draft awaiting a person per conversation: a sender who writes many times in a row costs one model run,
  // and the person who answers sees all the messages anyway.
  const waiting = await db.get(`SELECT 1 FROM whatsapp_messages m JOIN action_approvals a ON a.id = m.approval_id AND a.org_id = m.org_id
    WHERE m.conversation_id = ? AND m.org_id = ? AND m.direction = 'out' AND m.status = 'draft' AND a.status = 'pending' AND a.expires_at > now()`,
  msg.conversation_id, orgId)
  if (waiting) return 'done'
  const orgRow = await db.get<{ id: string; name: string; plan: 'solo' | 'entreprise' }>('SELECT id, name, plan FROM organizations WHERE id = ?', orgId)
  if (!orgRow) return 'done'
  // Least privilege: no person started this run, so the agent gets read-only tools.
  const org: OrgContext = { ...orgRow, role: 'reader' }
  const reply = await runAgent(app, {
    org, user: null, sessionId: null, agentId: null, purpose: 'whatsapp',
    text: `<message_whatsapp de="${(msg.contact_name ?? 'client').replace(/"/g, "'")}">\n${msg.body}\n</message_whatsapp>\n\nRédige une réponse courte et polie à ce message, à partir des informations disponibles. Si l'information manque, propose de transmettre la demande à un collaborateur. Réponds uniquement par le texte du message.`,
  })
  if (reply.blocked || !reply.text.trim()) return 'done'
  const draftId = randomUUID()
  await db.run(`INSERT INTO whatsapp_messages (id, org_id, conversation_id, direction, body, status, author) VALUES (?, ?, ?, 'out', ?, 'draft', 'agent')`,
    draftId, orgId, msg.conversation_id, reply.text.slice(0, 4096))
  const { id } = await requestApproval(db, {
    orgId, kind: 'whatsapp.send', summary: `Réponse WhatsApp à ${msg.contact_name ?? msg.contact_wa_id}`, permission: 'operate', requestedBy: null,
    payload: { conversationId: msg.conversation_id, text: reply.text.slice(0, 4096), draftMessageId: draftId }, runId: reply.runId ?? null,
  })
  await db.run('UPDATE whatsapp_messages SET approval_id = ? WHERE id = ?', id, draftId)
  return 'done'
}
