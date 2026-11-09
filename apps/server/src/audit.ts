/** Audit log: who did what, when, on what (directive 4.9). Details never contain document contents. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { now, type Db } from './db.js'
import { orgOf, CAN } from './auth/context.js'

export function audit(
  db: Db,
  who: { orgId: string | null; userId: string | null },
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(who.orgId, who.userId, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null, now())
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(request.query)
    const rows = app.deps.db.prepare(`SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = ? AND (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT 100`).all(org.id, before ?? null, before ?? null) as Array<{ detail: string | null }>
    return { entries: rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) }
  })
}
