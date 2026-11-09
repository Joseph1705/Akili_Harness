/** Test data builders. Fictitious data only (rule 4). */
import { randomUUID } from 'node:crypto'
import type { Db } from '../src/db.js'

export function createOrg(db: Db, name = 'Kibala Services SARL (fictif)', plan: 'solo' | 'entreprise' = 'entreprise'): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO organizations (id, kind, name, plan, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, plan === 'solo' ? 'individual' : 'company', name, plan, new Date().toISOString())
  return id
}
