/** Sequential numbers per organization and year, without gaps: FAC-2026-0001 (validated), P-2026-0001 (drafts). */
import type { Db } from '../db.js'

export function nextNumber(db: Db, orgId: string, year: number, prefix: 'FAC' | 'P'): string {
  return db.tx(() => {
    const key = prefix === 'FAC' ? year : -year
    const row = db.prepare('SELECT next FROM invoice_counters WHERE org_id = ? AND year = ?').get(orgId, key) as { next: number } | undefined
    const n = row?.next ?? 1
    if (row) db.prepare('UPDATE invoice_counters SET next = ? WHERE org_id = ? AND year = ?').run(n + 1, orgId, key)
    else db.prepare('INSERT INTO invoice_counters (org_id, year, next) VALUES (?, ?, ?)').run(orgId, key, n + 1)
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`
  })
}
