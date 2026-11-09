/** Test data builders. Fictitious data only (rule 4). */
import { randomUUID } from 'node:crypto'
import type { Db } from '../src/db.js'

export async function createOrg(db: Db, name = 'Kibala Services SARL (fictif)', plan: 'solo' | 'entreprise' = 'entreprise'): Promise<string> {
  const id = randomUUID()
  await db.run('INSERT INTO organizations (id, kind, name, plan) VALUES (?, ?, ?, ?)', id, plan === 'solo' ? 'individual' : 'company', name, plan)
  return id
}
