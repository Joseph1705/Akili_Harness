/** Sessions (design screens A and B) and the day's activity (screen E). */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CAN, orgOf } from '../auth/context.js'
import { balance } from '../credits.js'
import { notFound } from '../errors.js'
import { addEvent, createSession } from './events.js'
import { answer, COMMANDS } from './assistant.js'

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  app.get('/sessions', async (request) => {
    const org = orgOf(request)
    const sessions = await db.all(`SELECT s.id, s.title, s.status, s.created_at, s.updated_at, a.name AS agent_name,
      (SELECT count(*) FROM document_sessions ds JOIN invoices i ON i.document_id = ds.document_id AND i.org_id = ds.org_id
        WHERE ds.session_id = s.id AND i.status = 'draft') AS waiting
      FROM chat_sessions s LEFT JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
      WHERE s.org_id = ? ORDER BY s.updated_at DESC LIMIT 30`, org.id)
    return { sessions, commands: COMMANDS }
  })

  app.post('/sessions', async (request) => {
    const org = orgOf(request, CAN.operate)
    const body = z.object({ title: z.string().trim().min(1).max(120).default('Nouvelle session'), agentId: z.string().uuid().optional() }).strict().parse(request.body)
    if (body.agentId && !await db.get('SELECT 1 FROM agents WHERE id = ? AND org_id = ?', body.agentId, org.id)) throw notFound('Agent')
    const id = await createSession(db, org.id, request.user!.id, body.title, body.agentId ?? null)
    return { session: await db.get('SELECT * FROM chat_sessions WHERE id = ?', id) }
  })

  app.get('/sessions/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const session = await db.get(`SELECT s.*, a.name AS agent_name, a.pack_id FROM chat_sessions s LEFT JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
      WHERE s.id = ? AND s.org_id = ?`, id, org.id)
    if (!session) throw notFound('Session')
    const events = await db.all('SELECT id, role, content, created_at FROM chat_events WHERE session_id = ? AND org_id = ? ORDER BY id', id, org.id)
    const documents = await db.all(`SELECT d.id, d.filename, d.status, d.error, d.invoice_id, i.number AS invoice_number, i.status AS invoice_status, i.total_cents, i.currency
      FROM document_sessions ds JOIN documents d ON d.id = ds.document_id AND d.org_id = ds.org_id
      LEFT JOIN invoices i ON i.id = d.invoice_id AND i.org_id = d.org_id WHERE ds.session_id = ? AND ds.org_id = ? ORDER BY d.created_at`, id, org.id)
    return { session, events, documents }
  })

  app.post('/sessions/:id/messages', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { text } = z.object({ text: z.string().trim().min(1, 'Message vide.').max(4000) }).strict().parse(request.body)
    if (!await db.get('SELECT 1 FROM chat_sessions WHERE id = ? AND org_id = ?', id, org.id)) throw notFound('Session')
    await addEvent(db, org.id, id, 'user', { text })
    const reply = await answer(db, config, org.id, org.plan, text)
    await addEvent(db, org.id, id, 'agent', { ...reply })
    return { reply }
  })

  app.get('/dashboard', async (request) => {
    const org = orgOf(request)
    const agents = await db.all<{ status: string; name: string }>(`SELECT a.id, a.name, a.status, a.pack_id, a.last_action_at,
      (SELECT count(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id AND d.processed_at >= current_date) AS docs_today
      FROM agents a WHERE a.org_id = ? ORDER BY a.created_at`, org.id)
    const today = (await db.get<Record<string, number>>(`SELECT
      count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'duplicate') AS duplicate,
      count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE status IN ('queued', 'processing', 'waiting_credits')) AS waiting
      FROM documents WHERE org_id = ? AND created_at >= current_date`, org.id))!
    const items = await db.all<{ checks: Array<{ status: string }>; created_at: string }>(`SELECT i.id, i.number, i.total_cents, i.currency, i.created_at, i.checks, c.name AS client_name, a.name AS agent_name
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id JOIN agents a ON a.id = i.agent_id AND a.org_id = i.org_id
      WHERE i.org_id = ? AND i.status = 'draft' ORDER BY i.created_at ASC`, org.id)
    return {
      agents: { active: agents.filter(a => a.status === 'active').length, total: agents.length, paused: agents.filter(a => a.status !== 'active').map(a => a.name), list: agents },
      documentsToday: today,
      pending: {
        count: items.length, oldest_at: items[0]?.created_at ?? null,
        items: items.slice(0, 8).map(i => ({ ...i, checks: undefined, attention: i.checks.filter(c => c.status === 'warning' || c.status === 'error').length })),
      },
      credits: await balance(db, org.id),
    }
  })
}
