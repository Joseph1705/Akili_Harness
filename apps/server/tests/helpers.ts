import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'

export interface TestContext {
  app: FastifyInstance
  db: Db
  config: Config
  close(): Promise<void>
}

export const ORIGIN = 'http://localhost:3000'

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'akili-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    AKILI_DATA_DIR: dataDir,
    AKILI_MASTER_KEY: randomBytes(32).toString('base64'),
    AKILI_PUBLIC_ORIGIN: ORIGIN,
    AKILI_DEMO: '1',
    ...overrides,
  })
  const db = openDb(join(dataDir, 'akili.db'))
  const app = await buildApp({ config, db })
  await app.ready()
  return {
    app, db, config,
    async close() {
      await app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Request a code and log in; returns the session cookie header value. */
export async function login(t: TestContext, email: string): Promise<string> {
  const req = await t.app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { origin: ORIGIN }, payload: { email } })
  if (req.statusCode !== 200) throw new Error(`request-code ${req.statusCode} ${req.body}`)
  const code = req.json().demoCode as string
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload: { email, code } })
  if (res.statusCode !== 200) throw new Error(`verify ${res.statusCode} ${res.body}`)
  const cookie = String(res.headers['set-cookie']).split(';')[0]!
  return cookie
}

/** inject() with the session cookie and the browser Origin header. */
export function as(t: TestContext, cookie: string) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
}

/** Build a multipart/form-data body for inject(). */
export function multipart(fields: Record<string, string>, file?: { field: string; filename: string; bytes: Buffer; type?: string }) {
  const boundary = `----akili${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`))
    parts.push(file.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** Log in and create a company organization with finished onboarding. */
export async function onboardedOwner(t: TestContext, email: string, name = 'Kibala Services SARL (fictif)'): Promise<{ cookie: string; orgId: string; call: ReturnType<typeof as> }> {
  const cookie = await login(t, email)
  const call = as(t, cookie)
  const res = await call('POST', '/api/orgs', { kind: 'company', name })
  if (res.statusCode !== 200) throw new Error(`create org ${res.statusCode} ${res.body}`)
  await call('POST', '/api/orgs/current/consents', { type: 'terms', granted: true })
  await call('POST', '/api/orgs/current/consents', { type: 'privacy', granted: true })
  const done = await call('POST', '/api/orgs/current/onboarding/complete', {})
  if (done.statusCode !== 200) throw new Error(`complete ${done.statusCode} ${done.body}`)
  return { cookie, orgId: res.json().org.id, call }
}

const reportsDir = join(import.meta.dirname, '../../../fixtures/reports')

/** Owner with demo contracts, credits and an invoicing agent; `upload(name)` sends a fixture report. */
export async function readyOrg(ctx: TestContext, email = 'owner@example.cd', credits = 20) {
  const owner = await onboardedOwner(ctx, email)
  expect((await owner.call('POST', '/api/demo/load', {})).statusCode).toBe(200)
  if (credits > 0) await owner.call('POST', '/api/credits/topup', { credits, ref: 'FICTIF-PAY' })
  const agent = (await owner.call('POST', '/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })).json().agent
  const upload = async (name: string) => {
    const body = multipart({ agentId: agent.id }, { field: 'file', filename: name, bytes: readFileSync(join(reportsDir, name)) })
    return ctx.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: owner.cookie, ...body.headers }, payload: body.payload })
  }
  return { ...owner, agent, upload }
}

