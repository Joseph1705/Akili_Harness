/** Audit log: who did what, when, on what (directive 4.9). Details never contain document contents. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from './db.js'
import { orgOf, CAN } from './auth/context.js'

export async function audit(
  db: Db,
  who: { orgId: string | null; userId: string | null },
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.run('INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    who.orgId, who.userId, action, targetType ?? null, targetId ?? null, detail ? JSON.stringify(detail) : null)
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(request.query)
    const entries = await app.deps.db.all(`SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = ? AND (?::bigint IS NULL OR a.id < ?::bigint) ORDER BY a.id DESC LIMIT 100`, org.id, before ?? null, before ?? null)
    return { entries }
  })
}
