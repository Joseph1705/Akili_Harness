/** Versioned consents (directive 5.4). The external model consent is separate and never pre-checked. */
import { randomUUID } from 'node:crypto'
import { now, type Db } from '../db.js'

export const CONSENT_VERSIONS = {
  terms: '2026-11-demo',
  privacy: '2026-11-demo',
  external_model: '2026-11-demo',
} as const

export type ConsentType = keyof typeof CONSENT_VERSIONS

export function recordConsent(db: Db, orgId: string, userId: string, type: ConsentType, granted: boolean): void {
  db.prepare('INSERT INTO consents (id, org_id, user_id, type, version, granted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), orgId, userId, type, CONSENT_VERSIONS[type], granted ? 1 : 0, now())
}

/** Latest decision per consent type, for the current version only. */
export function consentState(db: Db, orgId: string): Record<ConsentType, boolean> {
  const state = { terms: false, privacy: false, external_model: false }
  for (const type of Object.keys(CONSENT_VERSIONS) as ConsentType[]) {
    const row = db.prepare('SELECT granted FROM consents WHERE org_id = ? AND type = ? AND version = ? ORDER BY rowid DESC LIMIT 1')
      .get(orgId, type, CONSENT_VERSIONS[type]) as { granted: number } | undefined
    state[type] = row?.granted === 1
  }
  return state
}
