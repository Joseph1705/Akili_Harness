/** Sequential numbers per organization, series and year, without gaps: FAC-2026-0001 (validated), P-2026-0001 (drafts). */
import type { Db } from '../db.js'

export async function nextNumber(db: Db, orgId: string, year: number, series: 'FAC' | 'P'): Promise<string> {
  // A single upsert is atomic: concurrent callers get distinct numbers.
  const row = await db.get<{ n: number }>(`INSERT INTO invoice_counters (org_id, series, year, next) VALUES (?, ?, ?, 2)
    ON CONFLICT (org_id, series, year) DO UPDATE SET next = invoice_counters.next + 1 RETURNING next - 1 AS n`, orgId, series, year)
  return `${series}-${year}-${String(row!.n).padStart(4, '0')}`
}
