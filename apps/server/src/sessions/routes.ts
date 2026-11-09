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
    const sessions = db.prepare(`SELECT s.id, s.title, s.status, s.created_at, s.updated_at, a.name AS agent_name,
      (SELECT COUNT(*) FROM document_sessions ds JOIN invoices i ON i.document_id = ds.document_id AND i.org_id = ds.org_id
        WHERE ds.session_id = s.id AND i.status = 'draft') AS waiting
      FROM chat_sessions s LEFT JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
      WHERE s.org_id = ? ORDER BY s.updated_at DESC LIMIT 30`).all(org.id)
    return { sessions, commands: COMMANDS }
  })

  app.post('/sessions', async (request) => {
    const org = orgOf(request, CAN.operate)
    const body = z.object({ title: z.string().trim().min(1).max(120).default('Nouvelle session'), agentId: z.string().uuid().optional() }).strict().parse(request.body)
    if (body.agentId && !db.prepare('SELECT 1 FROM agents WHERE id = ? AND org_id = ?').get(body.agentId, org.id)) throw notFound('Agent')
    const id = createSession(db, org.id, request.user!.id, body.title, body.agentId ?? null)
    return { session: db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) }
  })

  app.get('/sessions/:id', async (request) => {
    const org = orgOf(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const session = db.prepare(`SELECT s.*, a.name AS agent_name, a.pack_id FROM chat_sessions s LEFT JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
      WHERE s.id = ? AND s.org_id = ?`).get(id, org.id)
    if (!session) throw notFound('Session')
    const events = (db.prepare('SELECT id, role, content, created_at FROM chat_events WHERE session_id = ? AND org_id = ? ORDER BY id').all(id, org.id) as Array<{ content: string }>)
      .map(e => ({ ...e, content: JSON.parse(e.content) }))
    const documents = db.prepare(`SELECT d.id, d.filename, d.status, d.error, d.invoice_id, i.number AS invoice_number, i.status AS invoice_status, i.total_cents, i.currency
      FROM document_sessions ds JOIN documents d ON d.id = ds.document_id AND d.org_id = ds.org_id
      LEFT JOIN invoices i ON i.id = d.invoice_id AND i.org_id = d.org_id WHERE ds.session_id = ? AND ds.org_id = ? ORDER BY d.created_at`).all(id, org.id)
    return { session, events, documents }
  })

  app.post('/sessions/:id/messages', async (request) => {
    const org = orgOf(request, CAN.operate)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { text } = z.object({ text: z.string().trim().min(1, 'Message vide.').max(4000) }).strict().parse(request.body)
    if (!db.prepare('SELECT 1 FROM chat_sessions WHERE id = ? AND org_id = ?').get(id, org.id)) throw notFound('Session')
    addEvent(db, org.id, id, 'user', { text })
    const reply = answer(db, config, org.id, org.plan, text)
    addEvent(db, org.id, id, 'agent', { ...reply })
    return { reply }
  })

  app.get('/dashboard', async (request) => {
    const org = orgOf(request)
    const agents = db.prepare(`SELECT a.id, a.name, a.status, a.pack_id, a.last_action_at,
      (SELECT COUNT(*) FROM documents d WHERE d.agent_id = a.id AND d.org_id = a.org_id AND d.processed_at >= date('now')) AS docs_today
      FROM agents a WHERE a.org_id = ? ORDER BY a.created_at`).all(org.id) as Array<{ status: string; name: string }>
    const today = db.prepare(`SELECT
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicate,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status IN ('queued','processing','waiting_credits') THEN 1 ELSE 0 END) AS waiting
      FROM documents WHERE org_id = ? AND created_at >= date('now')`).get(org.id) as Record<string, number | null>
    const items = db.prepare(`SELECT i.id, i.number, i.total_cents, i.currency, i.created_at, i.checks, c.name AS client_name, a.name AS agent_name
      FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id JOIN agents a ON a.id = i.agent_id AND a.org_id = i.org_id
      WHERE i.org_id = ? AND i.status = 'draft' ORDER BY i.created_at ASC`).all(org.id) as Array<{ checks: string; created_at: string }>
    return {
      agents: { active: agents.filter(a => a.status === 'active').length, total: agents.length, paused: agents.filter(a => a.status !== 'active').map(a => a.name), list: agents },
      documentsToday: { done: today.done ?? 0, duplicate: today.duplicate ?? 0, failed: today.failed ?? 0, waiting: today.waiting ?? 0 },
      pending: {
        count: items.length, oldest_at: items[0]?.created_at ?? null,
        items: items.slice(0, 8).map(i => ({ ...i, checks: undefined, attention: (JSON.parse(i.checks) as Array<{ status: string }>).filter(c => c.status === 'warning' || c.status === 'error').length })),
      },
      credits: balance(db, org.id),
    }
  })
}
