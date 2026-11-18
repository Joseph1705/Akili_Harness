/**
 * Human approval of sensitive actions (DIRECTIVES §3 C/F, rule 7). An agent never sends, writes or calls a
 * sensitive tool by itself: it creates a request; a person whose role allows the action approves it, and only
 * then is it executed — once — with the approver's authority. Requests expire after 7 days.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { audit } from '../audit.js'
import { CAN, type OrgContext, type User } from '../auth/context.js'
import type { Db } from '../db.js'
import { forbidden, HttpError, notFound } from '../errors.js'
import { gmailSend, sheetsAppend } from '../connectors/google.js'
import { sendWhatsApp } from '../connectors/whatsapp.js'
import { callTool } from '../mcp/service.js'
import { addEvent } from '../sessions/events.js'

export type Permission = 'read' | 'operate' | 'validate' | 'configure'
export type ApprovalKind = 'gmail.send' | 'sheets.append' | 'whatsapp.send' | 'mcp.call'

export function allowed(role: OrgContext['role'], permission: Permission): boolean {
  return (CAN[permission] as readonly string[]).includes(role)
}

export async function requestApproval(db: Db, a: {
  orgId: string; kind: ApprovalKind; summary: string; payload: Record<string, unknown>; permission: Permission
  requestedBy: string | null; sessionId?: string | null; runId?: string | null
}): Promise<{ id: string }> {
  const id = randomUUID()
  await db.run(`INSERT INTO action_approvals (id, org_id, kind, summary, payload, permission, status, requested_by, session_id, run_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, now() + interval '7 days')`,
  id, a.orgId, a.kind, a.summary.slice(0, 500), JSON.stringify(a.payload), a.permission, a.requestedBy, a.sessionId ?? null, a.runId ?? null)
  await audit(db, { orgId: a.orgId, userId: a.requestedBy }, 'approval.requested', 'approval', id, { kind: a.kind })
  return { id }
}

type Executor = (app: FastifyInstance, orgId: string, payload: Record<string, unknown>, ctx: { approvalId: string; user: User }) => Promise<Record<string, unknown>>

const EXECUTORS: Record<ApprovalKind, Executor> = {
  'gmail.send': (app, orgId, p) => gmailSend(app, orgId, { to: String(p.to), subject: String(p.subject), body: String(p.body) }),
  'sheets.append': (app, orgId, p) => sheetsAppend(app, orgId, { spreadsheetId: String(p.spreadsheetId), range: String(p.range), values: p.values as string[][] }),
  'whatsapp.send': (app, orgId, p, ctx) => sendWhatsApp(app, orgId, String(p.conversationId), String(p.text), ctx.user.email, ctx.approvalId, typeof p.draftMessageId === 'string' ? p.draftMessageId : null),
  'mcp.call': async (app, orgId, p) => {
    const r = await callTool(app, orgId, String(p.toolId), (p.arguments ?? {}) as Record<string, unknown>)
    if (r.isError) throw new HttpError(502, 'tool_error', `L'outil a signalé une erreur : ${r.text.slice(0, 200)}`)
    return { text: r.text.slice(0, 4000) }
  },
}

export async function listApprovals(db: Db, orgId: string, status?: string) {
  await db.run("UPDATE action_approvals SET status = 'expired' WHERE org_id = ? AND status = 'pending' AND expires_at < now()", orgId)
  return db.all(`SELECT a.id, a.kind, a.summary, a.payload, a.permission, a.status, a.session_id, a.reason, a.result, a.error, a.created_at, a.decided_at, a.expires_at,
    r.email AS requested_by_email, d.email AS decided_by_email
    FROM action_approvals a LEFT JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
    WHERE a.org_id = ? AND (?::text IS NULL OR a.status = ?::text) ORDER BY a.created_at DESC LIMIT 200`, orgId, status ?? null, status ?? null)
}

export async function decideApproval(app: FastifyInstance, org: OrgContext, user: User, id: string, decision: 'approve' | 'reject', reason?: string) {
  const { db } = app.deps
  const approval = await db.tx(async tx => {
    const row = await tx.get<{ id: string; kind: ApprovalKind; permission: Permission; status: string; payload: Record<string, unknown>; session_id: string | null; expires_at: string; summary: string }>(
      'SELECT * FROM action_approvals WHERE id = ? AND org_id = ? FOR UPDATE', id, org.id)
    if (!row) throw notFound('Demande')
    if (row.status !== 'pending') throw new HttpError(409, 'already_decided', 'Cette demande a déjà été traitée.')
    if (Date.parse(row.expires_at) < Date.now()) {
      await tx.run("UPDATE action_approvals SET status = 'expired' WHERE id = ?", id)
      throw new HttpError(409, 'expired', 'Cette demande a expiré.')
    }
    // The approver must be allowed to do the action himself: an agent never exceeds the people behind it.
    if (!allowed(org.role, row.permission)) throw forbidden("Votre rôle ne permet pas d'approuver cette action.")
    await tx.run('UPDATE action_approvals SET status = ?, decided_by = ?, decided_at = now(), reason = ? WHERE id = ?',
      decision === 'approve' ? 'approved' : 'rejected', user.id, reason ?? null, id)
    return row
  })
  await audit(db, { orgId: org.id, userId: user.id }, decision === 'approve' ? 'approval.approved' : 'approval.rejected', 'approval', id, { kind: approval.kind })
  const note = async (text: string) => { if (approval.session_id) await addEvent(db, org.id, approval.session_id, 'system', { text }) }
  if (decision === 'reject') {
    if (approval.kind === 'whatsapp.send' && typeof approval.payload.draftMessageId === 'string') {
      await db.run("UPDATE whatsapp_messages SET status = 'rejected' WHERE id = ? AND org_id = ?", approval.payload.draftMessageId, org.id)
    }
    await note(`Action refusée par ${user.email} : ${approval.summary}`)
    return { status: 'rejected' as const }
  }
  try {
    const result = await EXECUTORS[approval.kind](app, org.id, approval.payload, { approvalId: id, user })
    await db.run("UPDATE action_approvals SET status = 'executed', result = ? WHERE id = ?", JSON.stringify(result), id)
    await audit(db, { orgId: org.id, userId: user.id }, 'approval.executed', 'approval', id, { kind: approval.kind })
    await note(`Action exécutée après validation de ${user.email} : ${approval.summary}`)
    return { status: 'executed' as const, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.run("UPDATE action_approvals SET status = 'failed', error = ? WHERE id = ?", message.slice(0, 500), id)
    await note(`L'action validée a échoué : ${message}`)
    return { status: 'failed' as const, error: message }
  }
}
