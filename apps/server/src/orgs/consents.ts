/** Versioned consents (directive 5.4). The external model consent is separate and never pre-checked. */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'

export const CONSENT_VERSIONS = {
  terms: '2026-11',
  privacy: '2026-11',
  external_model: '2026-11',
} as const

export type ConsentType = keyof typeof CONSENT_VERSIONS

export async function recordConsent(db: Db, orgId: string, userId: string, type: ConsentType, granted: boolean): Promise<void> {
  await db.run('INSERT INTO consents (id, org_id, user_id, type, version, granted) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(), orgId, userId, type, CONSENT_VERSIONS[type], granted)
}

/** Latest decision per consent type, for the current version only. */
export async function consentState(db: Db, orgId: string): Promise<Record<ConsentType, boolean>> {
  const rows = await db.all<{ type: ConsentType; granted: boolean }>(`SELECT DISTINCT ON (type) type, granted FROM consents
    WHERE org_id = ? AND ((type = 'terms' AND version = ?) OR (type = 'privacy' AND version = ?) OR (type = 'external_model' AND version = ?))
    ORDER BY type, seq DESC`, orgId, CONSENT_VERSIONS.terms, CONSENT_VERSIONS.privacy, CONSENT_VERSIONS.external_model)
  const state = { terms: false, privacy: false, external_model: false }
  for (const r of rows) state[r.type] = r.granted
  return state
}
