/**
 * WhatsApp Business Platform, Cloud API (official, DIRECTIVES §3 D; never an unofficial library).
 * - Connection: the organization's phone number id and access token (from Meta Business Manager), checked
 *   against the Graph API before being stored (encrypted). No connection is ever pretended.
 * - Webhook: Meta's verification handshake (hub.verify_token) and signed deliveries (X-Hub-Signature-256,
 *   HMAC-SHA256 of the raw body with our app secret); messages routed to the organization by phone number id,
 *   stored once (idempotent on the WhatsApp message id).
 * - Replies: free text only inside the 24-hour customer-service window; every outgoing message is sent by a
 *   person, or approved by one when the agent drafted it (rule 7).
 */
import type { FastifyInstance } from 'fastify'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { HttpError, notFound } from '../errors.js'
import { openSecret, sealSecret } from '../security/secrets.js'
import { ConnectorError } from './google.js'

function waConfig(app: FastifyInstance) {
  const cfg = app.deps.config.connectors.whatsapp
  if (!cfg) throw new HttpError(503, 'connector_unavailable', "WhatsApp n'est pas configuré sur ce serveur (application Meta manquante).")
  return cfg
}

async function graph(app: FastifyInstance, token: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const cfg = waConfig(app)
  let res: Response
  try {
    res = await fetch(`${cfg.graphBase}/${cfg.graphVersion}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000), redirect: 'error',
    })
  } catch {
    throw new ConnectorError('WhatsApp (Meta) est injoignable. Réessayez dans quelques minutes.')
  }
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    const message = String((json.error as { message?: string } | undefined)?.message ?? '').slice(0, 200)
    throw new ConnectorError(`Meta a refusé l'opération (${res.status})${message ? ` : ${message}` : ''}.`, res.status === 401 ? 409 : 502)
  }
  return json
}

export async function connectWhatsApp(app: FastifyInstance, orgId: string, userId: string, input: { phoneNumberId: string; accessToken: string }): Promise<{ id: string; display: string }> {
  const { db, config } = app.deps
  if (!/^\d{5,30}$/.test(input.phoneNumberId)) throw new HttpError(400, 'bad_request', "Identifiant du numéro WhatsApp invalide (chiffres uniquement, visible dans Meta Business Manager).")
  const info = await graph(app, input.accessToken, `${input.phoneNumberId}?fields=display_phone_number,verified_name`)
  const display = `${String(info.verified_name ?? '').slice(0, 80)} ${String(info.display_phone_number ?? '').slice(0, 30)}`.trim() || input.phoneNumberId
  const id = randomUUID()
  try {
    await db.tx(async tx => {
      await tx.run("UPDATE connections SET status = 'revoked', secrets = NULL, updated_at = now() WHERE org_id = ? AND provider = 'whatsapp' AND status <> 'revoked'", orgId)
      await tx.run(`INSERT INTO connections (id, org_id, provider, status, account, secrets, settings, created_by) VALUES (?, ?, 'whatsapp', 'connected', ?, ?, ?, ?)`,
        id, orgId, display, sealSecret(config, orgId, `connection:${id}`, { access_token: input.accessToken }), JSON.stringify({ phone_number_id: input.phoneNumberId }), userId)
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'already_connected', 'Ce numéro WhatsApp est déjà relié à une autre organisation.')
    throw error
  }
  return { id, display }
}

export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false
  const expected = createHmac('sha256', appSecret).update(raw).digest()
  const given = Buffer.from(header.slice(7), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface InboundMessage { orgId: string; conversationId: string; messageId: string; text: string }

/** Store the messages of one webhook delivery; returns the new inbound messages. */
export async function receiveWhatsApp(app: FastifyInstance, payload: unknown): Promise<InboundMessage[]> {
  const { db } = app.deps
  const out: InboundMessage[] = []
  const entries = ((payload as { entry?: unknown[] })?.entry ?? []) as Array<{ changes?: Array<{ value?: Record<string, unknown> }> }>
  for (const entry of entries.slice(0, 50)) {
    for (const change of (entry.changes ?? []).slice(0, 50)) {
      const value = change.value ?? {}
      const phoneId = String((value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? '')
      const conn = await db.get<{ id: string; org_id: string }>(`SELECT id, org_id FROM connections WHERE provider = 'whatsapp' AND status = 'connected'
        AND settings->>'phone_number_id' = ?`, phoneId)
      if (!conn) continue
      const contacts = (value.contacts as Array<{ wa_id?: string; profile?: { name?: string } }> | undefined) ?? []
      for (const m of ((value.messages as Array<Record<string, unknown>> | undefined) ?? []).slice(0, 100)) {
        const from = String(m.from ?? '')
        const waId = String(m.id ?? '')
        if (!/^\d{5,20}$/.test(from) || !waId) continue
        const text = m.type === 'text' ? String((m.text as { body?: string } | undefined)?.body ?? '') : `[message ${String(m.type ?? 'inconnu')} non textuel]`
        const name = contacts.find(c => c.wa_id === from)?.profile?.name?.slice(0, 120) ?? null
        const conversation = (await db.get<{ id: string }>(`INSERT INTO whatsapp_conversations (id, org_id, connection_id, contact_wa_id, contact_name, last_inbound_at, last_message_at)
          VALUES (?, ?, ?, ?, ?, now(), now())
          ON CONFLICT (connection_id, contact_wa_id) DO UPDATE SET last_inbound_at = now(), last_message_at = now(),
            contact_name = COALESCE(excluded.contact_name, whatsapp_conversations.contact_name), status = 'open' RETURNING id`,
        randomUUID(), conn.org_id, conn.id, from, name))!
        const id = randomUUID()
        const inserted = await db.run(`INSERT INTO whatsapp_messages (id, org_id, conversation_id, direction, wa_message_id, body, status, author)
          VALUES (?, ?, ?, 'in', ?, ?, 'received', 'contact') ON CONFLICT (wa_message_id) DO NOTHING`, id, conn.org_id, conversation.id, waId.slice(0, 200), text.slice(0, 4096))
        if (inserted) out.push({ orgId: conn.org_id, conversationId: conversation.id, messageId: id, text })
      }
      for (const s of ((value.statuses as Array<{ id?: string; status?: string }> | undefined) ?? []).slice(0, 100)) {
        if (s.id && ['sent', 'delivered', 'read', 'failed'].includes(String(s.status))) {
          await db.run("UPDATE whatsapp_messages SET status = ? WHERE wa_message_id = ? AND org_id = ? AND direction = 'out'", s.status!, s.id, conn.org_id)
        }
      }
    }
  }
  return out
}

/** Send a text reply in a conversation (a person clicked "Envoyer", or approved the agent's draft). */
export async function sendWhatsApp(app: FastifyInstance, orgId: string, conversationId: string, text: string, author: string, approvalId: string | null = null, draftMessageId: string | null = null): Promise<{ id: string; waMessageId: string }> {
  const { db, config } = app.deps
  const conv = await db.get<{ contact_wa_id: string; connection_id: string; last_inbound_at: string | null }>(
    'SELECT contact_wa_id, connection_id, last_inbound_at FROM whatsapp_conversations WHERE id = ? AND org_id = ?', conversationId, orgId)
  if (!conv) throw notFound('Conversation')
  if (!conv.last_inbound_at || Date.now() - Date.parse(conv.last_inbound_at) > 24 * 3600_000) {
    throw new HttpError(409, 'outside_window', 'Le client n\'a pas écrit depuis plus de 24 heures : WhatsApp n\'autorise alors qu\'un modèle de message approuvé par Meta.')
  }
  const conn = await db.get<{ id: string; secrets: Buffer | null; settings: { phone_number_id: string }; status: string }>(
    'SELECT id, secrets, settings, status FROM connections WHERE id = ? AND org_id = ?', conv.connection_id, orgId)
  if (!conn || conn.status !== 'connected' || !conn.secrets) throw new HttpError(409, 'not_connected', "WhatsApp n'est plus connecté pour votre organisation.")
  const { access_token } = openSecret<{ access_token: string }>(config, orgId, `connection:${conn.id}`, conn.secrets)
  const body = text.trim().slice(0, 4096)
  if (!body) throw new HttpError(400, 'bad_request', 'Message vide.')
  const res = await graph(app, access_token, `${conn.settings.phone_number_id}/messages`, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: conv.contact_wa_id, type: 'text', text: { preview_url: false, body },
  })
  const waMessageId = String((res.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? '')
  // An approved draft becomes the sent message; otherwise a new outgoing message is recorded.
  const updated = draftMessageId ? await db.run(`UPDATE whatsapp_messages SET status = 'sent', wa_message_id = ?, body = ?, author = ?, approval_id = ?
    WHERE id = ? AND org_id = ? AND conversation_id = ? AND status = 'draft'`, waMessageId || null, body, author.slice(0, 254), approvalId, draftMessageId, orgId, conversationId) : 0
  const id = updated ? draftMessageId! : randomUUID()
  if (!updated) {
    await db.run(`INSERT INTO whatsapp_messages (id, org_id, conversation_id, direction, wa_message_id, body, status, author, approval_id)
      VALUES (?, ?, ?, 'out', ?, ?, 'sent', ?, ?)`, id, orgId, conversationId, waMessageId || null, body, author.slice(0, 254), approvalId)
  }
  await db.run('UPDATE whatsapp_conversations SET last_message_at = now() WHERE id = ?', conversationId)
  return { id, waMessageId }
}
