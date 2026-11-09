/**
 * Fills a demo database with a fictitious company (rule 4), ready to present:
 * contracts, credits, an invoicing agent, three reports already processed (two drafts to validate live).
 *   node --import tsx apps/server/scripts/seed-demo.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { createSession } from '../src/auth/sessions.js'
import { loadConfig } from '../src/config.js'
import { now, openDb } from '../src/db.js'
import { FIXTURES_DIR } from '../src/demo.js'
import { drainJobs } from '../src/jobs.js'

export const DEMO_EMAIL = 'mireille.kabange@kibala.example'

const config = loadConfig({ ...process.env, AKILI_DEMO: '1' })
const db = openDb(join(config.dataDir, 'akili.db'))
const app = await buildApp({ config, db })
await app.ready()

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL)
if (existing) {
  console.log(`[seed] déjà présent : ${DEMO_EMAIL}`)
} else {
  db.prepare('INSERT INTO users (id, email, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), DEMO_EMAIL, 'Mireille', 'Kabange', now())
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL) as { id: string }
  const { token } = createSession(db, config, user.id, 'seed')
  const headers = { origin: config.publicOrigin, cookie: `sid=${token}` }
  const call = async (method: 'POST' | 'PATCH', url: string, payload: object) => {
    const res = await app.inject({ method, url, headers, payload })
    if (res.statusCode !== 200) throw new Error(`${url} ${res.statusCode} ${res.body}`)
    return res.json()
  }
  await call('POST', '/api/orgs', { kind: 'company', name: 'Kibala Services SARL' })
  await call('PATCH', '/api/orgs/current', { team_size: '21-50', currency: 'USD', accounting_software: 'Banana Accounting', reports_channel: 'E-mail' })
  for (const type of ['terms', 'privacy']) await call('POST', '/api/orgs/current/consents', { type, granted: true })
  await call('POST', '/api/orgs/current/onboarding/complete', {})
  await call('POST', '/api/demo/load', {})
  await call('POST', '/api/credits/topup', { credits: 50, ref: 'DEMO-OFFERT' })
  const { agent } = await call('POST', '/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })
  await call('POST', '/api/orgs/current/members', { email: 'comptable@cabinet-fictif.example', role: 'accountant' })

  const boundary = '----akiliseed'
  const files = ['RA-2026-10-014_Tshala_Kipushi.pdf', 'RA-2026-10-021_Kalembe_Forage.pdf', 'RA-2026-10-030_Lualaba_Services.pdf']
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="agentId"\r\n\r\n${agent.id}\r\n`),
    ...files.flatMap(f => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f}"\r\nContent-Type: application/pdf\r\n\r\n`), readFileSync(join(FIXTURES_DIR, 'reports', f)), Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ])
  const up = await app.inject({ method: 'POST', url: '/api/documents', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })
  if (up.statusCode !== 200) throw new Error(`upload ${up.statusCode} ${up.body}`)
  await drainJobs(app)
  // Validate the Lualaba invoice so the history is not empty; leave the other two to validate live.
  const lualaba = db.prepare(`SELECT i.id FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.name LIKE 'Lualaba%'`).get() as { id: string }
  const res = await app.inject({ method: 'POST', url: `/api/invoices/${lualaba.id}/validate`, headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, payload: {} })
  if (res.statusCode !== 200) throw new Error(`validate ${res.statusCode} ${res.body}`)
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_agent = 'seed'").run(now())
  console.log(`[seed] espace de démonstration prêt : ${DEMO_EMAIL}`)
}
await app.close()
db.close()
